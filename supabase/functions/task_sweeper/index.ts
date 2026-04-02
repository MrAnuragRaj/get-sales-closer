import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH_SIZE = 25;
const LEASE_SECONDS = 90;
const CONCURRENCY = 8;

// Dead-letter if the same error category repeats this many times in a row.
const MAX_SAME_CATEGORY_FAILURES = 3;
// Absolute ceiling — dead-letter after this many total failures regardless of category.
// Prevents infinite retry when errors alternate between categories.
const MAX_TOTAL_SWEEPER_FAILURES = 5;

function workerId() {
  return `task_sweeper:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

async function runPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (q.length) {
      const item = q.shift();
      if (!item) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function executorUrl(channel: string) {
  if (channel === "sms") return `${SUPABASE_URL}/functions/v1/executor_sms`;
  if (channel === "email") return `${SUPABASE_URL}/functions/v1/executor_email`;
  if (channel === "voice") return `${SUPABASE_URL}/functions/v1/executor_voice`;
  if (channel === "whatsapp") return `${SUPABASE_URL}/functions/v1/executor_whatsapp`;
  if (channel === "rcs") return `${SUPABASE_URL}/functions/v1/executor_rcs`;
  if (channel === "messenger") return `${SUPABASE_URL}/functions/v1/executor_messenger`;
  throw new Error(`unsupported channel=${channel}`);
}

async function callExecutor(channel: string, taskId: string, wid: string) {
  const resp = await fetch(executorUrl(channel), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ task_id: taskId, worker_id: wid }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`executor ${channel} failed ${resp.status}: ${txt}`);
  }
}

/**
 * Categorize a sweeper error string into one of four buckets.
 *
 * Used to detect same-type repeating failures so valid tasks are not
 * prematurely dead-lettered because of transient mixed-type errors.
 */
function categorizeError(errorStr: string): "network" | "db" | "provider" | "unknown" {
  const e = errorStr.toLowerCase();
  if (/fetch|network|timeout|abort|connect|econnrefused|socket/i.test(e)) return "network";
  if (/pgrst|supabase|postgres|sql|database|rpc|relation|column/i.test(e)) return "db";
  if (/twilio|vapi|resend|graph api|rbm|facebook|openai|provider|4\d\d|5\d\d/i.test(e)) return "provider";
  return "unknown";
}

/**
 * Called when callExecutor throws for a given task.
 *
 * Dead-letter rules (whichever fires first):
 *   1. Same error CATEGORY repeats MAX_SAME_CATEGORY_FAILURES (3) times — persistent issue
 *   2. Total failures reaches MAX_TOTAL_SWEEPER_FAILURES (5) — absolute ceiling
 *      (prevents infinite retry when errors alternate between categories)
 *
 * Otherwise re-queues with exponential backoff: 30s → 60s → 120s → 240s → 480s
 *
 * Emits structured logs for monitoring.
 */
async function handleSweeperFailure(
  supabase: any,
  taskId: string,
  channel: string,
  execError: string,
) {
  // Re-fetch task to get up-to-date metadata (fetch_due_tasks RPC projection
  // may not include the metadata column).
  const { data: task } = await supabase
    .from("execution_tasks")
    .select("metadata, attempt, max_attempts")
    .eq("id", taskId)
    .maybeSingle();

  const meta = (task?.metadata && typeof task.metadata === "object") ? task.metadata : {};

  const totalFailures = (meta.sweeper_total_failures ?? 0) + 1;
  const errorCategory = categorizeError(execError);

  // Reset same-category counter if category changed
  const lastCategory = meta.sweeper_last_error_category ?? null;
  const sameCategoryCount = lastCategory === errorCategory
    ? (meta.sweeper_same_category_failures ?? 0) + 1
    : 1;

  const updatedMeta = {
    ...meta,
    sweeper_total_failures: totalFailures,
    sweeper_last_error_category: errorCategory,
    sweeper_same_category_failures: sameCategoryCount,
  };

  const shouldDeadLetter =
    sameCategoryCount >= MAX_SAME_CATEGORY_FAILURES ||
    totalFailures >= MAX_TOTAL_SWEEPER_FAILURES;

  if (shouldDeadLetter) {
    const reason = sameCategoryCount >= MAX_SAME_CATEGORY_FAILURES
      ? `SAME_CATEGORY_${errorCategory.toUpperCase()}_x${sameCategoryCount}`
      : `TOTAL_FAILURES_x${totalFailures}`;

    console.error(JSON.stringify({
      level: "CRITICAL",
      event: "sweeper_task_dead_lettered",
      task_id: taskId,
      channel,
      reason,
      total_failures: totalFailures,
      same_category_failures: sameCategoryCount,
      error_category: errorCategory,
      last_exec_error: execError.slice(0, 500),
    }));

    await supabase
      .from("execution_tasks")
      .update({
        status: "dead_lettered",
        last_error: `SWEEPER_DEAD_LETTER:${reason}:${execError.slice(0, 400)}`,
        metadata: updatedMeta,
        locked_by: null,
        locked_until: null,
      })
      .in("status", ["running", "pending"])
      .eq("id", taskId);

    return;
  }

  // Exponential backoff: 30 s, 60 s, 120 s, 240 s, 480 s
  const backoffSeconds = 30 * Math.pow(2, totalFailures - 1);
  const nextAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  console.warn(JSON.stringify({
    event: "sweeper_task_backoff",
    task_id: taskId,
    channel,
    total_failures: totalFailures,
    same_category_failures: sameCategoryCount,
    error_category: errorCategory,
    backoff_seconds: backoffSeconds,
    next_scheduled_for: nextAt,
    exec_error: execError.slice(0, 300),
  }));

  await supabase
    .from("execution_tasks")
    .update({
      status: "pending",
      scheduled_for: nextAt,
      last_error: `SWEEPER_FAILURE_${totalFailures}[${errorCategory}]:${execError.slice(0, 400)}`,
      metadata: updatedMeta,
      locked_by: null,
      locked_until: null,
    })
    .in("status", ["running", "pending"])
    .eq("id", taskId);
}

/**
 * Recovers delivery_attempts that are stuck in 'pending' status.
 *
 * This happens when an executor crashes or loses connectivity after inserting
 * the delivery_attempt row but before updating it to 'sent' or 'failed'.
 *
 * Strategy:
 *   - Find delivery_attempts with status='pending' and updated_at older than ORPHAN_THRESHOLD_MINUTES
 *   - If the corresponding task is in a terminal state (succeeded/failed/dead_lettered/etc.)
 *     → the delivery_attempt is definitively orphaned: mark it 'failed' with ORPHAN_RECOVERED
 *   - If the task is still active → log as stale-pending for monitoring (don't force-fail;
 *     the task may still be executing its retry cycle)
 *
 * Called at the start of each sweep cycle so orphans are cleaned up without a dedicated cron.
 */
const ORPHAN_THRESHOLD_MINUTES = 10;
const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "dead_lettered", "skipped_terminal", "cancelled"];

async function recoverOrphanedDeliveryAttempts(supabase: any): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  const { data: stale, error } = await supabase
    .from("delivery_attempts")
    .select("id, task_id, channel, attempt_number, updated_at")
    .eq("status", "pending")
    .lt("updated_at", cutoff)
    .limit(20);

  if (error) {
    console.error(JSON.stringify({ event: "orphan_recovery_query_failed", error: error.message }));
    return;
  }

  if (!stale || stale.length === 0) return;

  for (const da of stale) {
    const { data: taskRow } = await supabase
      .from("execution_tasks")
      .select("status")
      .eq("id", da.task_id)
      .maybeSingle();

    const taskStatus = taskRow?.status ?? "unknown";

    if (TERMINAL_TASK_STATUSES.includes(taskStatus)) {
      // Task is terminal but delivery_attempt never got updated — definitively orphaned.
      const { error: updateErr } = await supabase
        .from("delivery_attempts")
        .update({
          status: "failed",
          error_code: "ORPHAN_RECOVERED",
          error_message: `Task reached ${taskStatus} but delivery_attempt was never finalized`,
        })
        .eq("id", da.id)
        .eq("status", "pending"); // guard: only update if still pending

      if (!updateErr) {
        console.warn(JSON.stringify({
          event: "delivery_attempt_orphan_recovered",
          delivery_attempt_id: da.id,
          task_id: da.task_id,
          task_status: taskStatus,
          channel: da.channel,
          attempt_number: da.attempt_number,
          stale_since: da.updated_at,
        }));
      }
    } else {
      // Task is still active — the executor may be mid-retry. Log and monitor but don't intervene.
      console.warn(JSON.stringify({
        event: "delivery_attempt_stale_pending",
        delivery_attempt_id: da.id,
        task_id: da.task_id,
        task_status: taskStatus,
        channel: da.channel,
        attempt_number: da.attempt_number,
        stale_since: da.updated_at,
        note: "delivery_attempt is stale but task is still active — monitoring only, no action taken",
      }));
    }
  }
}

serve(async (req) => {
  const supabase = getSupabaseClient(req);
  const wid = workerId();

  // Run orphaned delivery_attempts recovery at the start of each sweep cycle.
  // Best-effort: errors here must never block the main task dispatch path.
  await recoverOrphanedDeliveryAttempts(supabase).catch((e) =>
    console.error(JSON.stringify({ event: "orphan_recovery_crashed", error: String(e) }))
  );

  const { data: tasks, error } = await supabase.rpc("fetch_due_tasks", {
    p_limit: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
    p_worker_id: wid,
  });

  if (error) {
    console.error("fetch_due_tasks error:", error);
    return new Response("fetch_due_tasks failed", { status: 500 });
  }

  if (!tasks || tasks.length === 0) {
    return new Response("No due tasks", { status: 200 });
  }

  await runPool(tasks, CONCURRENCY, async (t: any) => {
    try {
      await callExecutor(t.channel, t.id, wid);
      // On success, reset ALL sweeper failure tracking fields so future failures
      // start from a clean baseline. Previously only consecutive_sweeper_failures was
      // reset — but that field is never written by handleSweeperFailure, so the reset
      // was a no-op. The actual dead-letter counters (sweeper_total_failures,
      // sweeper_same_category_failures) were never cleared, causing tasks that briefly
      // recovered to be dead-lettered prematurely on the next failure cycle.
      const { data: existingMeta } = await supabase
        .from("execution_tasks")
        .select("metadata")
        .eq("id", t.id)
        .maybeSingle();

      const meta = (existingMeta?.metadata && typeof existingMeta.metadata === "object")
        ? existingMeta.metadata : {};

      const hasSweeperState =
        (meta.sweeper_total_failures ?? 0) > 0 ||
        (meta.sweeper_same_category_failures ?? 0) > 0 ||
        meta.sweeper_last_error_category != null ||
        (meta.consecutive_sweeper_failures ?? 0) > 0;

      if (hasSweeperState) {
        await supabase
          .from("execution_tasks")
          .update({
            metadata: {
              ...meta,
              sweeper_total_failures: 0,
              sweeper_same_category_failures: 0,
              sweeper_last_error_category: null,
              consecutive_sweeper_failures: 0,
            },
          })
          .eq("id", t.id);
      }
    } catch (e) {
      // Executor is the single source of truth for marking failed/succeeded.
      // We only handle the case where the executor itself couldn't be reached.
      await handleSweeperFailure(supabase, t.id, t.channel, String(e));
    }
  });

  return new Response(`Dispatched ${tasks.length} tasks`, { status: 200 });
});
