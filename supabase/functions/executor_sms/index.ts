import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";
import { updateConversationState } from "../_shared/conversation_state.ts";
import type { Intent } from "../_shared/intent_rules.ts";

const LEASE_SECONDS = 90;

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

/**
 * 3-step SMS sender resolution with explicit fallback policy.
 * Returns action='send' with resolved sender, or action='fail' to abort.
 * Must be called BEFORE token consumption.
 */
async function resolveSmsSender(supabase: any, orgId: string, taskId: string): Promise<{
  action: "send" | "fail";
  sender: string;
  usedShared: boolean;
  orgSender: string | null;
  fallbackPolicy: string;
}> {
  const sharedSender = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

  // Step 1: Active default org channel
  const { data: activeRows } = await supabase
    .from("org_channels")
    .select("from_e164, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);

  if (activeRows?.[0]?.from_e164) {
    return { action: "send", sender: activeRows[0].from_e164, usedShared: false, orgSender: activeRows[0].from_e164, fallbackPolicy: "active" };
  }

  // Step 2: Most recent default org channel (any status) — authority row for policy
  const { data: anyRows } = await supabase
    .from("org_channels")
    .select("from_e164, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "sms")
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!anyRows || anyRows.length === 0) {
    // Brand-new org — no dedicated sender ever. Expected behavior.
    console.info(`[executor_sms] event=new_org_shared_sender org_id=${orgId} task_id=${taskId} sender=${sharedSender}`);
    return { action: "send", sender: sharedSender, usedShared: true, orgSender: null, fallbackPolicy: "new_org" };
  }

  // Step 3: Apply fallback policy
  const orgSender = anyRows[0].from_e164 ?? null;
  const policy = anyRows[0].fallback_policy ?? "allow_shared";

  if (policy === "fail_task") {
    console.error(`[executor_sms] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=sms original_sender=${orgSender} fallback_sender=${sharedSender} policy=fail_task reason=dedicated_channel_inactive`);
    return { action: "fail", sender: sharedSender, usedShared: true, orgSender, fallbackPolicy: "fail_task" };
  }

  // allow_shared or admin_override — use shared sender
  if (policy === "admin_override") {
    console.error(`[executor_sms] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=sms original_sender=${orgSender} fallback_sender=${sharedSender} policy=admin_override reason=dedicated_channel_inactive`);
  } else {
    console.warn(`[executor_sms] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=sms original_sender=${orgSender} fallback_sender=${sharedSender} policy=${policy} reason=dedicated_channel_inactive`);
  }

  return { action: "send", sender: sharedSender, usedShared: true, orgSender, fallbackPolicy: policy };
}

async function writeFallbackAuditEvent(supabase: any, args: {
  orgId: string; taskId: string; channel: string;
  orgSender: string | null; usedSender: string; fallbackPolicy: string;
}) {
  const { error: auditErr } = await supabase.from("audit_events").insert({
    org_id: args.orgId,
    actor_type: "system",
    actor_id: null,
    object_type: "execution_task",
    object_id: args.taskId,
    action: "channel_fallback_triggered",
    reason: args.fallbackPolicy,
    before_state: { org_sender: args.orgSender, channel: args.channel },
    after_state: { used_sender: args.usedSender, fallback_policy: args.fallbackPolicy, shared: true },
  });
  if (auditErr) console.error("[executor_sms] audit_event insert failed:", auditErr.message);
}

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const task_id = body?.task_id as string | undefined;
  const worker_id = body?.worker_id as string | undefined;

  if (!task_id) {
    return new Response(JSON.stringify({ error: "task_id required" }), { status: 400 });
  }

  // Top-level safety net: capture any unhandled throw, write to last_error, return 500
  // so we NEVER get a silent "Internal Server Error" with last_error=null.
  let supabase: any;
  try {
    supabase = getServiceSupabaseClient();
    return await runExecutor(supabase, task_id, worker_id);
  } catch (topErr) {
    const errMsg = `UNHANDLED_EXECUTOR_CRASH: ${String(topErr)}`;
    console.error(`[executor_sms] ${errMsg}`);
    if (supabase) {
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: errMsg.slice(0, 2000),
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);
    }
    return new Response(errMsg, { status: 500 });
  }
});

async function runExecutor(supabase: any, task_id: string, worker_id: string | undefined): Promise<Response> {

  // 0) Fetch task + lead
  const { data: task, error } = await supabase
    .from("execution_tasks")
    .select("*, leads(name, phone)")
    .eq("id", task_id)
    .single();

  if (error || !task) {
    return new Response(JSON.stringify({ error: "Task not found" }), { status: 404 });
  }

  // 0.5) Lead phone required — fail early to prevent unhandled crash at Twilio step
  if (!task.leads?.phone) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "MISSING_LEAD_PHONE: leads join returned null or phone is empty",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Missing lead phone number", { status: 400 });
  }

  // 1) Accept only pending/running
  if (!["pending", "running"].includes(task.status)) {
    return new Response("Task already processed", { status: 200 });
  }

  // 1.4) Platform kill switch (TERMINAL) — checked before org-level
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "sms");
  if (!platformGate.allow) return platformGate.response;

  // 1.5) Kill-switch wins over everything (TERMINAL) — unified helper
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 1.6) Cancellation gate (TERMINAL) — blocks immediately if org is cancelled
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 2) Lease enforcement
  if (worker_id) {
    if (task.status !== "running" || task.locked_by !== worker_id) {
      return new Response("Task not leased to this worker", { status: 200 });
    }
  } else {
    if (task.status === "pending") {
      const leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("execution_tasks")
        .update({ status: "running", locked_by: "manual", locked_until: leaseUntil })
        .eq("id", task_id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (claimErr || !claimed) {
        return new Response("Task already claimed", { status: 200 });
      }
    }
  }

  // 3) actor_user_id required
  if (!task.actor_user_id) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "MISSING_ACTOR_USER_ID",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Missing actor_user_id", { status: 500 });
  }

  // 3.5) Rate limit gate — BEFORE token consumption and before provider send
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "sms");
  if (!rlGate.allow) return rlGate.response;

  // 3.6) DNC / terminal lead guard — application-layer second check on top of SQL-level gate.
  // Fail-closed: if the RPC itself errors, abort execution rather than risk a DNC send.
  const { data: smsTerm, error: smsTermErr } = await supabase.rpc("is_lead_terminal", {
    p_org_id: task.org_id,
    p_lead_id: task.lead_id,
  });
  if (smsTermErr) {
    console.error(JSON.stringify({ event: "sms_terminal_check_failed", task_id, lead_id: task.lead_id, error: smsTermErr.message }));
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TERMINAL_CHECK_FAILED: ${smsTermErr.message}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Terminal check failed", { status: 500 });
  }
  if (smsTerm?.[0]?.is_terminal) {
    console.warn(JSON.stringify({ event: "sms_lead_terminal_skip", task_id, lead_id: task.lead_id, reason: smsTerm[0].reason }));
    await supabase.from("execution_tasks").update({
      status: "skipped_terminal",
      last_error: smsTerm[0].reason,
      executed_at: new Date().toISOString(),
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Lead terminal, task skipped", { status: 200 });
  }

  // 4) Resolve SMS sender (BEFORE token consumption — fail_task aborts cleanly)
  const senderRes = await resolveSmsSender(supabase, task.org_id, task_id);

  if (senderRes.action === "fail") {
    await writeFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id, channel: "sms",
      orgSender: senderRes.orgSender, usedSender: senderRes.sender, fallbackPolicy: "fail_task",
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "CHANNEL_FALLBACK_POLICY_FAIL_TASK: dedicated SMS sender inactive",
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Sender fallback policy: fail_task", { status: 200 });
  }

  const TWILIO_FROM = senderRes.sender;

  // Write fallback audit event if shared sender was selected (not brand-new org)
  if (senderRes.usedShared && senderRes.orgSender !== null) {
    await writeFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id, channel: "sms",
      orgSender: senderRes.orgSender, usedSender: TWILIO_FROM, fallbackPolicy: senderRes.fallbackPolicy,
    });
  }

  // Validate Twilio credentials BEFORE token debit — fail_task cleanly if missing config.
  // This prevents users being billed for sends that cannot succeed due to misconfiguration.
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "TWILIO_CREDENTIALS_MISSING",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Twilio credentials missing", { status: 500 });
  }

  // Resolve intent early so it's available in both force_content and AI paths.
  const effectiveIntent = task.metadata?.intent_trace ?? task.metadata?.intent ?? "ambiguous";

  // Normalise to a valid Intent; unmapped values fall back to "ambiguous".
  const VALID_INTENTS = new Set<string>([
    "request_callback","request_meeting","request_pricing_details",
    "clarification_business","qualification_answer","objection_soft",
    "objection_hard","affirmative","negative","not_interested",
    "unsubscribe","off_topic","ambiguous",
  ]);
  const safeIntent = (VALID_INTENTS.has(effectiveIntent) ? effectiveIntent : "ambiguous") as Intent;

  // 5) Generate message — skip AI if force_content is set (human takeover)
  let messageBody: string;
  if (task.metadata?.force_content) {
    messageBody = safeString(task.metadata.force_content);
    console.log(`[executor_sms] force_content bypass for task ${task_id}`);
  } else {
    // Load most recent inbound message; if none, this is initial outreach
    const { data: latestInbound } = await supabase
      .from("interactions")
      .select("content")
      .eq("lead_id", task.lead_id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const brainResult = await generateMessage(supabase, {
      task_id,
      org_id: task.org_id,
      lead: { id: task.lead_id, name: task.leads?.name },
      channel: "sms",
      intent: safeIntent,
      user_query: latestInbound?.content ?? undefined,
    });

    if (brainResult.error || !brainResult.content) {
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: safeString(brainResult.error ?? "AI_GENERATION_FAILED"),
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);

      return new Response("AI failed", { status: 500 });
    }

    messageBody = brainResult.content;
  }

  // 6) Token consumption
  const { data: consumeRes, error: consumeErr } = await supabase.rpc("consume_tokens_v1", {
    p_org_id: task.org_id,
    p_scope: "user",
    p_user_id: task.actor_user_id,
    p_token_key: "sentinel.sms",
    p_amount: 1,
    p_idempotency_key: task_id,
    p_metadata: {
      channel: "sms",
      provider: "twilio",
      lead_id: task.lead_id,
      plan_id: task.plan_id,
    },
  });

  if (consumeErr) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TOKEN_RPC_FAILED: ${consumeErr.message}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Token debit RPC failed", { status: 500 });
  }

  if (!consumeRes || consumeRes.status !== "ok") {
    const reason = consumeRes?.reason ?? "TOKEN_CONSUME_DECLINED";
    await supabase.from("execution_tasks").update({
      status: "paused_insufficient_funds",
      last_error: `TOKEN_CONSUME_DECLINED: ${reason}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Insufficient tokens", { status: 402 });
  }

  // 6.5) Log delivery attempt (pre-send) — idempotency guard via UNIQUE(task_id, attempt_number)
  const attemptNumber = task.attempt ?? 1;

  const { data: deliveryAttempt, error: daInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "sms",
      provider: "twilio",
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { from: TWILIO_FROM, to: task.leads?.phone },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (daInsertErr?.code === "23505") {
    console.log(`[executor_sms] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  // Non-23505 insert error — treat delivery_attempt as mandatory precondition.
  // Do NOT call provider without an idempotency record. Refund and abort.
  if (daInsertErr) {
    console.error(JSON.stringify({
      event: "sms_delivery_attempt_insert_failed",
      task_id,
      error_code: daInsertErr.code,
      error_message: daInsertErr.message,
    }));
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "sentinel.sms", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:da_insert_failed`,
      p_metadata: { phase: "refund", reason: "delivery_attempt_insert_failed", task_id },
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `DELIVERY_ATTEMPT_INSERT_FAILED:${daInsertErr.code}:${daInsertErr.message}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id).in("status", ["running", "pending"]);
    return new Response("Delivery attempt insert failed", { status: 500 });
  }

  const deliveryAttemptId = deliveryAttempt?.id;

  // 7) Twilio send
  const toPhone = task.leads?.phone ?? null;
  if (!toPhone) {
    // Refund: no send occurred. Phone was missing at send time (guard didn't catch it earlier).
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "sentinel.sms", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:missing_phone`,
      p_metadata: { phase: "refund", reason: "missing_lead_phone_at_send", task_id },
    });
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "MISSING_LEAD_PHONE", error_message: "Lead phone number was null at send step" }).eq("id", deliveryAttemptId);
    }
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "MISSING_LEAD_PHONE_AT_SEND",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Missing lead phone at send step", { status: 400 });
  }

  const authHeader = `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`;
  const twilioParams = new URLSearchParams();
  twilioParams.append("To", toPhone);
  twilioParams.append("From", TWILIO_FROM);
  twilioParams.append("Body", messageBody);

  console.log(`[executor_sms] Calling Twilio: to=${toPhone} from=${TWILIO_FROM} task=${task_id}`);

  let twilioRespStatus = 0;
  let twilioJson: any;
  try {
    const twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: twilioParams,
      }
    );
    twilioRespStatus = twilioResp.status;
    const rawBody = await twilioResp.text();
    console.log(`[executor_sms] Twilio response: status=${twilioRespStatus} body=${rawBody.slice(0, 300)}`);

    if (!twilioResp.ok) {
      // Twilio rejected the request — no message was sent. Refund the token.
      await supabase.rpc("grant_tokens_core_v1", {
        p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
        p_token_key: "sentinel.sms", p_amount: 1,
        p_idempotency_key: `refund:${task_id}:twilio_failed`,
        p_metadata: { phase: "refund", reason: "twilio_provider_error", status: twilioRespStatus, task_id },
      });
      if (deliveryAttemptId) {
        await supabase.from("delivery_attempts").update({ status: "failed", error_code: "TWILIO_FAILED", error_message: rawBody.slice(0, 500) }).eq("id", deliveryAttemptId);
      }
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: `TWILIO_FAILED(${twilioRespStatus}): ${rawBody.slice(0, 800)}`,
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);
      return new Response("Twilio failed", { status: 500 });
    }

    try {
      twilioJson = JSON.parse(rawBody);
    } catch (parseErr) {
      // Twilio returned HTTP 2xx — the message was accepted and sent by Twilio.
      // We simply failed to parse the response JSON (no SID available).
      // Correct action: treat as successful send with unknown SID.
      //   - Do NOT refund: the token debit is correct (message was delivered).
      //   - Do NOT fail the task: that would trigger a retry causing a duplicate send.
      // The missing SID is an observability gap, not a billing or delivery failure.
      console.error(JSON.stringify({
        event: "sms_twilio_response_parse_failed_but_2xx",
        task_id,
        twilio_http_status: twilioRespStatus,
        raw_body_snippet: rawBody.slice(0, 200),
        note: "Message was sent (Twilio 2xx). SID not available due to parse error.",
      }));
      if (deliveryAttemptId) {
        await supabase.from("delivery_attempts").update({
          status: "sent",
          provider_message_id: null,
          sent_at: new Date().toISOString(),
          error_message: `SID_UNAVAILABLE:JSON_PARSE_ERROR:${rawBody.slice(0, 200)}`,
        }).eq("id", deliveryAttemptId);
      }
      // Fall through: twilioJson remains undefined. The finalize block below
      // uses twilioJson.sid — guard it with nullish coalescing at finalize.
      twilioJson = { sid: null };
    }
  } catch (networkErr) {
    // Network error: Twilio was never reached — no message sent. Refund the token.
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "sentinel.sms", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:network_error`,
      p_metadata: { phase: "refund", reason: "twilio_network_error", task_id },
    });
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "NETWORK_ERROR", error_message: String(networkErr) }).eq("id", deliveryAttemptId);
    }
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TWILIO_NETWORK_ERROR: ${String(networkErr)}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Network error reaching Twilio", { status: 500 });
  }

  // Update delivery_attempt to "sent"
  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: twilioJson.sid,
      sent_at: new Date().toISOString(),
    }).eq("id", deliveryAttemptId);
  } else {
    // Task 5: consistency guard — delivery_attempt should always exist here.
    // If it's missing, log a structured error for monitoring.
    console.error(JSON.stringify({
      event: "sms_delivery_attempt_missing_at_finalize",
      task_id,
      attempt_number: attemptNumber,
      twilio_sid: twilioJson.sid,
    }));
  }

  // 8) Finalize.
  //
  // Task 5+6 completion: task status MUST derive from delivery_attempts outcome.
  // Before marking succeeded, verify the delivery_attempt is actually 'sent'.
  // If it's in any other state, something went wrong — fail the task instead of
  // marking it succeeded, which would corrupt reporting.
  if (deliveryAttemptId) {
    const { data: daCheck } = await supabase
      .from("delivery_attempts")
      .select("status")
      .eq("id", deliveryAttemptId)
      .maybeSingle();

    if (daCheck?.status !== "sent") {
      console.error(JSON.stringify({
        event: "sms_task_success_blocked_delivery_not_sent",
        task_id,
        delivery_attempt_id: deliveryAttemptId,
        delivery_attempt_status: daCheck?.status ?? "unknown",
        twilio_sid: twilioJson.sid,
      }));
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: `DELIVERY_STATUS_MISMATCH:expected_sent_got_${daCheck?.status ?? "unknown"}`,
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id).in("status", ["running", "pending"]);
      return new Response("Delivery status mismatch", { status: 500 });
    }
  }

  // Guard on status IN ('running','pending') so a dispatcher that timed out and
  // re-queued this task doesn't end up with two succeeded writes.
  const { data: finalizedTask } = await supabase
    .from("execution_tasks")
    .update({
      status: "succeeded",
      executed_at: new Date().toISOString(),
      provider: "twilio",
      provider_id: twilioJson.sid,
      locked_by: null,
      locked_until: null,
    })
    .eq("id", task_id)
    .in("status", ["running", "pending"])
    .select("id")
    .maybeSingle();

  if (!finalizedTask) {
    // Task was moved to a terminal state by another worker before we got here.
    // The message was already sent — log this so it can be investigated.
    console.warn(JSON.stringify({
      event: "sms_finalize_noop_task_moved",
      task_id,
      twilio_sid: twilioJson.sid,
    }));
  }

  // Log outbound interaction so AI has conversation history on next inbound
  await supabase.from("interactions").insert({
    org_id: task.org_id,
    lead_id: task.lead_id,
    type: "sms",
    direction: "outbound",
    content: messageBody,
    metadata: { task_id, sid: twilioJson.sid },
  }).then(undefined, (e: any) => console.error("[executor_sms] outbound interaction log failed:", e));

  // Task 7: persist conversation state so memory_json is actually populated.
  // Best-effort — failure here must never block task completion.
  // source="outbound": preserves stage, only writes last_outbound_intent metadata.
  // Stage transitions must be driven by inbound customer signals only.
  await updateConversationState(supabase, task.lead_id, task.org_id, safeIntent, "", "outbound")
    .then(undefined, (e: any) => console.error("[executor_sms] conversation_state update failed:", e));

  return new Response(JSON.stringify({ success: true, sid: twilioJson.sid }), { status: 200 });
}
