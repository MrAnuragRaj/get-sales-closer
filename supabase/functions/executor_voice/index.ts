import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { getVoiceContext } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";

const LEASE_SECONDS = 90;

// Pricing knobs (tune later)
const TOKEN_KEY = "liaison.voice";
const VOICE_INIT_TOKENS = 5;

// Vapi outbound calling requires a phoneNumberId.
const VAPI_CALL_URL = "https://api.vapi.ai/call/phone";

/**
 * 3-step voice sender resolution with explicit fallback policy.
 * Returns the VAPI phoneNumberId to use, or action='fail' to abort.
 * Must be called BEFORE token pre-debit.
 */
async function resolveVoiceSender(supabase: any, orgId: string, taskId: string): Promise<{
  action: "send" | "fail";
  phoneNumberId: string;
  usedShared: boolean;
  orgSender: string | null;
  fallbackPolicy: string;
}> {
  const sharedPhoneNumberId = Deno.env.get("VAPI_PHONE_NUMBER_ID") ?? "";

  // Step 1: Active default org voice channel
  const { data: activeRows } = await supabase
    .from("org_channels")
    .select("vapi_phone_number_id, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "voice")
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);

  if (activeRows?.[0]?.vapi_phone_number_id) {
    return { action: "send", phoneNumberId: activeRows[0].vapi_phone_number_id, usedShared: false, orgSender: activeRows[0].vapi_phone_number_id, fallbackPolicy: "active" };
  }

  // Step 2: Most recent default org voice channel (any status) — authority row
  const { data: anyRows } = await supabase
    .from("org_channels")
    .select("vapi_phone_number_id, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "voice")
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!anyRows || anyRows.length === 0) {
    // Brand-new org — no dedicated voice number ever.
    console.info(`[executor_voice] event=new_org_shared_sender org_id=${orgId} task_id=${taskId} phone_number_id=${sharedPhoneNumberId}`);
    return { action: "send", phoneNumberId: sharedPhoneNumberId, usedShared: true, orgSender: null, fallbackPolicy: "new_org" };
  }

  // Step 3: Apply fallback policy
  const orgSender = anyRows[0].vapi_phone_number_id ?? null;
  const policy = anyRows[0].fallback_policy ?? "allow_shared";

  if (policy === "fail_task") {
    console.error(`[executor_voice] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=voice original_sender=${orgSender} fallback_sender=${sharedPhoneNumberId} policy=fail_task reason=dedicated_channel_inactive`);
    return { action: "fail", phoneNumberId: sharedPhoneNumberId, usedShared: true, orgSender, fallbackPolicy: "fail_task" };
  }

  if (policy === "admin_override") {
    console.error(`[executor_voice] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=voice original_sender=${orgSender} fallback_sender=${sharedPhoneNumberId} policy=admin_override reason=dedicated_channel_inactive`);
  } else {
    console.warn(`[executor_voice] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=voice original_sender=${orgSender} fallback_sender=${sharedPhoneNumberId} policy=${policy} reason=dedicated_channel_inactive`);
  }

  return { action: "send", phoneNumberId: sharedPhoneNumberId, usedShared: true, orgSender, fallbackPolicy: policy };
}

async function writeVoiceFallbackAuditEvent(supabase: any, args: {
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
    before_state: { org_sender: args.orgSender, channel: "voice" },
    after_state: { used_sender: args.usedSender, fallback_policy: args.fallbackPolicy, shared: true },
  });
  if (auditErr) console.error("[executor_voice] audit_event insert failed:", auditErr);
}

async function isBillingLocked(
  supabase: any,
  orgId: string,
): Promise<{ locked: boolean; status: string }> {
  const { data, error } = await supabase
    .from("org_billing_profiles")
    .select("billing_lock_status")
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("billing_lock_read_failed", { org_id: orgId, error: error.message });
    // ✅ FAIL-CLOSED for spend surfaces
    return { locked: true, status: "unknown_error" };
  }

  const st = String(data?.billing_lock_status ?? "none");
  return { locked: st !== "none", status: st };
}

async function failTask(
  supabase: any,
  task_id: string,
  patch: Record<string, unknown>,
) {
  await supabase
    .from("execution_tasks")
    .update({
      status: "failed",
      locked_by: null,
      locked_until: null,
      ...patch,
    })
    .eq("id", task_id);
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
    .select("*, leads(phone, name, id)")
    .eq("id", task_id)
    .single();

  if (error || !task) return new Response("Task not found", { status: 404 });

  // 1) Accept only pending/running
  if (!["pending", "running"].includes(task.status)) {
    return new Response("Task already processed", { status: 200 });
  }

  // 1.4) Platform kill switch (TERMINAL) — checked before org-level
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "voice");
  if (!platformGate.allow) return platformGate.response;

  // 1.5) Kill-switch wins over everything (TERMINAL)
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 1.55) Cancellation gate (TERMINAL)
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 1.6) Billing lock guard (bridge)
  const bill = await isBillingLocked(supabase, task.org_id);
  if (bill.locked) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "blocked_billing_lock",
        last_error: `BILLING_LOCK:${bill.status ?? "unknown"}`,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Blocked: billing lock", { status: 200 });
  }

  // 2) Lease enforcement
  if (worker_id) {
    if (task.status !== "running" || task.locked_by !== worker_id) {
      return new Response("Task not leased to this worker", { status: 200 });
    }
  } else {
    // Manual mode: claim if pending
    if (task.status === "pending") {
      const leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("execution_tasks")
        .update({ status: "running", locked_by: "manual", locked_until: leaseUntil })
        .eq("id", task_id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

      if (claimErr || !claimed) return new Response("Task already claimed", { status: 200 });
    }
  }

  // Lead validation
  const leadPhone = task.leads?.phone;
  const leadName = task.leads?.name ?? "there";
  const leadId = task.leads?.id;

  if (!leadPhone || !leadId) {
    await failTask(supabase, task_id, { last_error: "MISSING_LEAD_PHONE_OR_ID" });
    return new Response("Missing lead phone/id", { status: 500 });
  }

  // 3) Terminal guard
  const { data: term, error: termErr } = await supabase.rpc("is_lead_terminal", {
    p_org_id: task.org_id,
    p_lead_id: task.lead_id,
  });

  if (termErr) {
    await failTask(supabase, task_id, { last_error: `TERMINAL_CHECK_FAILED: ${termErr.message}` });
    return new Response("Terminal check failed", { status: 500 });
  }

  if (term?.[0]?.is_terminal) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "skipped_terminal",
        last_error: term[0].reason,
        executed_at: new Date().toISOString(),
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Lead terminal, task skipped", { status: 200 });
  }

  // 4) actor_user_id required
  if (!task.actor_user_id) {
    await failTask(supabase, task_id, { last_error: "MISSING_ACTOR_USER_ID" });
    return new Response("Missing actor_user_id", { status: 500 });
  }

  // 4.5) Rate limit gate — BEFORE token pre-debit and before VAPI call
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "voice");
  if (!rlGate.allow) return rlGate.response;

  // 4.6) If already linked to a provider call, exit idempotently
  if (task.provider === "vapi" && task.provider_id) {
    return new Response(
      JSON.stringify({ success: true, call_id: task.provider_id, mode: "already_linked" }),
      { status: 200 },
    );
  }

  // 4.6) Resolve voice sender BEFORE token pre-debit (fail_task aborts cleanly)
  const senderRes = await resolveVoiceSender(supabase, task.org_id, task_id);

  if (senderRes.action === "fail") {
    await writeVoiceFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgSender: senderRes.orgSender, usedSender: senderRes.phoneNumberId, fallbackPolicy: "fail_task",
    });
    await failTask(supabase, task_id, {
      last_error: "CHANNEL_FALLBACK_POLICY_FAIL_TASK: dedicated voice sender inactive",
    });
    return new Response("Sender fallback policy: fail_task", { status: 200 });
  }

  const PHONE_NUMBER_ID = senderRes.phoneNumberId;

  // Write fallback audit event if shared sender was selected (not brand-new org)
  if (senderRes.usedShared && senderRes.orgSender !== null) {
    await writeVoiceFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgSender: senderRes.orgSender, usedSender: PHONE_NUMBER_ID, fallbackPolicy: senderRes.fallbackPolicy,
    });
  }

  // 5) PRE-DEBIT TOKENS (IDEMPOTENT)
  const initIdem = `${task_id}:voice:init`;

  const { data: consumeRes, error: initConsumeErr } = await supabase.rpc("consume_tokens_v1", {
    p_org_id: task.org_id,
    p_scope: "user",
    p_user_id: task.actor_user_id,
    p_token_key: TOKEN_KEY,
    p_amount: VOICE_INIT_TOKENS,
    p_idempotency_key: initIdem,
    p_metadata: {
      phase: "init",
      channel: "voice",
      provider: "vapi",
      lead_id: task.lead_id,
      plan_id: task.plan_id,
      task_id,
    },
  });

  if (initConsumeErr) {
    await failTask(supabase, task_id, {
      last_error: `TOKEN_RPC_FAILED: ${initConsumeErr.message}`,
      provider: "vapi",
    });
    return new Response("Token debit RPC failed", { status: 500 });
  }

  if (!consumeRes || consumeRes.status !== "ok") {
    const reason = consumeRes?.reason ?? "TOKEN_CONSUME_DECLINED";
    await supabase
      .from("execution_tasks")
      .update({
        status: "paused_insufficient_funds",
        last_error: `VOICE_INIT_TOKEN_DECLINED: ${reason}`,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Insufficient tokens (voice init)", { status: 402 });
  }

  // 6) Brain context
  const brainContext = await getVoiceContext(supabase, task.org_id, leadId);

  // 7) Load org settings (assistant id override)
  const { data: orgSettings } = await supabase
    .from("org_settings")
    .select("vapi_assistant_id")
    .eq("org_id", task.org_id)
    .maybeSingle();

  // 7.5) Log delivery attempt (pre-call) — idempotency guard via UNIQUE(task_id, attempt_number)
  const attemptNumber = task.attempt ?? 1;
  const { data: voiceDeliveryAttempt, error: vdaInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "voice",
      provider: "vapi",
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { phone_number_id: PHONE_NUMBER_ID, to: leadPhone },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (vdaInsertErr?.code === "23505") {
    console.log(`[executor_voice] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  const voiceDeliveryAttemptId = voiceDeliveryAttempt?.id;

  // 8) Vapi call start
  const VAPI_KEY = Deno.env.get("VAPI_PRIVATE_KEY") ?? "";
  const ASSISTANT_ID = (orgSettings?.vapi_assistant_id as string | undefined) ??
    (Deno.env.get("VAPI_ASSISTANT_ID") ?? "");

  if (!VAPI_KEY || !ASSISTANT_ID || !PHONE_NUMBER_ID) {
    const refundIdem = `${task_id}:voice:init_refund_missing_config`;
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: VOICE_INIT_TOKENS,
      p_idempotency_key: refundIdem,
      p_intent_id: null,
      p_provider: "vapi",
      p_provider_payment_id: null,
      p_metadata: { phase: "init_refund", reason: "missing_vapi_config", task_id },
    });

    if (voiceDeliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "CONFIG_MISSING", error_message: "Missing VAPI_PRIVATE_KEY, assistantId, or PHONE_NUMBER_ID" }).eq("id", voiceDeliveryAttemptId);
    }

    await failTask(supabase, task_id, {
      last_error: "MISSING_VAPI_CONFIG (need VAPI_PRIVATE_KEY, assistantId, VAPI_PHONE_NUMBER_ID)",
      provider: "vapi",
    });

    return new Response("Missing Vapi config", { status: 500 });
  }

  const vapiPayload = {
    assistantId: ASSISTANT_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: leadPhone, name: leadName },
    assistantOverrides: {
      variableValues: {
        lead_name: leadName,
        lead_id: leadId,
        task_id,
        plan_id: task.plan_id,
        org_id: task.org_id,
        actor_user_id: task.actor_user_id,
        system_prompt: brainContext.systemPrompt,
        prompt_version: brainContext.version,
      },
      firstMessage: `Hi ${leadName}, I'm calling from GetSalesCloser regarding your request. Do you have a minute?`,
    },
  };

  let response: Response;
  try {
    response = await fetch(VAPI_CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VAPI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(vapiPayload),
    });
  } catch (networkErr) {
    // Refund tokens on network failure
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: VOICE_INIT_TOKENS,
      p_idempotency_key: `${task_id}:voice:init_refund_net_err`,
      p_intent_id: null,
      p_provider: "vapi",
      p_provider_payment_id: null,
      p_metadata: { phase: "init_refund", channel: "voice", reason: "network_error", task_id },
    });
    if (voiceDeliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "NETWORK_ERROR", error_message: String(networkErr) }).eq("id", voiceDeliveryAttemptId);
    }
    await failTask(supabase, task_id, {
      last_error: `VAPI_NETWORK_ERROR: ${String(networkErr)}`,
      provider: "vapi",
    });
    return new Response("Network error reaching VAPI", { status: 500 });
  }

  if (!response.ok) {
    const errorText = await response.text();

    const refundIdem = `${task_id}:voice:init_refund_vapi_failed`;
    const { error: refundErr } = await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: VOICE_INIT_TOKENS,
      p_idempotency_key: refundIdem,
      p_intent_id: null,
      p_provider: "vapi",
      p_provider_payment_id: null,
      p_metadata: {
        phase: "init_refund",
        channel: "voice",
        provider: "vapi",
        task_id,
        lead_id: task.lead_id,
        plan_id: task.plan_id,
        vapi_error: errorText,
      },
    });

    if (voiceDeliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: `VAPI_${response.status}`, error_message: errorText.slice(0, 500) }).eq("id", voiceDeliveryAttemptId);
    }

    await failTask(supabase, task_id, {
      last_error: `VAPI_CALL_START_FAILED: ${errorText}${refundErr ? ` | REFUND_FAILED: ${refundErr.message}` : ""}`,
      provider: "vapi",
    });

    return new Response("Vapi Failed", { status: 500 });
  }

  const vapiJson = await response.json();
  const callId = vapiJson?.id ?? null;

  // Update delivery_attempt: call initiated = "sent" (async delivery tracked via VAPI webhook)
  if (voiceDeliveryAttemptId && callId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: callId,
      sent_at: new Date().toISOString(),
    }).eq("id", voiceDeliveryAttemptId);
  }

  if (!callId) {
    const refundIdem = `${task_id}:voice:init_refund_no_call_id`;
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: VOICE_INIT_TOKENS,
      p_idempotency_key: refundIdem,
      p_intent_id: null,
      p_provider: "vapi",
      p_provider_payment_id: null,
      p_metadata: { phase: "init_refund", reason: "missing_call_id", task_id },
    });

    await failTask(supabase, task_id, {
      last_error: "VAPI_CALL_START_MISSING_CALL_ID",
      provider: "vapi",
    });

    return new Response("Vapi returned no call id", { status: 500 });
  }

  // 9) Link task <-> provider call id
  const { data: linked, error: linkErr } = await supabase
    .from("execution_tasks")
    .update({
      provider: "vapi",
      provider_id: callId,
      metadata: {
        ...(task.metadata ?? {}),
        voice: {
          ...((task.metadata ?? {}).voice ?? {}),
          call_id: callId,
          provider: "vapi",
          call_linked_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", task_id)
    .or(`provider_id.is.null,provider_id.eq.${callId}`)
    .select("id,provider,provider_id")
    .maybeSingle();

  if (linkErr || !linked) {
    const refundIdem = `${task_id}:voice:init_refund_link_failed`;
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: VOICE_INIT_TOKENS,
      p_idempotency_key: refundIdem,
      p_intent_id: null,
      p_provider: "vapi",
      p_provider_payment_id: callId,
      p_metadata: {
        phase: "init_refund",
        reason: "link_failed",
        task_id,
        call_id: callId,
        link_error: linkErr?.message ?? "NO_ROW_UPDATED",
      },
    });

    await failTask(supabase, task_id, {
      last_error: `VOICE_TASK_LINK_CALL_FAILED: ${linkErr?.message ?? "NO_ROW_UPDATED"}`,
      provider: "vapi",
    });

    return new Response("Failed to link call to task", { status: 500 });
  }

  // 10) Upsert voice_calls row (best-effort)
  const { error: vcErr } = await supabase.from("voice_calls").upsert(
    {
      org_id: task.org_id,
      lead_id: task.lead_id,
      plan_id: task.plan_id ?? null,
      actor_user_id: task.actor_user_id ?? null,
      task_id,
      provider: "vapi",
      provider_call_id: callId,
      started_at: new Date().toISOString(),
    },
    { onConflict: "provider,provider_call_id" },
  );

  if (vcErr) {
    await supabase
      .from("execution_tasks")
      .update({
        last_error: `VOICE_CALLS_UPSERT_FAILED: ${vcErr.message}`,
        metadata: {
          ...(task.metadata ?? {}),
          voice: {
            ...((task.metadata ?? {}).voice ?? {}),
            voice_calls_upsert_failed: true,
            voice_calls_error: vcErr.message,
          },
        },
      })
      .eq("id", task_id);
  }

  // 11) Mark succeeded (call initiated)
  await supabase
    .from("execution_tasks")
    .update({
      status: "succeeded",
      executed_at: new Date().toISOString(),
      provider: "vapi",
      provider_id: callId,
      locked_by: null,
      locked_until: null,
      metadata: {
        ...(task.metadata ?? {}),
        voice: {
          ...((task.metadata ?? {}).voice ?? {}),
          call_id: callId,
          provider: "vapi",
          prompt_version: brainContext.version,
          init_tokens: VOICE_INIT_TOKENS,
          init_debit_idempotency_key: initIdem,
          settlement_status: "pending",
        },
      },
    })
    .eq("id", task_id);

  // 12) Cancel voice retries
  await supabase.rpc("cancel_pending_retries_channel", {
    p_plan_id: task.plan_id,
    p_channel: "voice",
    p_exclude_task_id: task_id,
    p_reason: "VOICE_CALL_STARTED_CANCEL_RETRIES",
  });

  return new Response(JSON.stringify({ success: true, call_id: callId }), { status: 200 });
});
