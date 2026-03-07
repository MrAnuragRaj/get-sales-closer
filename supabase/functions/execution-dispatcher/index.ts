// supabase/functions/execution-dispatcher/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { enforceOrgCancellationForDispatcher } from "../_shared/security.ts";

const DEFAULT_LIMIT = 25;
const DEFAULT_LEASE_SECONDS = 90;

// Hard timeout so a stuck executor doesn't hold the dispatcher open forever
const EXECUTOR_TIMEOUT_MS = 15000;

function getBaseUrl() {
  return (Deno.env.get("GSC_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL"))!;
}

function getServiceJwt() {
  return (Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
}

function executorPath(channel: string) {
  if (channel === "sms") return "/functions/v1/executor_sms";
  if (channel === "email") return "/functions/v1/executor_email";
  if (channel === "voice") return "/functions/v1/executor_voice";
  if (channel === "whatsapp") return "/functions/v1/executor_whatsapp";
  if (channel === "rcs") return "/functions/v1/executor_rcs";
  return null;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Best-effort parse JSON from executor response; fall back to text.
 */
async function readExecutorPayload(resp: Response): Promise<{
  is_json: boolean;
  json: any | null;
  text: string;
}> {
  const text = await resp.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return { is_json: true, json: j, text };
  } catch {
    return { is_json: false, json: null, text };
  }
}

/**
 * Derive a normalized executor status for policy input:
 * - "succeeded"
 * - "failed"
 * - "no_answer"
 */
function normalizeExecutorStatus(args: {
  resp_ok: boolean;
  resp_status: number;
  parsed_json: any | null;
  raw_text: string;
}): { executor_status: "succeeded" | "failed" | "no_answer"; error: string } {
  const { resp_ok, resp_status, parsed_json, raw_text } = args;

  // Preferred contract (if your executor returns it)
  const js = parsed_json ?? {};
  const explicit = (js?.executor_status ?? js?.status ?? "").toString().toLowerCase();

  if (explicit === "no_answer") return { executor_status: "no_answer", error: "" };
  if (explicit === "succeeded" || explicit === "ok" || explicit === "success") {
    return { executor_status: "succeeded", error: "" };
  }
  if (explicit === "failed" || explicit === "error") {
    const err = (js?.error ?? js?.error_code ?? js?.reason ?? "").toString();
    return { executor_status: "failed", error: err || `EXECUTOR_${resp_status}` };
  }

  // Fallback: HTTP semantics
  if (resp_ok) return { executor_status: "succeeded", error: "" };

  const clipped = raw_text?.slice(0, 500) ?? "";
  return {
    executor_status: "failed",
    error: clipped ? `EXECUTOR_${resp_status}:${clipped}` : `EXECUTOR_${resp_status}`,
  };
}

/**
 * STRICT AUDIT INSERT:
 * If we cannot record what the autonomous system did, we FAIL-CLOSED.
 */
async function insertExecutionEventStrict(supabase: any, payload: any) {
  const { error } = await supabase.from("execution_events").insert(payload);
  if (error) {
    throw new Error(`EXECUTION_EVENT_INSERT_FAILED:${error.message}`);
  }
}

/**
 * Fail-closed helper used when audit insert fails.
 * IMPORTANT: guarded update (id + locked_by + status='running') so we don't stomp other workers.
 */
async function failClosedAudit(
  supabase: any,
  args: { taskId: string; workerId: string; reason: string },
) {
  const { taskId, workerId, reason } = args;

  await supabase
    .from("execution_tasks")
    .update({
      status: "failed_permanent",
      last_error: reason.slice(0, 2000),
      locked_by: null,
      locked_until: null,
    })
    .eq("id", taskId)
    .eq("locked_by", workerId)
    .eq("status", "running");
}

/**
 * STRICT replacement for the previous best-effort insert.
 *
 * - Attempts strict insert into execution_events
 * - If it fails -> fail-closed the task (guarded), and bubble error to caller.
 */
async function strictInsertEventOrFailClosed(args: {
  supabase: any;
  task: any;
  workerId: string;
  dispatchId: string;
  executor_http: number | null;
  executor_status: string | null;
  error: string | null;
  policy: any | null;
  from_status: string | null;
  to_status: string | null;
}) {
  const {
    supabase,
    task,
    workerId,
    dispatchId,
    executor_http,
    executor_status,
    error,
    policy,
    from_status,
    to_status,
  } = args;

  const payload = {
    task_id: task.id ?? null,
    org_id: task.org_id ?? null,
    lead_id: task.lead_id ?? null,
    plan_id: task.plan_id ?? null,

    worker_id: workerId,
    dispatch_id: dispatchId,

    executor_http,
    executor_status,
    error,

    policy_action: policy?.action ?? null,
    policy_reason: policy?.reason ?? null,
    policy_next_channel: policy?.next_channel ?? null,
    policy_delay_seconds: policy?.delay_seconds ?? null,

    from_status,
    to_status,
  };

  try {
    await insertExecutionEventStrict(supabase, payload);
  } catch (e) {
    const reason = String(e);
    // FAIL-CLOSED: make task terminal and release lease.
    await failClosedAudit(supabase, {
      taskId: String(task.id),
      workerId,
      reason,
    });
    throw e;
  }
}

/**
 * Apply policy result to execution_tasks in a SINGLE guarded update:
 * - guard: id = task_id AND locked_by = workerId AND status = 'running'
 * This makes finalization idempotent under dispatcher retries / double invokes.
 */
async function applyPolicyToTask(args: {
  supabase: any;
  workerId: string;
  task: any;
  executor_status: "succeeded" | "failed" | "no_answer";
  error: string | null;
  policy: any;
}) {
  const { supabase, workerId, task, executor_status, error, policy } = args;

  const taskId = task.id as string;

  // Success is terminal and should not go through retry policy (unless you want post-success transitions).
  if (executor_status === "succeeded") {
    const { error: updErr, data: updData } = await supabase
      .from("execution_tasks")
      .update({
        status: "succeeded",
        executed_at: new Date().toISOString(),
        last_error: null,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", taskId)
      .eq("locked_by", workerId)
      .eq("status", "running")
      .select("id,status,channel,attempt,scheduled_for")
      .maybeSingle();

    return { ok: !updErr, applied: "succeeded", update: updData ?? null, error: updErr?.message ?? null };
  }

  const apply = policy?.apply ?? null;

  // If policy is missing/malformed, fail safe: dead-letter it (finance-grade: don't loop forever).
  if (!apply || typeof apply !== "object") {
    const { error: updErr, data: updData } = await supabase
      .from("execution_tasks")
      .update({
        status: "failed_permanent",
        last_error: `POLICY_MALFORMED:${error ?? ""}`.slice(0, 2000),
        locked_by: null,
        locked_until: null,
      })
      .eq("id", taskId)
      .eq("locked_by", workerId)
      .eq("status", "running")
      .select("id,status,channel,attempt,scheduled_for")
      .maybeSingle();

    return { ok: !updErr, applied: "failed_permanent", update: updData ?? null, error: updErr?.message ?? null };
  }

  // Compute next scheduled_for (offset seconds) if requested.
  const offset = Number(apply?.scheduled_for_offset_seconds ?? 0);
  const nextScheduledFor =
    offset && Number.isFinite(offset) && offset > 0
      ? new Date(Date.now() + offset * 1000).toISOString()
      : task.scheduled_for ?? new Date().toISOString();

  // Merge metadata touch (shallow). Policy should return only what it wants to touch.
  const baseMeta = (task.metadata && typeof task.metadata === "object") ? task.metadata : {};
  const touchMeta = (apply?.touch_metadata && typeof apply.touch_metadata === "object")
    ? apply.touch_metadata
    : null;

  const mergedMeta = touchMeta ? { ...baseMeta, ...touchMeta } : baseMeta;

  // ✅ IMPORTANT: set_attempt support (authoritative if present)
  const setAttemptRaw = (apply as any)?.set_attempt;
  const hasSetAttempt = setAttemptRaw !== null && setAttemptRaw !== undefined && Number.isFinite(Number(setAttemptRaw));
  const setAttempt = hasSetAttempt ? Number(setAttemptRaw) : null;

  const nextAttempt =
    setAttempt !== null
      ? setAttempt
      : (apply?.increment_attempt ? Number(task.attempt ?? 0) + 1 : Number(task.attempt ?? 0));

  // If your policy includes next_channel, honor it.
  const nextChannel = (policy?.next_channel ?? null) as string | null;
  const nextStatus = (apply?.set_status ?? "pending") as string;

  const lastError = (error ?? policy?.error ?? "").toString();

  const updatePayload: any = {
    status: nextStatus,
    attempt: nextAttempt,
    scheduled_for: nextScheduledFor,
    metadata: mergedMeta,
    last_error: lastError ? lastError.slice(0, 2000) : null,
    locked_by: null,
    locked_until: null,
  };

  if (nextChannel) updatePayload.channel = nextChannel;

  const { error: updErr, data: updData } = await supabase
    .from("execution_tasks")
    .update(updatePayload)
    .eq("id", taskId)
    .eq("locked_by", workerId)
    .eq("status", "running")
    .select("id,status,channel,attempt,scheduled_for")
    .maybeSingle();

  return {
    ok: !updErr,
    applied: nextStatus,
    update: updData ?? null,
    error: updErr?.message ?? null,
  };
}

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  const body = await req.json().catch(() => ({}));
  const limit = Math.max(1, Number(body?.limit ?? DEFAULT_LIMIT));
  const leaseSeconds = Math.max(10, Number(body?.lease_seconds ?? DEFAULT_LEASE_SECONDS));

  const dispatchId = crypto.randomUUID();
  const workerId =
    body?.worker_id && String(body.worker_id).trim()
      ? String(body.worker_id).trim()
      : `dispatcher:${dispatchId}`;

  // DB is the single source of truth for leasable tasks.
  // fetch_due_tasks enforces kill-switch + billing-lock hard gates.
  const { data: tasks, error } = await supabase.rpc("fetch_due_tasks", {
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    p_worker_id: workerId,
  });

  if (error) {
    console.error("dispatcher_fetch_due_tasks_failed", error);
    return json(500, { status: "error", error: error.message });
  }

  const picked = (tasks ?? []) as Array<any>;
  if (picked.length === 0) {
    return json(200, {
      status: "ok",
      dispatch_id: dispatchId,
      worker_id: workerId,
      leased: 0,
      results: [],
    });
  }

  const baseUrl = getBaseUrl();
  const jwt = getServiceJwt();
  const results: any[] = [];

  for (const t of picked) {
    const taskId = t.id as string;
    const channel = (t.channel ?? "").toString();
    const path = executorPath(channel);

    const fromStatus = (t.status ?? "running").toString(); // leased rows are returned as running

    if (!path) {
      const { error: updErr } = await supabase
        .from("execution_tasks")
        .update({
          status: "failed_permanent",
          last_error: "UNKNOWN_CHANNEL",
          locked_by: null,
          locked_until: null,
        })
        .eq("id", taskId)
        .eq("locked_by", workerId)
        .eq("status", "running");

      // STRICT AUDIT (FAIL-CLOSED)
      try {
        await strictInsertEventOrFailClosed({
          supabase,
          task: t,
          workerId,
          dispatchId,
          executor_http: null,
          executor_status: "failed",
          error: "UNKNOWN_CHANNEL",
          policy: { action: "dead_letter", reason: "UNKNOWN_CHANNEL" },
          from_status: fromStatus,
          to_status: "failed_permanent",
        });
      } catch (_auditErr) {
        results.push({
          task_id: taskId,
          channel,
          fatal: true,
          reason: "AUDIT_INSERT_FAILED",
        });
        continue;
      }

      results.push({
        task_id: taskId,
        channel,
        ok: !updErr,
        executor_status: "failed",
        policy_applied: "failed_permanent",
        error: updErr?.message ?? null,
      });
      continue;
    }

    // ── Cancellation gate (Layer 2: dispatcher lease) ────────────────────────
    const cancCheck = await enforceOrgCancellationForDispatcher(supabase, t.org_id, taskId);
    if (cancCheck.action !== "allow") {
      results.push({
        task_id: taskId,
        channel,
        executor_status: "blocked",
        reason: cancCheck.reason,
      });
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);

    let execHttpStatus = 0;
    let execOk = false;
    let execText = "";
    let execJson: any | null = null;

    try {
      const resp = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          task_id: taskId,
          worker_id: workerId,
          dispatch_id: dispatchId,
        }),
      });

      execHttpStatus = resp.status;
      execOk = resp.ok;

      const payload = await readExecutorPayload(resp);
      execText = payload.text;
      execJson = payload.json;

    } catch (e) {
      execOk = false;
      execHttpStatus = 599;
      execText = `TIMEOUT_OR_NETWORK:${String(e)}`;
      execJson = null;
    } finally {
      clearTimeout(timeout);
    }

    const normalized = normalizeExecutorStatus({
      resp_ok: execOk,
      resp_status: execHttpStatus,
      parsed_json: execJson,
      raw_text: execText,
    });

    const { data: policyRes, error: policyErr } = await supabase.rpc("execution_policy_v1", {
      p_task_id: taskId,
      p_executor_status: normalized.executor_status,
      p_error: normalized.error || null,
    });

    if (policyErr) {
      const { error: updErr } = await supabase
        .from("execution_tasks")
        .update({
          status: "failed_permanent",
          last_error: `POLICY_RPC_FAILED:${policyErr.message}`.slice(0, 2000),
          locked_by: null,
          locked_until: null,
        })
        .eq("id", taskId)
        .eq("locked_by", workerId)
        .eq("status", "running");

      // STRICT AUDIT (FAIL-CLOSED)
      try {
        await strictInsertEventOrFailClosed({
          supabase,
          task: t,
          workerId,
          dispatchId,
          executor_http: execHttpStatus,
          executor_status: normalized.executor_status,
          error: normalized.error || null,
          policy: { action: "dead_letter", reason: "POLICY_RPC_FAILED" },
          from_status: fromStatus,
          to_status: "failed_permanent",
        });
      } catch (_auditErr) {
        results.push({
          task_id: taskId,
          channel,
          fatal: true,
          reason: "AUDIT_INSERT_FAILED",
        });
        continue;
      }

      results.push({
        task_id: taskId,
        channel,
        ok: !updErr,
        executor_http: execHttpStatus,
        executor_status: normalized.executor_status,
        policy_error: policyErr.message,
        policy_applied: "failed_permanent",
      });
      continue;
    }

    // RPC shape: [{ execution_policy_v1: {...} }] OR direct JSON depending on SQL
    const policy =
      Array.isArray(policyRes)
        ? (policyRes?.[0]?.execution_policy_v1 ?? policyRes?.[0] ?? null)
        : (policyRes?.execution_policy_v1 ?? policyRes ?? null);

    const applied = await applyPolicyToTask({
      supabase,
      workerId,
      task: t,
      executor_status: normalized.executor_status,
      error: normalized.error || null,
      policy,
    });

    // STRICT AUDIT (FAIL-CLOSED)
    try {
      await strictInsertEventOrFailClosed({
        supabase,
        task: t,
        workerId,
        dispatchId,
        executor_http: execHttpStatus,
        executor_status: normalized.executor_status,
        error: normalized.error || null,
        policy,
        from_status: fromStatus,
        to_status: applied.applied ?? null,
      });
    } catch (_auditErr) {
      results.push({
        task_id: taskId,
        channel,
        fatal: true,
        reason: "AUDIT_INSERT_FAILED",
      });
      continue;
    }

    results.push({
      task_id: taskId,
      channel,
      executor_http: execHttpStatus,
      executor_status: normalized.executor_status,
      policy_action: policy?.action ?? null,
      policy_reason: policy?.reason ?? null,
      policy_delay_seconds: policy?.delay_seconds ?? null,
      policy_next_channel: policy?.next_channel ?? null,
      finalization_ok: applied.ok,
      final_status: applied.applied,
      finalization_error: applied.error,
    });
  }

  return json(200, {
    status: "ok",
    dispatch_id: dispatchId,
    worker_id: workerId,
    leased: picked.length,
    results,
  });
});