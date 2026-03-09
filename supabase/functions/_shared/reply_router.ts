import { resolveIntent, Intent } from "./intent_resolver.ts";
import { updateConversationState } from "./conversation_state.ts";

// Helper: Check Entitlements
async function getEntitlements(supabase: any, org_id: string) {
  const { data } = await supabase
    .from("org_services")
    .select("service_key, status")
    .eq("org_id", org_id);

  const active = (key: string) =>
    data?.some((s: any) => s.service_key === key && s.status === "active");

  return {
    voice: active("voice"),
    architect: active("architect"),
  };
}

type ExecChannel = "sms" | "voice" | "email";

/**
 * ✅ Create Task (STRICT)
 * Fail-closed unless we have actor_user_id and plan_id.
 * Also writes fully-formed scheduling fields.
 */
async function createExecutionTaskStrict(
  supabase: any,
  args: {
    org_id: string;
    lead_id: string;
    channel: ExecChannel;
    intent: string;
    actor_user_id: string;
    plan_id: string;
    scheduled_for?: string;
    metadata?: Record<string, any>;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const {
    org_id,
    lead_id,
    channel,
    intent,
    actor_user_id,
    plan_id,
    scheduled_for,
    metadata,
  } = args;

  // 1) DNC guard
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("is_dnc")
    .eq("id", lead_id)
    .single();

  if (leadErr) return { ok: false, reason: `LEAD_READ_FAILED:${leadErr.message}` };
  if (lead?.is_dnc) {
    console.log("🛑 Blocked by DNC: Task Creation Skipped");
    return { ok: false, reason: "LEAD_IS_DNC" };
  }

  // 2) HARD REQUIREMENTS (fail-closed)
  if (!actor_user_id) return { ok: false, reason: "MISSING_ACTOR_USER_ID" };
  if (!plan_id) return { ok: false, reason: "MISSING_PLAN_ID" };

  // 3) Insert fully-formed task
  const nowIso = new Date().toISOString();
  const sched = scheduled_for ?? nowIso;

  const { error } = await supabase.from("execution_tasks").insert({
    org_id,
    lead_id,
    plan_id,
    actor_user_id,
    channel,
    status: "pending",
    attempt: 1,
    max_attempts: 3,
    scheduled_for: sched,
    metadata: {
      ...(metadata ?? {}),
      source: "reply_router",
      intent_trace: intent,
    },
  });

  return error ? { ok: false, reason: error.message } : { ok: true };
}

// 🚀 MAIN ROUTER FUNCTION
export async function replyRouter(params: {
  supabase: any;
  org_id: string;
  lead_id: string;
  inbound_text: string;
  channel_source: "sms" | "voice" | "whatsapp" | "rcs" | "messenger";
  // Required for execution_tasks — omit only when resolving from webhook (actor/plan resolved inside)
  actor_user_id?: string;
  plan_id?: string;
}) {
  const { supabase, org_id, lead_id, inbound_text, channel_source, actor_user_id, plan_id } =
    params;

  // 0) AI Paused guard — human has taken over, skip all AI routing
  const { data: pauseCheck } = await supabase
    .from("leads")
    .select("ai_paused")
    .eq("id", lead_id)
    .single();
  if (pauseCheck?.ai_paused) {
    console.log(`⏸️ AI paused for lead ${lead_id} — skipping reply_router`);
    return;
  }

  // 1) Resolve Intent
  const intent: Intent = await resolveIntent(inbound_text);

  // 2) Update Memory & State
  console.log(`📝 Updating State for Lead ${lead_id}...`);
  const stateResult = await updateConversationState(supabase, lead_id, org_id, intent, inbound_text);

  // Kill-switch like behavior via state: DNC
  if (stateResult.stage === "dnc") {
    console.log("🛑 Lead transitioned to DNC. Halting execution.");
    return;
  }

  const entitlements = await getEntitlements(supabase, org_id);
  console.log(`📍 Routing Intent: ${intent} | Stage: ${stateResult.stage} | Source: ${channel_source}`);

  // Safety: if caller did not supply required fields, fail-closed and notify
  if (!actor_user_id || !plan_id) {
    await supabase.from("notifications").insert({
      org_id,
      lead_id,
      type: "router_missing_fields",
      message: `reply_router refused to create task (missing actor_user_id/plan_id). intent=${intent}`,
    });
    return;
  }

  // 3) Route based on Business Logic
  // Reply on the same channel the lead used — voice inbound triggers SMS reply (can't re-initiate call)
  const replyChannel: "sms" | "whatsapp" | "rcs" | "messenger" =
    channel_source === "whatsapp" || channel_source === "rcs" || channel_source === "messenger"
      ? channel_source
      : "sms";

  switch (intent) {
    case "unsubscribe":
      await supabase.from("leads").update({ is_dnc: true }).eq("id", lead_id);
      return;

    case "request_callback":
      if (entitlements.voice) {
        await createExecutionTaskStrict(supabase, {
          org_id,
          lead_id,
          channel: "voice",
          intent,
          actor_user_id,
          plan_id,
          metadata: { source: "inbound_request", channel_source },
        });
      } else {
        await supabase.from("notifications").insert({
          org_id,
          lead_id,
          type: "callback_requested",
          message: "Lead requested call but Voice Liaison is OFF.",
        });
        await createExecutionTaskStrict(supabase, {
          org_id,
          lead_id,
          channel: replyChannel,
          intent,
          actor_user_id,
          plan_id,
          metadata: { source: "inbound_request_fallback_sms", channel_source },
        });
      }
      break;

    case "request_meeting":
      if (!entitlements.architect) {
        await supabase.from("notifications").insert({
          org_id,
          lead_id,
          type: "meeting_requested",
          message: "Lead requested meeting but Appt Architect is OFF.",
        });
      }
      await createExecutionTaskStrict(supabase, {
        org_id,
        lead_id,
        channel: replyChannel,
        intent,
        actor_user_id,
        plan_id,
        metadata: { source: "meeting_request", channel_source },
      });
      break;

    case "request_pricing_details":
    case "objection_hard":
    case "off_topic":
    default:
      if (intent === "objection_hard") {
        await supabase.from("notifications").insert({
          org_id,
          lead_id,
          type: "hostile_lead",
          message: `Lead hostile: "${inbound_text}"`,
        });
      }

      await createExecutionTaskStrict(supabase, {
        org_id,
        lead_id,
        channel: replyChannel,
        intent,
        actor_user_id,
        plan_id,
        metadata: { channel_source },
      });
      break;
  }
}