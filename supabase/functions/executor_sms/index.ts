import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";

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
  await supabase.from("audit_events").insert({
    org_id: args.orgId,
    actor_type: "system",
    actor_id: null,
    object_type: "execution_task",
    object_id: args.taskId,
    action: "channel_fallback_triggered",
    reason: args.fallbackPolicy,
    before_state: { org_sender: args.orgSender, channel: args.channel },
    after_state: { used_sender: args.usedSender, fallback_policy: args.fallbackPolicy, shared: true },
  }).catch((e: any) => console.error("[executor_sms] audit_event insert failed:", e));
}

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const task_id = body?.task_id as string | undefined;
  const worker_id = body?.worker_id as string | undefined;

  if (!task_id) {
    return new Response(JSON.stringify({ error: "task_id required" }), { status: 400 });
  }

  const supabase = getSupabaseClient(req);

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

  // 5) Generate message — skip AI if force_content is set (human takeover)
  let messageBody: string;
  if (task.metadata?.force_content) {
    messageBody = safeString(task.metadata.force_content);
    console.log(`[executor_sms] force_content bypass for task ${task_id}`);
  } else {
    const brainResult = await generateMessage(supabase, {
      task_id,
      org_id: task.org_id,
      lead: { id: task.lead_id, name: task.leads?.name },
      channel: "sms",
      intent: "initial_outreach",
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

  const deliveryAttemptId = deliveryAttempt?.id;

  // 7) Twilio send
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const authHeader = `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`;
  const params = new URLSearchParams();
  params.append("To", task.leads.phone);
  params.append("From", TWILIO_FROM);
  params.append("Body", messageBody);

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
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "NETWORK_ERROR", error_message: String(networkErr) }).eq("id", deliveryAttemptId).catch(() => {});
    }
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TWILIO_NETWORK_ERROR: ${String(networkErr)}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Network error reaching Twilio", { status: 500 });
  }

  if (!twilioResp.ok) {
    const errorText = await twilioResp.text();
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "TWILIO_FAILED", error_message: errorText.slice(0, 500) }).eq("id", deliveryAttemptId).catch(() => {});
    }
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TWILIO_FAILED: ${errorText}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Twilio failed", { status: 500 });
  }

  const twilioJson = await twilioResp.json();

  // Update delivery_attempt to "sent"
  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: twilioJson.sid,
      sent_at: new Date().toISOString(),
    }).eq("id", deliveryAttemptId).catch(() => {});
  }

  // 8) Finalize
  await supabase.from("execution_tasks").update({
    status: "succeeded",
    executed_at: new Date().toISOString(),
    provider: "twilio",
    provider_id: twilioJson.sid,
    locked_by: null,
    locked_until: null,
  }).eq("id", task_id);

  return new Response(JSON.stringify({ success: true, sid: twilioJson.sid }), { status: 200 });
});
