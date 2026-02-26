// supabase/functions/voice_turn/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { ruleBasedIntentClassifier } from "../_shared/intent_rules.ts";
//import { parsePhoneNumber } from "https://esm.sh/libphonenumber-js@1.10.44";
import { enforceKillSwitchForTaskExecutor } from "../_shared/security.ts";

const TOKEN_KEY = "liaison.voice";

// Per-turn debit (separate from init+final settlement). Tune later.
const TURN_TOKENS = 1;

// OpenAI model for voice turns (tune later)
const DEFAULT_MODEL = "gpt-4.1-mini";

// Security: Vapi Tool must send this header.
// Set via: supabase secrets set VAPI_TOOL_SECRET="..."
const TOOL_SECRET_HEADER = "x-gsc-tool-secret";

// TEMP: debug logging disabled to reduce latency under Vapi 20s tool timeout.
const DEBUG_LOGS_ENABLED = false;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeString(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function normalizePhone(rawPhone: string): string {
  if (!rawPhone) return "";
  let s = String(rawPhone).trim();
  s = s.replace(/[^\d+]/g, "");
  s = s.replace(/\+/g, "");
  if (rawPhone.trim().startsWith("+")) s = "+" + s;
  if (!s.startsWith("+")) s = "+1" + s;
  const digits = s.replace("+", "");
  if (!/^\d{8,15}$/.test(digits)) return s;
  return "+" + digits;
}

/**
 * Extracts call_id / turn_id / user_utterance / variableValues from common Vapi tool payload shapes.
 * We intentionally accept multiple shapes to avoid brittle integration.
 */
function parseVapiToolPayload(body: any) {
  const call_id =
    body?.call_id ??
    body?.call?.id ??
    body?.message?.call?.id ??
    body?.message?.callId ??
    null;

  // "turn_id" (toolCall id or message id) - used for idempotency keys
  const turn_id =
    body?.turn_id ??
    body?.toolCallId ??
    body?.message?.toolCallId ??
    body?.message?.id ??
    body?.id ??
    null;

  const user_utterance =
    body?.user_utterance ??
    body?.message?.transcript ??
    body?.message?.utterance ??
    body?.input ??
    body?.text ??
    "";

  // variableValues may arrive in different places:
  const variableValues =
    body?.variableValues ??
    body?.assistantOverrides?.variableValues ??
    body?.message?.assistantOverrides?.variableValues ??
    body?.message?.call?.assistantOverrides?.variableValues ??
    body?.message?.call?.assistant?.variableValues ??
    {};

  // some payloads also contain customer number
  const customer_number =
    body?.customer?.number ??
    body?.message?.customer?.number ??
    body?.message?.call?.customer?.number ??
    "";

  return { call_id, turn_id, user_utterance, variableValues, customer_number };
}

// Debug breadcrumbs (safe even when org/lead unknown)
// TEMP DISABLED: to reduce latency under Vapi tool timeout.
async function debugLog(
  supabase: any,
  call_id: string,
  turn_id: string,
  stage: string,
  detail: any = {},
) {
  if (!DEBUG_LOGS_ENABLED) return;

  try {
    await supabase.from("voice_turn_debug").insert({
      call_id,
      turn_id,
      stage,
      detail,
    });
  } catch (e) {
    // Never break production flow due to debug logging
    console.warn("voice_turn_debug_insert_failed", safeString(e));
  }
}

// BILLING LOCK CHECK
// IMPORTANT: spend surface => FAIL-CLOSED
async function isBillingLocked(supabase: any, orgId: string) {
  const { data, error } = await supabase
    .from("org_billing_profiles")
    .select("billing_lock_status")
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) {
    console.error("billing_lock_read_failed", {
      org_id: orgId,
      error: error.message,
    });
    // FAIL-CLOSED for spend surfaces
    return { locked: true as const, status: "unknown_error" as const };
  }

  const st = (data?.billing_lock_status ?? "none") as string;
  return { locked: st !== "none", status: st };
}

async function openaiReply(args: {
  apiKey: string;
  model: string;
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
}) {
  const { apiKey, model, system, history, userText } = args;

  const messages = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  // HARD TIMEOUT to stay under Vapi tool timeout (20s)
  const controller = new AbortController();
  // ✅ Reduced to 8000ms
  const timeoutMs = 8000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
      }),
    });

    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(`OPENAI_FAILED: ${resp.status} ${text}`);
    }

    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content ?? "";
    const usage = json?.usage ?? null;

    return { content, usage };
  } finally {
    clearTimeout(t);
  }
}

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  // 1) Auth gate for Vapi tool calls
  const expectedSecret = Deno.env.get("VAPI_TOOL_SECRET") ?? "";
  const gotSecret = req.headers.get(TOOL_SECRET_HEADER) ?? "";

  const body = await req.json().catch(() => ({}));
  const parsed = parseVapiToolPayload(body);

  if (!parsed.call_id) return json(400, { ok: false, error: "call_id required" });
  if (!parsed.turn_id) return json(400, { ok: false, error: "turn_id required" });

  const call_id = String(parsed.call_id);
  const turn_id = String(parsed.turn_id);
  const inboundText = String(parsed.user_utterance ?? "").trim();

  // 🔐 STRICT IDEMPOTENCY — system response replay protection
  const { data: existingSystem } = await supabase
    .from("interactions")
    .select("content")
    .eq("type", "voice")
    .eq("direction", "system")
    .eq("metadata->call_id", call_id)
    .eq("metadata->turn_id", turn_id)
    .eq("metadata->source", "voice_turn")
    .maybeSingle();

  if (existingSystem?.content) {
    return json(200, {
      ok: true,
      assistant_message: existingSystem.content,
      end_call:
        /\b(goodbye|bye|have a great day|i’ll stop|i will stop|won’t contact|will not contact)\b/i.test(
          existingSystem.content,
        ),
    });
  }

  // Debug breadcrumb: request received (disabled)
  await debugLog(supabase, call_id, turn_id, "request_start", {
    has_tool_secret_configured: !!expectedSecret,
    has_tool_secret_header: !!gotSecret,
    customer_number_hint: parsed.customer_number
      ? normalizePhone(String(parsed.customer_number))
      : null,
    inbound_len: inboundText.length,
  });

  if (expectedSecret) {
    if (gotSecret !== expectedSecret) {
      await debugLog(supabase, call_id, turn_id, "tool_secret_denied", {});
      return json(403, { ok: false, error: "UNAUTHORIZED_TOOL_CALL" });
    }
  }

  await debugLog(supabase, call_id, turn_id, "tool_secret_ok", {});

  if (!inboundText) {
    await debugLog(supabase, call_id, turn_id, "empty_inbound", {});
    return json(200, {
      ok: true,
      assistant_message: "Sorry—could you repeat that?",
      end_call: false,
    });
  }

  // 2) Resolve call context from DB
  const { data: vc } = await supabase
    .from("voice_calls")
    .select("id, org_id, lead_id, plan_id, actor_user_id, task_id, provider, provider_call_id")
    .eq("provider", "vapi")
    .eq("provider_call_id", call_id)
    .maybeSingle();

  await debugLog(supabase, call_id, turn_id, "voice_calls_lookup_done", {
    found: !!vc?.id,
  });

  const vv = parsed.variableValues ?? {};
  const org_id = vc?.org_id ?? vv?.org_id ?? null;
  const lead_id = vc?.lead_id ?? vv?.lead_id ?? null;
  const task_id = vc?.task_id ?? vv?.task_id ?? null;
  const plan_id = vc?.plan_id ?? vv?.plan_id ?? null;

  // 🔒 Derive actor safely
  let actor_user_id: string | null = null;

  if (vc?.actor_user_id) {
    actor_user_id = vc.actor_user_id;
  } else if (vv?.actor_user_id && org_id) {
    // Validate membership against org_members (your schema)
    const { data: membership } = await supabase
      .from("org_members")
      .select("user_id")
      .eq("org_id", org_id)
      .eq("user_id", vv.actor_user_id)
      .maybeSingle();

    if (!membership) {
      await debugLog(supabase, call_id, turn_id, "invalid_actor_for_org", {
        actor_user_id: vv.actor_user_id,
        org_id,
      });
      return json(403, { ok: false, error: "INVALID_ACTOR_USER_FOR_ORG" });
    }

    actor_user_id = vv.actor_user_id;
  }

  if (!org_id || !lead_id) {
    await debugLog(supabase, call_id, turn_id, "missing_org_or_lead", {
      org_id_present: !!org_id,
      lead_id_present: !!lead_id,
      has_variable_values: Object.keys(vv ?? {}).length > 0,
    });

    return json(400, {
      ok: false,
      error:
        "missing org_id/lead_id; ensure variableValues include org_id + lead_id or voice_calls row exists",
      call_id,
    });
  }

  await debugLog(supabase, call_id, turn_id, "context_resolved", {
    org_id,
    lead_id,
    task_id,
    plan_id,
    actor_user_id,
  });

  // 2.2) Kill-switch (hard gate)
  // Treat voice_turn as an executor-like surface; on block we end call politely.
  const gate = await enforceKillSwitchForTaskExecutor(supabase, org_id, task_id ?? null);
  if (!gate.allow) {
    await debugLog(supabase, call_id, turn_id, "killswitch_blocked", {
      reason: (gate as any)?.reason ?? null,
    });
    return gate.response;
  }

  await debugLog(supabase, call_id, turn_id, "killswitch_ok", {});

  // 2.3) Billing lock (hard gate) - FAIL-CLOSED already handled in helper
  const bill = await isBillingLocked(supabase, org_id);
  if (bill.locked) {
    const msg = "I can’t continue this call right now. I’ll follow up later. Goodbye.";
    await debugLog(supabase, call_id, turn_id, "billing_locked", {
      billing_lock_status: bill.status,
    });

    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: {
          provider: "vapi",
          call_id,
          turn_id,
          policy: "BILLING_LOCK",
          billing_lock_status: bill.status,
        },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  await debugLog(supabase, call_id, turn_id, "billing_ok", {});

  // 2.5) Ensure voice_calls exists (best-effort, idempotent)
  if (!vc?.id) {
    await supabase.from("voice_calls").upsert(
      {
        org_id,
        lead_id,
        plan_id: plan_id ?? null,
        actor_user_id: actor_user_id ?? null,
        provider: "vapi",
        provider_call_id: call_id,
        task_id: task_id ?? null,
        started_at: new Date().toISOString(),
      },
      { onConflict: "provider,provider_call_id" },
    );
    await debugLog(supabase, call_id, turn_id, "voice_calls_upserted", {});
  }

  // 3) Log inbound interaction
  await supabase
    .from("interactions")
    .insert({
      lead_id,
      org_id,
      user_id: actor_user_id ?? null,
      type: "voice",
      direction: "inbound",
      content: inboundText,
      metadata: {
        provider: "vapi",
        call_id,
        turn_id,
        source: "voice_turn",
      },
    })
    .select()
    .single()
    .catch(() => {
      // duplicate inbound due to retry — safe to ignore
    });

  // 4) Intent kill-switch (hard intents)
  const intent = ruleBasedIntentClassifier(inboundText);

  if (intent === "unsubscribe") {
    await supabase.rpc("apply_lead_halt_and_cancel", {
      p_org_id: org_id,
      p_lead_id: lead_id,
      p_scope: "lead",
      p_plan_id: null,
      p_channel: null,
      p_reason: "UNSUBSCRIBE",
    });

    const msg = "Understood. I’ll stop contacting you. Goodbye.";

    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: { provider: "vapi", call_id, turn_id, intent, policy: "DNC_APPLIED" },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "intent_unsubscribe", {});
    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  if (intent === "not_interested" || intent === "objection_hard") {
    await supabase.rpc("apply_lead_halt_and_cancel", {
      p_org_id: org_id,
      p_lead_id: lead_id,
      p_scope: "lead",
      p_plan_id: null,
      p_channel: null,
      p_reason: intent === "not_interested" ? "NOT_INTERESTED" : "OBJECTION_HARD",
    });

    const msg = "Got it. I won’t bother you again. Take care.";

    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: { provider: "vapi", call_id, turn_id, intent, policy: "LEAD_HALTED" },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "intent_hard_stop", { intent });
    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  // 5) Terminal guard
  const { data: term, error: termErr } = await supabase.rpc("is_lead_terminal", {
    p_org_id: org_id,
    p_lead_id: lead_id,
  });

  if (termErr) {
    const msg = "Sorry—something went wrong on my side. I’ll follow up later.";
    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: {
          provider: "vapi",
          call_id,
          turn_id,
          error: termErr.message,
          policy: "TERMINAL_CHECK_FAILED",
        },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "terminal_check_failed", {
      error: termErr.message,
    });
    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  if (term?.[0]?.is_terminal) {
    const msg = "Thanks. I’ll leave it there. Goodbye.";
    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: {
          provider: "vapi",
          call_id,
          turn_id,
          policy: "SKIPPED_TERMINAL",
          reason: term?.[0]?.reason ?? null,
        },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "terminal_blocked", {
      reason: term?.[0]?.reason ?? null,
    });
    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  // 6) Per-turn token debit (idempotent)
  if (actor_user_id) {
    const turnIdem = `voice_turn:${call_id}:${turn_id}`;
    const { data: consumeRes, error: consumeErr } = await supabase.rpc("consume_tokens_v1", {
      p_org_id: org_id,
      p_scope: "user",
      p_user_id: actor_user_id,
      p_token_key: TOKEN_KEY,
      p_amount: TURN_TOKENS,
      p_idempotency_key: turnIdem,
      p_metadata: {
        phase: "turn",
        channel: "voice",
        provider: "vapi",
        call_id,
        turn_id,
        lead_id,
        plan_id,
        task_id,
      },
    });

    if (consumeErr || !consumeRes || consumeRes.status !== "ok") {
      const msg = "I can’t continue this call right now. I’ll follow up later. Goodbye.";
      await supabase
        .from("interactions")
        .insert({
          lead_id,
          org_id,
          user_id: actor_user_id,
          type: "voice",
          direction: "system",
          content: msg,
          metadata: {
            provider: "vapi",
            call_id,
            turn_id,
            policy: "TURN_TOKEN_DECLINED",
            consume_error: consumeErr?.message ?? null,
            consume_reason: consumeRes?.reason ?? null,
          },
        })
        .select()
        .single()
        .catch(() => {
          // duplicate system insert due to retry — safe to ignore
        });

      await debugLog(supabase, call_id, turn_id, "turn_token_declined", {
        consume_error: consumeErr?.message ?? null,
        consume_reason: consumeRes?.reason ?? null,
      });

      return json(200, { ok: true, assistant_message: msg, end_call: true });
    }
  }

  await debugLog(supabase, call_id, turn_id, "turn_token_ok", {
    actor_user_id_present: !!actor_user_id,
  });

  // 7) Build AI system prompt
  const seedSystemPrompt = String(vv?.system_prompt ?? "").trim();

  // Pull lightweight history from interactions (voice only)
  const { data: historyRows } = await supabase
    .from("interactions")
    .select("direction, content, created_at")
    .eq("org_id", org_id)
    .eq("lead_id", lead_id)
    .eq("type", "voice")
    .order("created_at", { ascending: true })
    // ✅ Reduced from 30 -> 15
    .limit(15);

  const history = (historyRows ?? [])
    .filter((r: any) => typeof r?.content === "string" && r.content.length > 0)
    .map((r: any) => {
      const role = r.direction === "inbound" ? "user" : "assistant";
      return { role, content: r.content as string };
    }) as Array<{ role: "user" | "assistant"; content: string }>;

  const policyWrapper = `
You are an AI voice sales liaison for GetSalesCloser.
Rules:
- Be concise, helpful, calm, and non-pushy.
- Never claim to be a human.
- If the user asks to stop / unsubscribe / not interested: end politely and stop.
- Do not generate illegal, harmful, or sensitive personal data.
- If unsure, ask a short clarification question.
- Output ONLY the words to say on the phone (no markdown, no labels).
`.trim();

  const system = seedSystemPrompt
    ? `${policyWrapper}\n\n--- BUSINESS TALK-TRACK / CONTEXT ---\n${seedSystemPrompt}`
    : policyWrapper;

  // 8) Call OpenAI
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    const msg = "I’m having a temporary system issue. I’ll follow up later. Goodbye.";
    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: { provider: "vapi", call_id, turn_id, error: "MISSING_OPENAI_API_KEY" },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "missing_openai_key", {});
    return json(200, { ok: true, assistant_message: msg, end_call: true });
  }

  let assistantMessage = "";
  let usage: any = null;

  await debugLog(supabase, call_id, turn_id, "openai_request_start", { model: DEFAULT_MODEL });

  try {
    const res = await openaiReply({
      apiKey,
      model: DEFAULT_MODEL,
      system,
      history,
      userText: inboundText,
    });
    assistantMessage = String(res.content ?? "").trim();
    usage = res.usage ?? null;

    await debugLog(supabase, call_id, turn_id, "openai_request_ok", {
      usage,
      assistant_len: assistantMessage.length,
    });
  } catch (e) {
    // IMPORTANT: do NOT end the call automatically on transient LLM issues.
    const msg = "Sorry—I'm having a brief system issue. Can I call you back later today or tomorrow?";

    await supabase
      .from("interactions")
      .insert({
        lead_id,
        org_id,
        user_id: actor_user_id ?? null,
        type: "voice",
        direction: "system",
        content: msg,
        metadata: {
          provider: "vapi",
          call_id,
          turn_id,
          error: safeString(e),
          policy: "OPENAI_FAILED_FALLBACK",
        },
      })
      .select()
      .single()
      .catch(() => {
        // duplicate system insert due to retry — safe to ignore
      });

    await debugLog(supabase, call_id, turn_id, "openai_request_failed", {
      error: safeString(e),
    });

    return json(200, { ok: true, assistant_message: msg, end_call: false });
  }

  if (!assistantMessage) assistantMessage = "Understood. Could you tell me a bit more?";

  const end_call =
    /\b(goodbye|bye|have a great day|i’ll stop|i will stop|won’t contact|will not contact)\b/i.test(
      assistantMessage,
    );

  // 10) Log assistant reply
  await supabase
    .from("interactions")
    .insert({
      lead_id,
      org_id,
      user_id: actor_user_id ?? null,
      type: "voice",
      direction: "system",
      content: assistantMessage,
      metadata: {
        provider: "vapi",
        call_id,
        turn_id,
        source: "voice_turn",
        model: DEFAULT_MODEL,
        usage,
        prompt_version: vv?.prompt_version ?? null,
        policy: "PASS",
      },
    })
    .select()
    .single()
    .catch(() => {
      // duplicate system insert due to retry — safe to ignore
    });

  await debugLog(supabase, call_id, turn_id, "response_sent", { end_call });

  return json(200, { ok: true, assistant_message: assistantMessage, end_call });
});