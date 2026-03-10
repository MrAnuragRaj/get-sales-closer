import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";

const LEASE_SECONDS = 90;

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

/**
 * 3-step WhatsApp sender resolution with explicit fallback policy.
 * Called AFTER capability gate (which already handles whatsapp_enabled=false).
 * Must be called BEFORE token consumption.
 */
async function resolveWaSender(supabase: any, orgId: string, taskId: string): Promise<{
  action: "send" | "fail";
  sender: string;
  usedShared: boolean;
  orgSender: string | null;
  fallbackPolicy: string;
}> {
  const sharedSender = Deno.env.get("TWILIO_WA_FROM_NUMBER") ?? "";

  // Step 1: Active default org WhatsApp channel
  const { data: activeRows } = await supabase
    .from("org_channels")
    .select("from_e164, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "whatsapp")
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);

  if (activeRows?.[0]?.from_e164) {
    return { action: "send", sender: activeRows[0].from_e164, usedShared: false, orgSender: activeRows[0].from_e164, fallbackPolicy: "active" };
  }

  // Step 2: Most recent default org WA channel (any status) — authority row
  const { data: anyRows } = await supabase
    .from("org_channels")
    .select("from_e164, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "whatsapp")
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!anyRows || anyRows.length === 0) {
    // Brand-new org — no dedicated WA sender ever.
    console.info(`[executor_whatsapp] event=new_org_shared_sender org_id=${orgId} task_id=${taskId} sender=${sharedSender}`);
    return { action: "send", sender: sharedSender, usedShared: true, orgSender: null, fallbackPolicy: "new_org" };
  }

  // Step 3: Apply fallback policy
  const orgSender = anyRows[0].from_e164 ?? null;
  const policy = anyRows[0].fallback_policy ?? "allow_shared";

  if (policy === "fail_task") {
    console.error(`[executor_whatsapp] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=whatsapp original_sender=${orgSender} fallback_sender=${sharedSender} policy=fail_task reason=dedicated_channel_inactive`);
    return { action: "fail", sender: sharedSender, usedShared: true, orgSender, fallbackPolicy: "fail_task" };
  }

  if (policy === "admin_override") {
    console.error(`[executor_whatsapp] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=whatsapp original_sender=${orgSender} fallback_sender=${sharedSender} policy=admin_override reason=dedicated_channel_inactive`);
  } else {
    console.warn(`[executor_whatsapp] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=whatsapp original_sender=${orgSender} fallback_sender=${sharedSender} policy=${policy} reason=dedicated_channel_inactive`);
  }

  return { action: "send", sender: sharedSender, usedShared: true, orgSender, fallbackPolicy: policy };
}

async function writeWaFallbackAuditEvent(supabase: any, args: {
  orgId: string; taskId: string;
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
    before_state: { org_sender: args.orgSender, channel: "whatsapp" },
    after_state: { used_sender: args.usedSender, fallback_policy: args.fallbackPolicy, shared: true },
  });
  if (auditErr) console.error("[executor_whatsapp] audit_event insert failed:", auditErr);
}

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const task_id = body?.task_id as string | undefined;
  const worker_id = body?.worker_id as string | undefined;

  if (!task_id) {
    return new Response(JSON.stringify({ error: "task_id required" }), { status: 400 });
  }

  const supabase = getServiceSupabaseClient();

  // 0) Fetch task + lead
  const { data: task, error } = await supabase
    .from("execution_tasks")
    .select("*, leads(name, phone)")
    .eq("id", task_id)
    .single();

  if (error || !task) {
    return new Response(JSON.stringify({ error: "Task not found" }), { status: 404 });
  }

  // 1) Accept only pending/running
  if (!["pending", "running"].includes(task.status)) {
    return new Response("Task already processed", { status: 200 });
  }

  // 1.4) Platform kill switch (TERMINAL) — checked before org-level
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "whatsapp");
  if (!platformGate.allow) return platformGate.response;

  // 1.5) Kill-switch gate (TERMINAL)
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 1.6) Cancellation gate (TERMINAL)
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 1.7) WhatsApp capability check
  const { data: capability } = await supabase
    .from("org_channel_capabilities")
    .select("whatsapp_enabled, sms_enabled")
    .eq("org_id", task.org_id)
    .maybeSingle();

  if (!capability?.whatsapp_enabled) {
    // Check routing policy — fallback to SMS if allowed
    const { data: policy } = await supabase
      .from("message_routing_policies")
      .select("whatsapp_fallback_to_sms")
      .eq("org_id", task.org_id)
      .maybeSingle();

    if (policy?.whatsapp_fallback_to_sms && capability?.sms_enabled) {
      console.log(`[executor_whatsapp] WhatsApp not enabled for org ${task.org_id}. Routing policy allows SMS fallback. Delegating to executor_sms.`);

      // Rewrite task channel to sms and hand off — update channel + metadata
      await supabase.from("execution_tasks").update({
        channel: "sms",
        metadata: { ...(task.metadata ?? {}), wa_fallback_reason: "whatsapp_not_enabled" },
      }).eq("id", task_id);

      // Invoke executor_sms synchronously
      const { error: delegateErr } = await supabase.functions.invoke("executor_sms", {
        body: { task_id, worker_id },
      });

      if (delegateErr) {
        console.error("[executor_whatsapp] SMS fallback invocation failed:", delegateErr);
        return new Response("SMS fallback failed", { status: 500 });
      }

      return new Response(JSON.stringify({ success: true, fallback: "sms" }), { status: 200 });
    }

    // No fallback allowed — fail the task
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "WA_NOT_ENABLED_NO_FALLBACK",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("WhatsApp not enabled for this org and SMS fallback is disallowed", { status: 400 });
  }

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
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "whatsapp");
  if (!rlGate.allow) return rlGate.response;

  // 4) Resolve WhatsApp sender with explicit fallback policy (BEFORE token consumption)
  const senderRes = await resolveWaSender(supabase, task.org_id, task_id);

  if (senderRes.action === "fail") {
    await writeWaFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgSender: senderRes.orgSender, usedSender: senderRes.sender, fallbackPolicy: "fail_task",
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "CHANNEL_FALLBACK_POLICY_FAIL_TASK: dedicated WhatsApp sender inactive",
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Sender fallback policy: fail_task", { status: 200 });
  }

  if (!senderRes.sender) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "NO_WA_FROM_NUMBER: no shared sender configured (set TWILIO_WA_FROM_NUMBER)",
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("No WhatsApp sender number configured", { status: 500 });
  }

  const WA_FROM = senderRes.sender;

  // Write fallback audit event if shared sender was selected (not brand-new org)
  if (senderRes.usedShared && senderRes.orgSender !== null) {
    await writeWaFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgSender: senderRes.orgSender, usedSender: WA_FROM, fallbackPolicy: senderRes.fallbackPolicy,
    });
  }

  // 5) Generate message
  let messageBody: string;
  if (task.metadata?.force_content) {
    messageBody = safeString(task.metadata.force_content);
    console.log(`[executor_whatsapp] force_content bypass for task ${task_id}`);
  } else {
    // Route through widget_inbound (same AI as chat.html) — no auditor false-positives,
    // same persona/KB, explicit history management.
    const { data: historyRows } = await supabase
      .from("interactions")
      .select("content, direction")
      .eq("lead_id", task.lead_id)
      .in("direction", ["inbound", "outbound"])
      .order("created_at", { ascending: false })
      .limit(12);

    const allTurns: Array<{ role: "user" | "assistant"; content: string }> =
      (historyRows ?? []).reverse().map((h: any) => ({
        role: h.direction === "outbound" ? "assistant" : "user",
        content: String(h.content ?? ""),
      }));

    const lastUserIdx = allTurns.map(h => h.role).lastIndexOf("user");
    const userMessage = lastUserIdx >= 0 ? allTurns[lastUserIdx].content : "Hello";
    const history = lastUserIdx >= 0 ? allTurns.slice(0, lastUserIdx) : [];

    console.log(`[executor_whatsapp] widget_inbound call: task=${task_id} turns=${allTurns.length} msg="${userMessage.slice(0, 80)}"`);

    const { data: widgetData, error: widgetErr } = await supabase.functions.invoke("widget_inbound", {
      body: {
        org_id: task.org_id,
        session_id: task.lead_id,
        message: userMessage,
        history,
      },
    });

    if (widgetErr || !widgetData?.reply) {
      console.error(`[executor_whatsapp] widget_inbound failed: task=${task_id}`, widgetErr ?? "no reply");
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: `WIDGET_INBOUND_FAILED: ${safeString(widgetErr ?? "no reply returned")}`,
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);
      return new Response("AI generation failed", { status: 200 });
    }

    messageBody = widgetData.reply;
    console.log(`[executor_whatsapp] widget reply: task=${task_id} preview="${messageBody.slice(0, 100)}"`);
  }

  // 6) Token consumption (wa_msg, 1 token per message)
  const { data: consumeRes, error: consumeErr } = await supabase.rpc("consume_tokens_v1", {
    p_org_id: task.org_id,
    p_scope: "user",
    p_user_id: task.actor_user_id,
    p_token_key: "wa_msg",
    p_amount: 1,
    p_idempotency_key: task_id,
    p_metadata: {
      channel: "whatsapp",
      provider: "twilio_wa",
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

    return new Response("Insufficient wa_msg tokens", { status: 402 });
  }

  // 7) Log delivery attempt (pre-send) — idempotency guard via UNIQUE(task_id, attempt_number)
  const toPhone = task.leads?.phone?.replace(/^\+?/, "+");
  const attemptNumber = task.attempt ?? 1;
  const { data: deliveryAttempt, error: daInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "whatsapp",
      provider: "twilio_wa",
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { wa_from: WA_FROM, wa_to: `whatsapp:${toPhone}` },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (daInsertErr?.code === "23505") {
    console.log(`[executor_whatsapp] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  const deliveryAttemptId = deliveryAttempt?.id;

  // 8) Twilio WhatsApp send
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const authHeader = `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`;

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${toPhone}`);
  params.append("From", `whatsapp:${WA_FROM}`);
  params.append("Body", messageBody);

  // StatusCallback: explicitly set to our webhook so Twilio delivery receipts work,
  // and to override any misconfigured sandbox StatusCallback URL (error 21609).
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  if (supabaseUrl) {
    params.append("StatusCallback", `${supabaseUrl}/functions/v1/webhook_inbound?source=twilio`);
  }

  let twilioResp: Response;
  try {
    twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      }
    );
  } catch (networkErr) {
    const errMsg = `TWILIO_WA_NETWORK_ERROR: ${String(networkErr)}`;

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: "NETWORK_ERROR",
        error_message: String(networkErr),
      }).eq("id", deliveryAttemptId);
    }

    // Refund token on failure
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_token_key: "wa_msg",
      p_amount: 1,
      p_idempotency_key: `refund:${task_id}`,
      p_reason: "executor_whatsapp_network_error",
    });

    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: errMsg,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Network error reaching Twilio", { status: 500 });
  }

  if (!twilioResp.ok) {
    const errorText = await twilioResp.text();
    let errorCode = "TWILIO_WA_FAILED";
    try {
      const errJson = JSON.parse(errorText);
      errorCode = `TWILIO_${errJson.code ?? twilioResp.status}`;
    } catch { /* ignore */ }

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: errorCode,
        error_message: errorText.slice(0, 500),
      }).eq("id", deliveryAttemptId);
    }

    // Refund token on provider failure
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_token_key: "wa_msg",
      p_amount: 1,
      p_idempotency_key: `refund:${task_id}`,
      p_reason: "executor_whatsapp_provider_error",
    });

    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `${errorCode}: ${errorText.slice(0, 300)}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Twilio WhatsApp send failed", { status: 500 });
  }

  const twilioJson = await twilioResp.json();
  const providerMessageId: string = twilioJson.sid;

  // 9) Update delivery_attempt to "sent"
  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: providerMessageId,
    }).eq("id", deliveryAttemptId);
  }

  // 10) Finalize task
  await supabase.from("execution_tasks").update({
    status: "succeeded",
    executed_at: new Date().toISOString(),
    provider: "twilio_wa",
    provider_id: providerMessageId,
    locked_by: null,
    locked_until: null,
  }).eq("id", task_id);

  // Log outbound interaction so AI has conversation history on next inbound
  await supabase.from("interactions").insert({
    org_id: task.org_id,
    lead_id: task.lead_id,
    type: "whatsapp",
    direction: "outbound",
    content: messageBody,
    metadata: { task_id, provider_message_id: providerMessageId },
  }).then(undefined, (e: any) => console.error("[executor_whatsapp] outbound interaction log failed:", e));

  console.log(`[executor_whatsapp] Sent WA message ${providerMessageId} for task ${task_id}`);

  return new Response(JSON.stringify({ success: true, sid: providerMessageId }), { status: 200 });
});
