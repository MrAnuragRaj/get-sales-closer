import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH_SIZE = 25;   // your decision
const LEASE_SECONDS = 90;
const CONCURRENCY = 8;   // safe Edge default

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

serve(async (req) => {
  const supabase = getSupabaseClient(req);
  const wid = workerId();

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
    } catch (e) {
      // Executor is the single source of truth for marking failed/succeeded.
      console.error("dispatch error", t.id, e);
    }
  });

  return new Response(`Dispatched ${tasks.length} tasks`, { status: 200 });
});
