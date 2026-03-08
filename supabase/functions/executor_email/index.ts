import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor, enforceOrgCancellationForTaskExecutor, enforcePlatformKillSwitchForTaskExecutor, enforceRateLimitForTaskExecutor } from "../_shared/security.ts";

const LEASE_SECONDS = 90;
const TOKEN_KEY = "sentinel.email";
const TOKEN_AMOUNT = 1;

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function asTrimmedString(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t ? t : null;
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
    .select("*, leads(name, email)")
    .eq("id", task_id)
    .single();

  if (error || !task) {
    return new Response(JSON.stringify({ error: "Task not found" }), { status: 404 });
  }

  // 1) Accept only pending/running
  if (!["pending", "running"].includes(task.status)) {
    return new Response("Task already processed", { status: 200 });
  }

  // 1.9) Platform kill switch (TERMINAL) — checked before org-level
  const platformGate = await enforcePlatformKillSwitchForTaskExecutor(supabase, task_id, "email");
  if (!platformGate.allow) return platformGate.response;

  // 2) Kill-switch enforcement (TERMINAL)
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

  // 2.1) Cancellation gate (TERMINAL)
  const cancGate = await enforceOrgCancellationForTaskExecutor(supabase, task.org_id, task_id);
  if (!cancGate.allow) return cancGate.response;

  // 3) Lease enforcement
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

  const md = task.metadata ?? {};
  const forceRaw = md?.force_raw_send === true;

  // Lead validation
  const leadName = task.leads?.name ?? "there";
  const leadEmail = task.leads?.email;

  // Allow override only when forceRaw (smoke testing / operator supplied recipient)
  const overrideToEmail = forceRaw ? asTrimmedString(md?.to_email) : null;
  const toEmail = overrideToEmail ?? leadEmail;

  if (!toEmail) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: "MISSING_LEAD_EMAIL",
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Missing lead email", { status: 500 });
  }

  // Terminal lead guard
  const { data: term, error: termErr } = await supabase.rpc("is_lead_terminal", {
    p_org_id: task.org_id,
    p_lead_id: task.lead_id,
  });

  if (termErr) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: `TERMINAL_CHECK_FAILED: ${termErr.message}`,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

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

  // actor_user_id required
  if (!task.actor_user_id) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: "MISSING_ACTOR_USER_ID",
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Missing actor_user_id", { status: 500 });
  }

  // Rate limit gate — BEFORE token consumption and before provider send
  const rlGate = await enforceRateLimitForTaskExecutor(supabase, task_id, task.org_id, "email");
  if (!rlGate.allow) return rlGate.response;

  // Generate email content (AI or RAW bypass inside brain.ts)
  const brainResult = await generateMessage(supabase, {
    task_id,
    org_id: task.org_id,
    lead: { id: task.lead_id, name: leadName },
    channel: "email",
    intent: "initial_outreach",
  });

  if (brainResult.error || !brainResult.content) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: safeString(brainResult.error ?? "AI_GENERATION_FAILED"),
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("AI generation failed", { status: 500 });
  }

  // Subject resolution:
  // - If RAW mode: prefer metadata.subject (already returned by brain metadata too)
  // - Else: keep your current fallback
  const subjectFromBrain = asTrimmedString((brainResult.metadata as any)?.subject);
  const subjectFromTask = forceRaw ? asTrimmedString(md?.subject) : null;

  const subject =
    subjectFromTask ??
    subjectFromBrain ??
    "Quick question";

  // Strip any AI-generated "Subject: ..." line the model may have prepended to the body
  const bodyText = brainResult.content.replace(/^Subject:[^\n]*\n*/i, "").trim();

  const bodyHtml = `
    <div style="font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.45;">
      <p>Hi ${leadName},</p>
      <p>${bodyText.replace(/\n/g, "<br/>")}</p>
      <p>— GetSalesCloser</p>
    </div>
  `;

  // Token consumption (kept unchanged to avoid side effects in billing/audit)
  const { data: consumeRes, error: consumeErr } = await supabase.rpc("consume_tokens_v1", {
    p_org_id: task.org_id,
    p_scope: "user",
    p_user_id: task.actor_user_id,
    p_token_key: TOKEN_KEY,
    p_amount: TOKEN_AMOUNT,
    p_idempotency_key: task_id,
    p_metadata: {
      channel: "email",
      provider: "resend",
      lead_id: task.lead_id,
      plan_id: task.plan_id,
      mode: (brainResult.metadata as any)?.mode ?? "ai",
    },
  });

  if (consumeErr) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: `TOKEN_RPC_FAILED: ${consumeErr.message}`,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Token debit RPC failed", { status: 500 });
  }

  if (!consumeRes || consumeRes.status !== "ok") {
    const reason = consumeRes?.reason ?? "TOKEN_CONSUME_DECLINED";
    await supabase
      .from("execution_tasks")
      .update({
        status: "paused_insufficient_funds",
        last_error: `TOKEN_CONSUME_DECLINED: ${reason}`,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Insufficient tokens", { status: 402 });
  }

  // Send via Resend
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  // Executor email always uses support@ per project convention (not billing@)
  const FROM_EMAIL = "support@getsalescloser.com";

  if (!RESEND_API_KEY) {
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: "MISSING_RESEND_CONFIG",
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id);

    return new Response("Missing Resend config", { status: 500 });
  }

  // Pre-send delivery attempt — idempotency guard via UNIQUE(task_id, attempt_number)
  const attemptNumber = task.attempt ?? 1;
  const { data: deliveryAttempt, error: daInsertErr } = await supabase
    .from("delivery_attempts")
    .insert({
      task_id,
      org_id: task.org_id,
      lead_id: task.lead_id,
      channel: "email",
      provider: "resend",
      status: "pending",
      attempt_number: attemptNumber,
      metadata: { from: FROM_EMAIL, to: toEmail, subject },
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique_violation — another executor instance is already handling this attempt
  if (daInsertErr?.code === "23505") {
    console.log(`[executor_email] Duplicate invocation for task ${task_id} attempt ${attemptNumber} — idempotent skip`);
    return new Response(JSON.stringify({ success: true, skipped: true, reason: "duplicate_invocation" }), { status: 200 });
  }

  const deliveryAttemptId = deliveryAttempt?.id;

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [toEmail],
        subject,
        html: bodyHtml,
        text: `Hi ${leadName},\n\n${bodyText}\n\n— GetSalesCloser`,
      }),
    });
  } catch (networkErr) {
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "NETWORK_ERROR", error_message: String(networkErr) }).eq("id", deliveryAttemptId);
    }
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: `RESEND_NETWORK_ERROR: ${String(networkErr)}`,
        locked_by: null,
        locked_until: null,
        provider: "resend",
      })
      .eq("id", task_id);
    return new Response("Network error reaching Resend", { status: 500 });
  }

  if (!res.ok) {
    const errorText = await res.text();
    if (deliveryAttemptId) {
      await supabase.from("delivery_attempts").update({ status: "failed", error_code: "RESEND_FAILED", error_message: errorText.slice(0, 500) }).eq("id", deliveryAttemptId);
    }
    await supabase
      .from("execution_tasks")
      .update({
        status: "failed",
        last_error: `RESEND_FAILED: ${errorText}`,
        locked_by: null,
        locked_until: null,
        provider: "resend",
      })
      .eq("id", task_id);

    return new Response("Email failed", { status: 500 });
  }

  const respJson = await res.json().catch(() => ({}));
  const providerId = (respJson as any)?.id ?? null;

  // Update delivery_attempt to "sent"
  if (deliveryAttemptId) {
    await supabase.from("delivery_attempts").update({
      status: "sent",
      provider_message_id: providerId,
      sent_at: new Date().toISOString(),
    }).eq("id", deliveryAttemptId);
  }

  // Log interaction
  await supabase.from("interactions").insert({
    lead_id: task.lead_id,
    org_id: task.org_id,
    user_id: task.actor_user_id,
    type: "email",
    direction: "outbound",
    content: bodyText,
    metadata: {
      provider: "resend",
      provider_id: providerId,
      subject,
      ai: brainResult.metadata ?? {},
      mode: (brainResult.metadata as any)?.mode ?? "ai",
      force_raw_send: forceRaw === true,
    },
  });

  // Finalize task
  await supabase
    .from("execution_tasks")
    .update({
      status: "succeeded",
      executed_at: new Date().toISOString(),
      provider: "resend",
      provider_id: providerId,
      locked_by: null,
      locked_until: null,
      metadata: {
        ...(task.metadata ?? {}),
        ...(brainResult.metadata ?? {}),
        subject,
        to: toEmail,
      },
    })
    .eq("id", task_id);

  // Cancel retries (email)
  await supabase.rpc("cancel_pending_retries_channel", {
    p_plan_id: task.plan_id,
    p_channel: "email",
    p_exclude_task_id: task_id,
    p_reason: "EMAIL_SUCCEEDED_CANCEL_RETRIES",
  });

  return new Response(JSON.stringify({ success: true, provider_id: providerId }), { status: 200 });
});