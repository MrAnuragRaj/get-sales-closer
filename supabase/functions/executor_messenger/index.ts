import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";

// executor_messenger
// Sends messages via Facebook Messenger using the Graph API.
//
// Graph API: POST https://graph.facebook.com/v21.0/me/messages?access_token={page_token}
// Recipient: Page-Scoped User ID (PSID) stored in leads.messenger_psid
// Page token: Per-org stored in org_channels(channel='messenger', is_default=true, status='active').provider_token
// Platform fallback token: FACEBOOK_PAGE_ACCESS_TOKEN env var
//
// Channel resolution: same 3-step fallback_policy algorithm as all other executors.
// Resolution (and token resolved) BEFORE token consumption — fail_task never wastes a token.
// Token key: messenger_msg (1 token/msg)
//
// Messaging type: RESPONSE for replies to user-initiated threads (24h window).
// For proactive outbound beyond the 24h window, messenger_type must be MESSAGE_TAG.
// This is controlled by task.metadata.messenger_type (default: 'RESPONSE').
//
// Env vars required:
//   FACEBOOK_PAGE_ACCESS_TOKEN  — platform-level page access token
//   FACEBOOK_PAGE_ID            — platform-level page ID (for webhook routing)

const LEASE_SECONDS = 90;
const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

// ── 3-step Messenger page token resolution with explicit fallback policy ──────
// Messenger "sender" = Facebook Page, identified by page access token.
// Per-org token stored in org_channels.provider_token.
// Platform-level token in FACEBOOK_PAGE_ACCESS_TOKEN env var.
// Must be called BEFORE token consumption.
async function resolveMessengerSender(supabase: any, orgId: string, taskId: string): Promise<{
  action: "send" | "fail";
  pageToken: string;
  pageId: string | null;
  usedShared: boolean;
  orgPageId: string | null;
  fallbackPolicy: string;
}> {
  const platformToken = Deno.env.get("FACEBOOK_PAGE_ACCESS_TOKEN") ?? "";
  const platformPageId = Deno.env.get("FACEBOOK_PAGE_ID") ?? null;

  // Step 1: Active default org Messenger channel
  const { data: activeRows } = await supabase
    .from("org_channels")
    .select("provider_token, metadata, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "messenger")
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);

  if (activeRows?.[0]?.provider_token) {
    const orgPageId = activeRows[0].metadata?.page_id ?? null;
    return {
      action: "send",
      pageToken: activeRows[0].provider_token,
      pageId: orgPageId,
      usedShared: false,
      orgPageId,
      fallbackPolicy: "active",
    };
  }

  // Step 2: Most recent default org Messenger channel (any status) — authority row for policy
  const { data: anyRows } = await supabase
    .from("org_channels")
    .select("provider_token, metadata, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "messenger")
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!anyRows || anyRows.length === 0) {
    // Brand-new org — no dedicated Messenger page ever. Use platform page.
    console.info(`[executor_messenger] event=new_org_platform_page org_id=${orgId} task_id=${taskId} page_id=${platformPageId}`);
    return {
      action: "send",
      pageToken: platformToken,
      pageId: platformPageId,
      usedShared: true,
      orgPageId: null,
      fallbackPolicy: "new_org",
    };
  }

  // Step 3: Apply fallback policy
  const orgPageId = anyRows[0].metadata?.page_id ?? null;
  const policy = anyRows[0].fallback_policy ?? "allow_shared";

  if (policy === "fail_task") {
    console.error(`[executor_messenger] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=messenger original_page=${orgPageId} policy=fail_task reason=dedicated_channel_inactive`);
    return {
      action: "fail",
      pageToken: platformToken,
      pageId: platformPageId,
      usedShared: true,
      orgPageId,
      fallbackPolicy: "fail_task",
    };
  }

  if (policy === "admin_override") {
    console.error(`[executor_messenger] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=messenger original_page=${orgPageId} policy=admin_override reason=dedicated_channel_inactive`);
  } else {
    console.warn(`[executor_messenger] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=messenger original_page=${orgPageId} policy=${policy} reason=dedicated_channel_inactive`);
  }

  return {
    action: "send",
    pageToken: platformToken,
    pageId: platformPageId,
    usedShared: true,
    orgPageId,
    fallbackPolicy: policy,
  };
}

async function writeMessengerFallbackAuditEvent(supabase: any, args: {
  orgId: string; taskId: string;
  orgPageId: string | null; usedPageId: string | null; fallbackPolicy: string;
}) {
  const { error: auditErr } = await supabase.from("audit_events").insert({
    org_id: args.orgId,
    actor_type: "system",
    actor_id: null,
    object_type: "execution_task",
    object_id: args.taskId,
    action: "channel_fallback_triggered",
    reason: args.fallbackPolicy,
    before_state: { org_page_id: args.orgPageId, channel: "messenger" },
    after_state: { used_page_id: args.usedPageId, fallback_policy: args.fallbackPolicy, shared: true },
  });
  if (auditErr) console.error("[executor_messenger] audit_event insert failed:", auditErr);
}

serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const task_id = body?.task_id as string | undefined;
  const worker_id = body?.worker_id as string | undefined;

  if (!task_id) {
    return new Response(JSON.stringify({ error: "task_id required" }), { status: 400 });
  }

  const supabase = getServiceSupabaseClient();

  // 0) Fetch task + lead (need messenger_psid for outbound)
  const { data: task, error } = await supabase
    .from("execution_tasks")
    .select("*, leads(name, phone, messenger_psid)")
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
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "messenger");
  if (!platformGate.allow) return platformGate.response;

  // 1.5) Kill-switch gate (TERMINAL)
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 1.6) Cancellation gate (TERMINAL)
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 1.7) Messenger capability check
  const { data: capability } = await supabase
    .from("org_channel_capabilities")
    .select("messenger_enabled, sms_enabled")
    .eq("org_id", task.org_id)
    .maybeSingle();

  if (!capability?.messenger_enabled) {
    const { data: routingPolicy } = await supabase
      .from("message_routing_policies")
      .select("messenger_fallback_to_sms")
      .eq("org_id", task.org_id)
      .maybeSingle();

    if (routingPolicy?.messenger_fallback_to_sms && capability?.sms_enabled) {
      console.log(`[executor_messenger] Messenger not enabled for org ${task.org_id}. Routing policy allows SMS fallback. Delegating to executor_sms.`);

      await supabase.from("execution_tasks").update({
        channel: "sms",
        metadata: { ...(task.metadata ?? {}), messenger_fallback_reason: "messenger_not_enabled" },
      }).eq("id", task_id);

      const { error: delegateErr } = await supabase.functions.invoke("executor_sms", {
        body: { task_id, worker_id },
      });

      if (delegateErr) {
        console.error("[executor_messenger] SMS fallback invocation failed:", delegateErr);
        return new Response("SMS fallback failed", { status: 500 });
      }

      return new Response(JSON.stringify({ success: true, fallback: "sms" }), { status: 200 });
    }

    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "MESSENGER_NOT_ENABLED_NO_FALLBACK",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Messenger not enabled for this org and SMS fallback is disallowed", { status: 400 });
  }

  // 1.8) PSID guard — cannot send Messenger message without recipient's PSID
  const psid = task.leads?.messenger_psid as string | null | undefined;
  if (!psid) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "MESSENGER_NO_PSID: lead has no messenger_psid — lead must have sent a Messenger message first",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("No Messenger PSID for lead", { status: 200 });
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
    return new Response("actor_user_id required", { status: 400 });
  }

  // 3.5) Rate limit gate — BEFORE token consumption and before provider send
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "messenger");
  if (!rlGate.allow) return rlGate.response;

  // 4) Resolve Messenger page token (BEFORE token consumption — fail_task aborts cleanly)
  const senderRes = await resolveMessengerSender(supabase, task.org_id, task_id);

  if (senderRes.action === "fail") {
    await writeMessengerFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgPageId: senderRes.orgPageId, usedPageId: senderRes.pageId, fallbackPolicy: "fail_task",
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "CHANNEL_FALLBACK_POLICY_FAIL_TASK: dedicated Messenger page inactive",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Sender fallback policy: fail_task", { status: 200 });
  }

  // Guard: platform token must be set if we're using shared sender
  if (!senderRes.pageToken) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "FACEBOOK_PAGE_ACCESS_TOKEN not configured",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Page access token not configured", { status: 200 });
  }

  const PAGE_TOKEN = senderRes.pageToken;
  const PAGE_ID = senderRes.pageId;

  // Write fallback audit event if shared page was selected (not brand-new org)
  if (senderRes.usedShared && senderRes.orgPageId !== null) {
    await writeMessengerFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgPageId: senderRes.orgPageId, usedPageId: PAGE_ID, fallbackPolicy: senderRes.fallbackPolicy,
    });
  }

  // 4.5) Idempotency — skip if already sent
  if (task.status === "running" && task.provider_id) {
    console.log(`[executor_messenger] Task ${task_id} already has provider_id ${task.provider_id} — skipping re-send`);
    return new Response(JSON.stringify({ success: true, skipped: true }), { status: 200 });
  }

  // 5) AI generation (skip if force_content set)
  let messageText: string;
  if (task.metadata?.force_content) {
    messageText = String(task.metadata.force_content);
  } else {
    if (task.ai_generation_locked) {
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: "AI_GENERATION_LOCKED",
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);
      return new Response("AI generation locked", { status: 200 });
    }

    const brainResult = await generateMessage(supabase, {
      task_id,
      org_id: task.org_id,
      lead: { id: task.lead_id, name: task.leads?.name },
      channel: "sms",
      intent: task.metadata?.intent_trace ?? task.metadata?.intent ?? "initial_outreach",
    });

    if (brainResult.error || !brainResult.content) {
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: safeString(brainResult.error ?? "AI_GENERATION_FAILED"),
        locked_by: null,
        locked_until: null,
      }).eq("id", task_id);
      return new Response("AI generation failed", { status: 200 });
    }

    messageText = brainResult.content;
  }

  // 6) Token consumption (AFTER sender resolution, BEFORE send)
  const { data: consumeRes, error: consumeErr } = await supabase.rpc("consume_tokens_v1", {
    p_org_id: task.org_id,
    p_scope: "user",
    p_user_id: task.actor_user_id,
    p_token_key: "messenger_msg",
    p_amount: 1,
    p_idempotency_key: task_id,
    p_metadata: { channel: "messenger", provider: "facebook", task_id },
  });

  if (consumeErr) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TOKEN_RPC_FAILED: ${consumeErr.message}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);
    return new Response("Token RPC failed", { status: 200 });
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

  // 7) Log delivery attempt (pre-send, status=pending) — idempotency guard via UNIQUE(task_id, attempt_number)
  const attemptNumber = task.attempt ?? 1;
  const { data: deliveryAttempt, error: daInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "messenger",
      provider: "facebook",
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { psid, page_id: PAGE_ID },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (daInsertErr?.code === "23505") {
    console.log(`[executor_messenger] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  const deliveryAttemptId = deliveryAttempt?.id;

  // 8) Messenger type — controls whether message can be sent outside 24h window
  // RESPONSE: reply to user-initiated thread (default, works within 24h)
  // MESSAGE_TAG + tag: proactive send (requires specific approved tag)
  const messengerType: string = task.metadata?.messenger_type ?? "RESPONSE";
  const messageTag: string | null = task.metadata?.message_tag ?? null;

  const graphBody: Record<string, unknown> = {
    recipient: { id: psid },
    message: { text: messageText },
    messaging_type: messengerType,
  };
  if (messengerType === "MESSAGE_TAG" && messageTag) {
    graphBody.tag = messageTag;
  }

  // 9) Graph API send
  let graphResp: Response;
  try {
    graphResp = await fetch(
      `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(graphBody),
      },
    );
  } catch (networkErr) {
    // Refund token on network failure
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: "messenger_msg",
      p_amount: 1,
      p_idempotency_key: `refund:${task_id}:network`,
      p_metadata: { reason: "Messenger network error — refund", task_id },
    });

    const attempt = task.attempt ?? 1;
    const maxAttempts = task.max_attempts ?? 3;
    const nextStatus = attempt >= maxAttempts ? "failed" : "pending";

    await supabase.from("execution_tasks").update({
      status: nextStatus,
      attempt: attempt + 1,
      last_error: `MESSENGER_NETWORK_ERROR: ${String(networkErr)}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: "NETWORK_ERROR",
        error_message: String(networkErr),
      }).eq("id", deliveryAttemptId);
    }

    return new Response("Messenger network error", { status: 200 });
  }

  const graphJson = await graphResp.json().catch(() => ({}));

  if (!graphResp.ok) {
    const fbError = graphJson?.error;
    const errorCode = String(fbError?.code ?? graphResp.status);
    const errorMsg = fbError?.message ?? `HTTP ${graphResp.status}`;

    console.error(`[executor_messenger] Graph API error ${graphResp.status}: code=${errorCode} msg=${errorMsg} psid=${psid}`);

    // Specific Facebook error codes that indicate permanent failures (no retry)
    // 551 = User blocked the page / opted out
    // 200 subcode 2018109 = Outside 24h messaging window (no RESPONSE allowed)
    const isTerminal = ["551", "190"].includes(errorCode) ||
      (errorCode === "200" && String(fbError?.error_subcode) === "2018109");

    // Refund token — send never happened
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id,
      p_scope: "user",
      p_user_id: task.actor_user_id,
      p_token_key: "messenger_msg",
      p_amount: 1,
      p_idempotency_key: `refund:${task_id}:graph_error`,
      p_metadata: { reason: `Messenger Graph API error ${errorCode} — refund`, task_id },
    });

    // For 24h window expiry: check routing policy for SMS fallback
    const is24hExpiry = errorCode === "200" && String(fbError?.error_subcode) === "2018109";
    if (is24hExpiry) {
      const { data: routingPolicy } = await supabase
        .from("message_routing_policies")
        .select("messenger_fallback_to_sms")
        .eq("org_id", task.org_id)
        .maybeSingle();

      if (routingPolicy?.messenger_fallback_to_sms) {
        console.log(`[executor_messenger] 24h window expired for task ${task_id} — falling back to SMS`);

        // Audit the degradation
        await supabase.from("audit_events").insert({
          org_id: task.org_id,
          actor_type: "system",
          actor_id: null,
          object_type: "execution_task",
          object_id: task_id,
          action: "channel_fallback_triggered",
          reason: "messenger_24h_window_expired",
          before_state: { channel: "messenger", psid, page_id: PAGE_ID },
          after_state: { fallback_channel: "sms", fallback_policy: "allow_shared" },
        });

        await supabase.from("execution_tasks").update({
          channel: "sms",
          metadata: { ...(task.metadata ?? {}), messenger_fallback_reason: "24h_window_expired" },
        }).eq("id", task_id);

        if (deliveryAttemptId) {
          await supabase.from("delivery_attempts").update({
            status: "failed",
            error_code: "MESSENGER_24H_EXPIRED",
            error_message: "Outside 24h messaging window — SMS fallback",
          }).eq("id", deliveryAttemptId);
        }

        const { error: delegateErr } = await supabase.functions.invoke("executor_sms", {
          body: { task_id, worker_id },
        });
        if (delegateErr) {
          console.error("[executor_messenger] SMS fallback on 24h expiry failed:", delegateErr);
        }

        return new Response(JSON.stringify({ success: true, fallback: "sms", reason: "24h_window_expired" }), { status: 200 });
      }
    }

    const attempt = task.attempt ?? 1;
    const maxAttempts = task.max_attempts ?? 3;
    const nextStatus = isTerminal || attempt >= maxAttempts ? "failed" : "pending";

    await supabase.from("execution_tasks").update({
      status: nextStatus,
      attempt: attempt + 1,
      last_error: `MESSENGER_FAILED: code=${errorCode} ${errorMsg.slice(0, 200)}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: `FB_${errorCode}`,
        error_message: errorMsg.slice(0, 500),
      }).eq("id", deliveryAttemptId);
    }

    return new Response("Messenger send failed", { status: 200 });
  }

  // ── 10) Success ───────────────────────────────────────────────────────────────
  const messageId = graphJson?.message_id ?? null;

  await supabase.from("execution_tasks").update({
    status: "succeeded",
    executed_at: new Date().toISOString(),
    provider: "facebook",
    provider_id: messageId,
    locked_by: null,
    locked_until: null,
  }).eq("id", task_id);

  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: messageId,
      sent_at: new Date().toISOString(),
      metadata: { psid, page_id: PAGE_ID, messaging_type: messengerType },
    }).eq("id", deliveryAttemptId);
  }

  console.log(`[executor_messenger] Sent: task=${task_id} message_id=${messageId} psid=${psid} page=${PAGE_ID}`);
  return new Response(JSON.stringify({ success: true, message_id: messageId }), { status: 200 });
});
