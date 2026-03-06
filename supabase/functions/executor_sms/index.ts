import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { generateMessage } from "../_shared/brain.ts";
import { enforceKillSwitchForTaskExecutor } from "../_shared/security.ts";

const LEASE_SECONDS = 90;

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
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

  // 1.5) Kill-switch wins over everything (TERMINAL) — unified helper
  const gate = await enforceKillSwitchForTaskExecutor(supabase, task.org_id, task_id);
  if (!gate.allow) return gate.response;

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

  // 4) Generate message — skip AI if force_content is set (human takeover)
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

  // 5) Token consumption
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

  // 6) Twilio send
  const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER")!;

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
    await supabase.from("execution_tasks").update({
      status: "failed",
      last_error: `TWILIO_FAILED: ${errorText}`,
      locked_by: null,
      locked_until: null,
    }).eq("id", task_id);

    return new Response("Twilio failed", { status: 500 });
  }

  const twilioJson = await twilioResp.json();

  // 7) Finalize
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
