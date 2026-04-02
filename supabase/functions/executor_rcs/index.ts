import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";
import { updateConversationState } from "../_shared/conversation_state.ts";
import type { Intent } from "../_shared/intent_rules.ts";

// executor_rcs
// Sends RCS messages via Google RCS Business Messaging (RBM) / Business Communications API.
//
// Google RBM API: POST https://rcsbusinessmessaging.googleapis.com/v1/phones/{msisdn}/agentMessages
// Auth: Google Service Account → OAuth2 JWT bearer token (scope: rcsbusinessmessaging)
// Agent: Platform-level RBM agent (GOOGLE_RBM_AGENT_ID env var)
// Per-org dedicated agent: stored in org_channels(channel='rcs', is_default=true, status='active').provider_id
//
// Channel resolution: same 3-step fallback_policy algorithm as executor_sms/voice/whatsapp.
// Resolution BEFORE token consumption so fail_task never wastes a token.
// Token key: rcs_msg (1 token/msg)
//
// Test-device workflow:
// - In RBM pre-launch, only registered test devices can receive messages.
// - Register test devices at https://business.google.com/business-messages
// - Once launched, all RCS-capable Android devices are reachable.
//
// Env vars required:
//   GOOGLE_RBM_SERVICE_ACCOUNT_JSON  — full Google service account JSON string
//   GOOGLE_RBM_AGENT_ID              — RBM agent ID (e.g. "my-sales-agent@mybrand.rbm.goog" or brands/{b}/agents/{a})

const LEASE_SECONDS = 90;
const RBM_BASE = "https://rcsbusinessmessaging.googleapis.com/v1";
const RBM_SCOPE = "https://www.googleapis.com/auth/rcsbusinessmessaging";

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

// ── Google RBM OAuth2: Service Account JWT → Access Token ────────────────────
// Implements RFC 7523 JWT bearer token flow without third-party deps.
async function getGoogleAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: RBM_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const signingInput = `${header}.${payload}`;

  // Import RSA private key from PEM
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwtAssertion = `${signingInput}.${sig}`;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwtAssertion,
    }),
  });
  if (!tokenResp.ok) {
    const txt = await tokenResp.text().catch(() => "");
    throw new Error(`Google OAuth2 failed ${tokenResp.status}: ${txt}`);
  }
  const tokenJson = await tokenResp.json();
  return tokenJson.access_token as string;
}

// ── 3-step RCS sender resolution with explicit fallback policy ────────────────
// RCS "sender" = RBM agent ID (platform-level or per-org dedicated agent).
// Stored in org_channels.provider_id for dedicated agents.
// Must be called BEFORE token consumption.
async function resolveRcsSender(supabase: any, orgId: string, taskId: string): Promise<{
  action: "send" | "fail";
  agentId: string;
  usedShared: boolean;
  orgAgentId: string | null;
  fallbackPolicy: string;
}> {
  const platformAgentId = Deno.env.get("GOOGLE_RBM_AGENT_ID") ?? "";

  // Step 1: Active default org RCS channel (dedicated agent)
  const { data: activeRows } = await supabase
    .from("org_channels")
    .select("provider_id, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "rcs")
    .eq("is_default", true)
    .eq("status", "active")
    .limit(1);

  if (activeRows?.[0]?.provider_id) {
    return {
      action: "send",
      agentId: activeRows[0].provider_id,
      usedShared: false,
      orgAgentId: activeRows[0].provider_id,
      fallbackPolicy: "active",
    };
  }

  // Step 2: Most recent default org RCS channel (any status) — authority row for policy
  const { data: anyRows } = await supabase
    .from("org_channels")
    .select("provider_id, fallback_policy")
    .eq("org_id", orgId)
    .eq("channel", "rcs")
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!anyRows || anyRows.length === 0) {
    // Brand-new org or no dedicated RCS agent — use platform agent (expected behavior)
    console.info(`[executor_rcs] event=new_org_platform_agent org_id=${orgId} task_id=${taskId} agent=${platformAgentId}`);
    return { action: "send", agentId: platformAgentId, usedShared: true, orgAgentId: null, fallbackPolicy: "new_org" };
  }

  // Step 3: Apply fallback policy
  const orgAgentId = anyRows[0].provider_id ?? null;
  const policy = anyRows[0].fallback_policy ?? "allow_shared";

  if (policy === "fail_task") {
    console.error(`[executor_rcs] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=rcs original_agent=${orgAgentId} policy=fail_task reason=dedicated_channel_inactive`);
    return { action: "fail", agentId: platformAgentId, usedShared: true, orgAgentId, fallbackPolicy: "fail_task" };
  }

  if (policy === "admin_override") {
    console.error(`[executor_rcs] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=rcs original_agent=${orgAgentId} policy=admin_override reason=dedicated_channel_inactive`);
  } else {
    console.warn(`[executor_rcs] event=channel_fallback_triggered org_id=${orgId} task_id=${taskId} channel=rcs original_agent=${orgAgentId} policy=${policy} reason=dedicated_channel_inactive`);
  }

  return { action: "send", agentId: platformAgentId, usedShared: true, orgAgentId, fallbackPolicy: policy };
}

async function writeRcsFallbackAuditEvent(supabase: any, args: {
  orgId: string; taskId: string;
  orgAgentId: string | null; usedAgentId: string; fallbackPolicy: string;
}) {
  const { error: auditErr } = await supabase.from("audit_events").insert({
    org_id: args.orgId,
    actor_type: "system",
    actor_id: null,
    object_type: "execution_task",
    object_id: args.taskId,
    action: "channel_fallback_triggered",
    reason: args.fallbackPolicy,
    before_state: { org_agent_id: args.orgAgentId, channel: "rcs" },
    after_state: { used_agent_id: args.usedAgentId, fallback_policy: args.fallbackPolicy, shared: true },
  });
  if (auditErr) console.error("[executor_rcs] audit_event insert failed:", auditErr);
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
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "rcs");
  if (!platformGate.allow) return platformGate.response;

  // 1.5) Kill-switch gate (TERMINAL)
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 1.6) Cancellation gate (TERMINAL)
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 1.7) RCS capability check
  const { data: capability } = await supabase
    .from("org_channel_capabilities")
    .select("rcs_enabled, sms_enabled")
    .eq("org_id", task.org_id)
    .maybeSingle();

  if (!capability?.rcs_enabled) {
    const { data: routingPolicy } = await supabase
      .from("message_routing_policies")
      .select("rcs_fallback_to_sms")
      .eq("org_id", task.org_id)
      .maybeSingle();

    if (routingPolicy?.rcs_fallback_to_sms && capability?.sms_enabled) {
      console.log(`[executor_rcs] RCS not enabled for org ${task.org_id}. Routing policy allows SMS fallback. Delegating to executor_sms.`);

      await supabase.from("execution_tasks").update({
        channel: "sms",
        metadata: { ...(task.metadata ?? {}), rcs_fallback_reason: "rcs_not_enabled" },
      }).eq("id", task_id);

      const { error: delegateErr } = await supabase.functions.invoke("executor_sms", {
        body: { task_id, worker_id },
      });

      if (delegateErr) {
        console.error("[executor_rcs] SMS fallback invocation failed:", delegateErr);
        return new Response("SMS fallback failed", { status: 500 });
      }

      return new Response(JSON.stringify({ success: true, fallback: "sms" }), { status: 200 });
    }

    // No fallback — fail task
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "RCS_NOT_ENABLED_NO_FALLBACK",
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("RCS not enabled for this org and SMS fallback is disallowed", { status: 400 });
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
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "rcs");
  if (!rlGate.allow) return rlGate.response;

  // 3.6) DNC / terminal lead guard — application-layer second check on top of SQL-level gate.
  // Fail-closed: if the RPC itself errors, abort execution rather than risk a DNC send.
  const { data: rcsTerm, error: rcsTermErr } = await supabase.rpc("is_lead_terminal", {
    p_org_id: task.org_id,
    p_lead_id: task.lead_id,
  });
  if (rcsTermErr) {
    console.error(JSON.stringify({ event: "rcs_terminal_check_failed", task_id, lead_id: task.lead_id, error: rcsTermErr.message }));
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TERMINAL_CHECK_FAILED: ${rcsTermErr.message}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Terminal check failed", { status: 500 });
  }
  if (rcsTerm?.[0]?.is_terminal) {
    console.warn(JSON.stringify({ event: "rcs_lead_terminal_skip", task_id, lead_id: task.lead_id, reason: rcsTerm[0].reason }));
    await supabase.from("execution_tasks").update({
      status: "skipped_terminal",
      last_error: rcsTerm[0].reason,
      executed_at: new Date().toISOString(),
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Lead terminal, task skipped", { status: 200 });
  }

  // 4) Resolve RCS sender (BEFORE token consumption — fail_task aborts cleanly)
  const senderRes = await resolveRcsSender(supabase, task.org_id, task_id);

  if (senderRes.action === "fail") {
    await writeRcsFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgAgentId: senderRes.orgAgentId, usedAgentId: senderRes.agentId, fallbackPolicy: "fail_task",
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "CHANNEL_FALLBACK_POLICY_FAIL_TASK: dedicated RCS agent inactive",
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Sender fallback policy: fail_task", { status: 200 });
  }

  const RBM_AGENT_ID = senderRes.agentId;

  // Write fallback audit event if shared agent was selected (not brand-new org)
  if (senderRes.usedShared && senderRes.orgAgentId !== null) {
    await writeRcsFallbackAuditEvent(supabase, {
      orgId: task.org_id, taskId: task_id,
      orgAgentId: senderRes.orgAgentId, usedAgentId: RBM_AGENT_ID, fallbackPolicy: senderRes.fallbackPolicy,
    });
  }

  // 4.5) Idempotency — skip if already succeeded
  if (task.status === "running" && task.provider_id) {
    console.log(`[executor_rcs] Task ${task_id} already has provider_id ${task.provider_id} — skipping re-send`);
    return new Response(JSON.stringify({ success: true, skipped: true }), { status: 200 });
  }

  // 5) AI generation (skip if force_content set)
  // Resolve intent from task metadata — same pattern as executor_sms.
  const rcsEffectiveIntent = task.metadata?.intent_trace ?? task.metadata?.intent ?? "ambiguous";
  const RCS_VALID_INTENTS = new Set<string>([
    "request_callback", "request_meeting", "request_pricing_details",
    "clarification_business", "qualification_answer", "objection_soft",
    "objection_hard", "affirmative", "negative", "not_interested",
    "unsubscribe", "off_topic", "ambiguous",
  ]);
  const rcsSafeIntent = (RCS_VALID_INTENTS.has(rcsEffectiveIntent) ? rcsEffectiveIntent : "ambiguous") as Intent;

  let messageText: string;
  if (task.metadata?.force_content) {
    messageText = String(task.metadata.force_content);
  } else {
    if (task.ai_generation_locked) {
      // Locked flag is transient — content may become available shortly.
      // Re-queue with 60s backoff instead of permanent failure.
      const backoffAt = new Date(Date.now() + 60 * 1000).toISOString();
      await supabase.from("execution_tasks").update({
        status: "pending",
        scheduled_for: backoffAt,
        last_error: "AI_GENERATION_LOCKED_BACKOFF_60S",
        locked_by: null, locked_until: null,
      }).eq("id", task_id).in("status", ["running", "pending"]);
      return new Response("AI generation locked — requeued with 60s backoff", { status: 200 });
    }

    // Load most recent inbound message for context
    const { data: latestRcsInbound } = await supabase
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
      channel: "rcs",
      intent: rcsSafeIntent,
      user_query: latestRcsInbound?.content ?? undefined,
    });

    if (brainResult.error || !brainResult.content) {
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: safeString(brainResult.error ?? "AI_GENERATION_FAILED"),
        locked_by: null, locked_until: null,
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
    p_token_key: "rcs_msg",
    p_amount: 1,
    p_idempotency_key: task_id,
    p_metadata: {
      channel: "rcs",
      provider: "google_rbm",
      lead_id: task.lead_id,
      plan_id: task.plan_id,
    },
  });

  if (consumeErr) {
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TOKEN_RPC_FAILED: ${consumeErr.message}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Token RPC failed", { status: 500 });
  }

  if (!consumeRes || consumeRes.status !== "ok") {
    const rcsTokenReason = consumeRes?.reason ?? "TOKEN_CONSUME_DECLINED";
    await supabase.from("execution_tasks").update({
      status: "paused_insufficient_funds",
      last_error: `TOKEN_CONSUME_DECLINED: ${rcsTokenReason}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    return new Response("Insufficient rcs_msg tokens", { status: 402 });
  }

  // 7) Log delivery attempt (pre-send) — idempotency guard via UNIQUE(task_id, attempt_number)
  const toPhone = (task.leads?.phone ?? "").replace(/^\+?/, "+");
  const messageId = crypto.randomUUID();
  const attemptNumber = task.attempt ?? 1;

  const { data: deliveryAttempt, error: daInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "rcs",
      provider: "google_rbm",
      provider_message_id: messageId,
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { rbm_agent_id: RBM_AGENT_ID, to_phone: toPhone },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (daInsertErr?.code === "23505") {
    console.log(`[executor_rcs] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  // Non-23505 insert error — treat delivery_attempt as mandatory precondition.
  // Do NOT call provider without an idempotency record. Refund and abort.
  if (daInsertErr) {
    console.error(JSON.stringify({
      event: "rcs_delivery_attempt_insert_failed",
      task_id,
      error_code: daInsertErr.code,
      error_message: daInsertErr.message,
    }));
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "rcs_msg", p_amount: 1,
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

  // 8) Google RBM send
  const SA_JSON = Deno.env.get("GOOGLE_RBM_SERVICE_ACCOUNT_JSON");
  if (!SA_JSON) {
    // Refund token — missing config
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "rcs_msg", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:missing_sa_json`,
      p_metadata: { phase: "refund", reason: "missing_sa_json", task_id },
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: "GOOGLE_RBM_SERVICE_ACCOUNT_JSON not configured",
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: "CONFIG_MISSING",
        error_message: "GOOGLE_RBM_SERVICE_ACCOUNT_JSON not set",
      }).eq("id", deliveryAttemptId);
    }
    return new Response("RBM config missing", { status: 200 });
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(SA_JSON);
  } catch (authErr) {
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "rcs_msg", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:auth_failed`,
      p_metadata: { phase: "refund", reason: "rbm_auth_failed", task_id },
    });
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `RBM_AUTH_FAILED: ${String(authErr)}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: "AUTH_FAILED",
        error_message: String(authErr),
      }).eq("id", deliveryAttemptId);
    }
    return new Response("RBM auth failed", { status: 200 });
  }

  // Encode phone for URL: "+" must be percent-encoded
  const msisdn = encodeURIComponent(toPhone);
  const rbmUrl = `${RBM_BASE}/phones/${msisdn}/agentMessages?agentId=${encodeURIComponent(RBM_AGENT_ID)}&messageId=${encodeURIComponent(messageId)}`;

  let rbmResp: Response;
  try {
    rbmResp = await fetch(rbmUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contentMessage: { text: messageText },
      }),
    });
  } catch (networkErr) {
    // Refund token on network failure
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "rcs_msg", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:network`,
      p_metadata: { phase: "refund", reason: "rbm_network_error", task_id },
    });

    const attempt = task.attempt ?? 1;
    const maxAttempts = task.max_attempts ?? 3;
    const nextStatus = attempt >= maxAttempts ? "failed" : "pending";

    await supabase.from("execution_tasks").update({
      status: nextStatus,
      attempt: attempt + 1,
      last_error: `RBM_NETWORK_ERROR: ${String(networkErr)}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: "NETWORK_ERROR",
        error_message: String(networkErr),
      }).eq("id", deliveryAttemptId);
    }

    return new Response("RBM network error", { status: 200 });
  }

  if (!rbmResp.ok) {
    const errorText = await rbmResp.text().catch(() => "");
    console.error(`[executor_rcs] RBM API error ${rbmResp.status}: ${errorText}`);

    // 403 = device not RCS-capable (not a test device in pre-launch, or unsupported device)
    // Check routing policy for SMS fallback on capability failure
    const isCapabilityError = rbmResp.status === 403 || rbmResp.status === 404;

    if (isCapabilityError) {
      const { data: routingPolicy } = await supabase
        .from("message_routing_policies")
        .select("rcs_fallback_to_sms")
        .eq("org_id", task.org_id)
        .maybeSingle();

      if (routingPolicy?.rcs_fallback_to_sms) {
        // Refund rcs_msg token (SMS executor will consume sms_msg instead)
        await supabase.rpc("grant_tokens_core_v1", {
          p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
          p_token_key: "rcs_msg", p_amount: 1,
          p_idempotency_key: `refund:${task_id}:rcs_not_capable`,
          p_metadata: { phase: "refund", reason: "rcs_device_not_capable", task_id },
        });

        await supabase.from("execution_tasks").update({
          channel: "sms",
          metadata: { ...(task.metadata ?? {}), rcs_fallback_reason: "device_not_rcs_capable", rcs_error: rbmResp.status },
        }).eq("id", task_id);

        if (deliveryAttemptId) {
          await supabase.from("delivery_attempts").update({
            status: "failed",
            error_code: `RBM_${rbmResp.status}`,
            error_message: "Device not RCS-capable — SMS fallback",
          }).eq("id", deliveryAttemptId);
        }

        console.log(`[executor_rcs] Device not RCS-capable for task ${task_id} — delegating to executor_sms`);
        const { error: delegateErr } = await supabase.functions.invoke("executor_sms", {
          body: { task_id, worker_id },
        });

        if (delegateErr) {
          console.error("[executor_rcs] SMS fallback on capability failure failed:", delegateErr);
        }

        return new Response(JSON.stringify({ success: true, fallback: "sms", reason: "device_not_rcs_capable" }), { status: 200 });
      }
    }

    // Non-capability error or no fallback — refund + fail
    await supabase.rpc("grant_tokens_core_v1", {
      p_org_id: task.org_id, p_scope: "user", p_user_id: task.actor_user_id,
      p_token_key: "rcs_msg", p_amount: 1,
      p_idempotency_key: `refund:${task_id}:rbm_error`,
      p_metadata: { phase: "refund", reason: "rbm_api_error", http_status: rbmResp.status, task_id },
    });

    const attempt = task.attempt ?? 1;
    const maxAttempts = task.max_attempts ?? 3;
    const nextStatus = attempt >= maxAttempts ? "failed" : "pending";

    await supabase.from("execution_tasks").update({
      status: nextStatus,
      attempt: attempt + 1,
      last_error: `RBM_FAILED: ${rbmResp.status} ${errorText.slice(0, 200)}`,
      locked_by: null, locked_until: null,
    }).eq("id", task_id);

    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({
        status: "failed",
        error_code: `RBM_${rbmResp.status}`,
        error_message: errorText.slice(0, 500),
      }).eq("id", deliveryAttemptId);
    }

    return new Response("RBM send failed", { status: 200 });
  }

  // ── 9) Success ────────────────────────────────────────────────────────────────
  const rbmJson = await rbmResp.json().catch(() => ({}));
  const rbmResourceName = rbmJson?.name ?? null;

  // Update delivery_attempt to 'sent' BEFORE marking task succeeded — order matters.
  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      metadata: { rbm_resource_name: rbmResourceName, rbm_agent_id: RBM_AGENT_ID },
    }).eq("id", deliveryAttemptId);
  }

  // Delivery status pre-check — do not mark succeeded unless delivery_attempt is actually 'sent'.
  if (deliveryAttemptId) {
    const { data: daCheck } = await supabase
      .from("delivery_attempts")
      .select("status")
      .eq("id", deliveryAttemptId)
      .maybeSingle();

    if (daCheck?.status !== "sent") {
      console.error(JSON.stringify({
        event: "rcs_task_success_blocked_delivery_not_sent",
        task_id,
        delivery_attempt_id: deliveryAttemptId,
        delivery_attempt_status: daCheck?.status ?? "unknown",
        rbm_message_id: messageId,
      }));
      await supabase.from("execution_tasks").update({
        status: "failed",
        last_error: `DELIVERY_STATUS_MISMATCH:expected_sent_got_${daCheck?.status ?? "unknown"}`,
        locked_by: null, locked_until: null,
      }).eq("id", task_id).in("status", ["running", "pending"]);
      return new Response("Delivery status mismatch", { status: 500 });
    }
  }

  const { data: rcsFinalizedTask } = await supabase.from("execution_tasks").update({
    status: "succeeded",
    executed_at: new Date().toISOString(),
    provider: "google_rbm",
    provider_id: messageId,
    locked_by: null, locked_until: null,
  }).eq("id", task_id).in("status", ["running", "pending"]).select("id").maybeSingle();

  if (!rcsFinalizedTask) {
    console.warn(JSON.stringify({ event: "rcs_task_finalize_noop", task_id, note: "task not in running/pending — already handled elsewhere" }));
  }

  // Log outbound interaction for conversation history
  await supabase.from("interactions").insert({
    org_id: task.org_id,
    lead_id: task.lead_id,
    type: "rcs",
    direction: "outbound",
    content: messageText,
    metadata: { task_id, message_id: messageId, rbm_agent_id: RBM_AGENT_ID },
  }).then(undefined, (e: any) => console.error("[executor_rcs] outbound interaction log failed:", e));

  // Update conversation state (best-effort).
  // source="outbound": preserves stage, only writes last_outbound_intent metadata.
  updateConversationState(supabase, task.lead_id, task.org_id, rcsSafeIntent, "", "outbound")
    .then(undefined, (e: any) => console.error("[executor_rcs] updateConversationState failed:", e));

  console.log(`[executor_rcs] Sent: task=${task_id} message_id=${messageId} agent=${RBM_AGENT_ID} to=${toPhone}`);
  return new Response(JSON.stringify({ success: true, message_id: messageId }), { status: 200 });
});
