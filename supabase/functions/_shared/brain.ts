import { outputAuditor } from "./guardrails/output_auditor.ts";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { buildPersonaBlock, PersonaSettings } from "./persona_builder.ts";

// 🛡️ MASTER PROMPT
const MASTER_SYSTEM_PROMPT = `
[CRITICAL INSTRUCTIONS - NON-NEGOTIABLE]
You are an AI Sales Liaison. You are NOT a lawyer, doctor, or financial advisor.
1. ZERO TOLERANCE: Under no circumstances provide legal opinions, medical diagnoses, or financial forecasts.
2. FRAMING: You are an "Intake Coordinator" or "Assistant". Never claim to be the primary professional.
3. CONCISENESS: SMS < 160 chars. Voice = natural speech patterns.
4. SAFETY: If user is hostile or mentions self-harm, output "STOP_INTERACTION".
5. KNOWLEDGE: If no facts are provided, explicitly say you will confirm or defer to a human. Never guess.
`;

// ⚙️ MODEL POLICY & COST GOVERNOR
const MODEL_POLICY = {
  standard: { model: "gpt-4o-mini", cost: 1 },
  premium: { model: "gpt-4o", cost: 10 },
};

// 🚦 INDUSTRY-AWARE MODEL ROUTER
// Simple yes/no/stop responses never need GPT-4o regardless of industry
const TRIVIAL_INTENTS = ["affirmative", "negative", "unsubscribe", "not_interested", "off_topic"];
// High-stakes industries where nuanced, legally-careful responses are critical
const COMPLEX_INDUSTRIES = ["law", "medical"];

function resolveModel(intent: string, industry?: string) {
  if (TRIVIAL_INTENTS.includes(intent)) {
    return MODEL_POLICY.standard;
  }

  if (industry && COMPLEX_INDUSTRIES.includes(industry)) {
    console.log(`💎 Escalating to GPT-4o: industry=${industry}, intent=${intent}`);
    return MODEL_POLICY.premium;
  }

  return MODEL_POLICY.standard;
}

export interface BrainParams {
  task_id: string;
  org_id: string;
  lead: { id: string; name: string; context?: any };
  channel: "sms" | "email" | "voice";
  intent: string;
  user_query?: string;
}

export interface BrainResponse {
  content: string;
  metadata: {
    model: string;
    prompt_version: number;
    tokens: number;
    audit_passed: boolean;
    content_hash?: string;
    intent_trace?: string;
    ai_content?: string;
    credits_used: number;
    // NOTE: executors may optionally read subject from metadata
    subject?: string;
    mode?: "ai" | "raw";
  };
  error?: string;
}

// 🔒 HELPER: Idempotency Hash
async function generateHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function checkCredits(
  supabase: any,
  org_id: string,
  required: number,
): Promise<boolean> {
  const { data } = await supabase
    .from("organizations")
    .select("ai_credits_balance")
    .eq("id", org_id)
    .single();
  return (data?.ai_credits_balance || 0) >= required;
}

// 🧠 CONTEXT BUILDER (Updated with Memory)
async function buildContext(supabase: any, org_id: string, lead_id: string) {
  // 1. Fetch Settings & Services
  const { data: settings } = await supabase
    .from("org_settings")
    .select("industry, cal_link, persona_name, tone_preset, bot_disclosure, conversion_objective, terminology_overrides")
    .eq("org_id", org_id)
    .single();
  const { data: services } = await supabase
    .from("org_services")
    .select("service_key, status")
    .eq("org_id", org_id);

  const industry = settings?.industry || "general";
  const calLink = settings?.cal_link || null;
  const hasProfessionalIntake = services?.some(
    (s: any) => s.service_key === "professional_intake" && s.status === "active",
  );
  const hasApptArchitect = services?.some(
    (s: any) => s.service_key === "appointment_architect" && s.status === "active",
  );
  const hasVoiceLiaison = services?.some(
    (s: any) => s.service_key === "voice_liaison" && s.status === "active",
  );

  // 2. Fetch MEMORY & STATE (New Logic)
  const { data: state } = await supabase
    .from("conversation_state")
    .select("stage, memory_json")
    .eq("lead_id", lead_id)
    .maybeSingle();

  // 3. Fetch SHORT-TERM WINDOW (Last 2 Inbound Messages)
  const { data: history } = await supabase
    .from("interactions")
    .select("content, created_at")
    .eq("lead_id", lead_id)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(2);

  const recentHistory =
    history?.reverse().map((h: any) => `User: "${h.content}"`).join("\n") ||
    "No recent history.";
  const memoryFacts = state?.memory_json
    ? JSON.stringify(state.memory_json)
    : "No specific facts yet.";
  const currentStage = state?.stage || "outreach";

  // 4. Define Constraints (Industry)
  let constraints = "";
  if (industry === "law") constraints += "CONSTRAINT: Do not predict case outcomes. Refer to attorney. ";
  if (industry === "medical") constraints += "CONSTRAINT: Do not give medical advice. If emergency, direct to 911. ";
  if (industry === "finance") constraints += "CONSTRAINT: No ROI guarantees. ";

  // 5. Define Feature Constraints
  if (hasProfessionalIntake) {
    constraints +=
      "STRICT MODE: You must only collect information and escalate. Do not offer advice or solutions. ";
  }

  if (hasApptArchitect && calLink) {
    constraints +=
      `GOAL: Your primary goal is to get them to book a meeting here: ${calLink}. If they agree, send the link. `;
  } else {
    constraints +=
      `CONSTRAINT: You CANNOT book meetings automatically. If they want to meet, ask for their availability and say you will have a team member contact them. `;
  }

  if (hasVoiceLiaison) {
    constraints +=
      `CAPABILITY: You can mention that a specialist can call them right now if they prefer voice. `;
  } else {
    constraints +=
      `CONSTRAINT: Do not offer an immediate callback. You can only schedule a future call. `;
  }

  // 4b. Fetch Org Knowledge Base (text rules only — PDFs not yet parsed)
  const { data: kbRules } = await supabase
    .from("knowledge_base")
    .select("title, content_text")
    .eq("org_id", org_id)
    .eq("type", "text_rule")
    .limit(10);

  const orgKnowledge = kbRules?.length
    ? "\n\nORG KNOWLEDGE BASE:\n" + kbRules.map((r: any) => `- ${r.title}: ${r.content_text}`).join("\n")
    : "";

  // Add Memory to Knowledge
  const knowledge = `
LEAD FACTS: ${memoryFacts}
CURRENT STAGE: ${currentStage}
RECENT CONTEXT:
${recentHistory}${orgKnowledge}
  `;

  return { industry, constraints, knowledge, calLink, settings };
}

// ==========================================
// 🚀 MAIN FUNCTION
// ==========================================
export async function generateMessage(
  supabase: any,
  params: BrainParams,
): Promise<BrainResponse> {
  console.log(`🧠 Brain Activated: ${params.intent} [${params.channel}]`);

  // 1. IDEMPOTENCY GUARD (locks generation)
  const { data: lockedTask } = await supabase
    .from("execution_tasks")
    .update({ ai_generation_locked: true })
    .eq("id", params.task_id)
    .eq("ai_generation_locked", false)
    .select("metadata")
    .maybeSingle();

  if (!lockedTask) {
    const { data: existing } = await supabase
      .from("execution_tasks")
      .select("metadata")
      .eq("id", params.task_id)
      .single();

    if (existing?.metadata?.content_hash) {
      console.log("♻️ Idempotency Hit");
      return { content: existing.metadata.ai_content, metadata: existing.metadata };
    }

    return {
      content: "",
      metadata: {
        model: "locked",
        prompt_version: 0,
        tokens: 0,
        audit_passed: true,
        credits_used: 0,
      },
      error: "TASK_LOCKED",
    };
  }

  // ------------------------------------------------------------------
  // ✅ RAW SEND BYPASS (strict opt-in)
  // This is ONLY activated when operator sets execution_tasks.metadata.force_raw_send = true.
  // It bypasses AI + auditor and returns metadata.body as final content.
  // ------------------------------------------------------------------
  const md = (lockedTask as any)?.metadata ?? {};
  const forceRaw = md?.force_raw_send === true;

  if (forceRaw) {
    const rawBody = typeof md?.body === "string" ? md.body.trim() : "";
    const rawSubject = typeof md?.subject === "string" ? md.subject.trim() : "";

    if (!rawBody) {
      await supabase.from("execution_tasks").update({ ai_generation_locked: false }).eq("id", params.task_id);
      return {
        content: "",
        metadata: {
          model: "raw",
          prompt_version: 0,
          tokens: 0,
          audit_passed: true,
          credits_used: 0,
          mode: "raw",
          subject: rawSubject || undefined,
        },
        error: "RAW_SEND_ENABLED_BUT_MISSING_BODY",
      };
    }

    const contentHash = await generateHash(rawBody);

    // Store idempotency metadata (same pattern as AI path)
    await supabase
      .from("execution_tasks")
      .update({
        ai_generation_locked: false,
        metadata: {
          ...md,
          model: "raw",
          prompt_version: 0,
          tokens: 0,
          audit_passed: true,
          credits_used: 0,
          content_hash: contentHash,
          intent_trace: params.intent,
          ai_content: rawBody, // keep field name for executor compatibility
          subject: rawSubject || undefined,
          mode: "raw",
        },
      })
      .eq("id", params.task_id);

    return {
      content: rawBody,
      metadata: {
        model: "raw",
        prompt_version: 0,
        tokens: 0,
        audit_passed: true,
        credits_used: 0,
        content_hash: contentHash,
        intent_trace: params.intent,
        ai_content: rawBody,
        subject: rawSubject || undefined,
        mode: "raw",
      },
    };
  }
  // ------------------------------------------------------------------

  // 2. BUILD CONTEXT (fetches industry, constraints, lead memory)
  // Must happen before resolveModel so industry is available for model selection.
  const { industry, constraints, knowledge, settings } = await buildContext(supabase, params.org_id, params.lead.id);

  // 3. RESOLVE MODEL (industry-aware dual-model routing)
  // Law/medical orgs → GPT-4o for all substantive intents.
  // All others (and trivial intents) → GPT-4o-mini.
  const selectedConfig = resolveModel(params.intent, industry);
  console.log(`🤖 Model selected: ${selectedConfig.model} (industry=${industry}, intent=${params.intent})`);

  // 4. CIRCUIT BREAKER (Dynamic Cost)
  const hasCredit = await checkCredits(supabase, params.org_id, selectedConfig.cost);
  if (!hasCredit) {
    await supabase.from("execution_tasks").update({ ai_generation_locked: false }).eq("id", params.task_id);
    return {
      content: "",
      metadata: {
        model: "error",
        prompt_version: 0,
        tokens: 0,
        audit_passed: false,
        credits_used: 0,
      },
      error: "INSUFFICIENT_CREDITS",
    };
  }

  // 5. PROMPTS
  const { data: promptConfig } = await supabase
    .from("active_org_prompts")
    .select("*")
    .eq("org_id", params.org_id)
    .eq("channel", params.channel)
    .maybeSingle();

  const persona = promptConfig?.system_prompt || "You are a helpful assistant.";
  const version = promptConfig?.version || 0;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: MASTER_SYSTEM_PROMPT },
    { role: "system", content: `RULES: ${constraints}` },
    { role: "system", content: buildPersonaBlock(settings as PersonaSettings) },
    { role: "system", content: `CUSTOM PROMPT: ${persona}` },
    { role: "system", content: `KNOWLEDGE: ${knowledge}` },
    { role: "system", content: `CONTEXT: Lead: ${params.lead.name}. Intent: ${params.intent}` },
  ];

  if (params.user_query) messages.push({ role: "user", content: params.user_query });
  else messages.push({ role: "user", content: "Generate initial outreach." });

  // 6. GENERATE
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_KEY) {
    await supabase.from("execution_tasks").update({ ai_generation_locked: false }).eq("id", params.task_id);
    return {
      content: "",
      metadata: {
        model: "error",
        prompt_version: 0,
        tokens: 0,
        audit_passed: false,
        credits_used: 0,
      },
      error: "Missing AI Key",
    };
  }

  try {
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedConfig.model,
        messages,
        temperature: 0.5,
        max_tokens: params.channel === "sms" ? 150 : 300,
      }),
    });

    const aiJson = await aiResp.json();
    if (aiJson.error) throw new Error(aiJson.error.message);

    let content = aiJson.choices[0].message.content.trim().replace(/^"|"$/g, "");

    // 7. AUDIT
    const audit = outputAuditor(content, knowledge);
    if (!audit.allowed) {
      await supabase.from("execution_tasks").update({ ai_generation_locked: false }).eq("id", params.task_id);
      return {
        content: "",
        metadata: {
          model: selectedConfig.model,
          prompt_version: version,
          tokens: 0,
          audit_passed: false,
          credits_used: 0,
          mode: "ai",
        },
        error: `Audit Failed: ${audit.reason}`,
      };
    }

    const contentHash = await generateHash(content);

    // IMPORTANT: release lock and persist metadata for idempotency
    await supabase
      .from("execution_tasks")
      .update({
        ai_generation_locked: false,
        metadata: {
          ...md,
          model: selectedConfig.model,
          prompt_version: version,
          tokens: aiJson.usage?.total_tokens || 0,
          audit_passed: true,
          credits_used: selectedConfig.cost,
          content_hash: contentHash,
          intent_trace: params.intent,
          ai_content: content,
          mode: "ai",
        },
      })
      .eq("id", params.task_id);

    return {
      content,
      metadata: {
        model: selectedConfig.model,
        prompt_version: version,
        tokens: aiJson.usage?.total_tokens || 0,
        audit_passed: true,
        content_hash: contentHash,
        intent_trace: params.intent,
        ai_content: content,
        credits_used: selectedConfig.cost,
        mode: "ai",
      },
    };
  } catch (err) {
    console.error("Brain Error:", err);
    await supabase.from("execution_tasks").update({ ai_generation_locked: false }).eq("id", params.task_id);
    return {
      content: "",
      metadata: {
        model: "error",
        prompt_version: 0,
        tokens: 0,
        audit_passed: false,
        credits_used: 0,
      },
      error: err?.message ?? String(err),
    };
  }
}

// ✅ UPDATED: getVoiceContext now requires lead_id
export async function getVoiceContext(supabase: any, org_id: string, lead_id: string) {
  const { constraints, knowledge, settings } = await buildContext(supabase, org_id, lead_id);
  const { data: promptConfig } = await supabase
    .from("active_org_prompts")
    .select("*")
    .eq("org_id", org_id)
    .eq("channel", "voice")
    .maybeSingle();

  const persona = promptConfig?.system_prompt || "You are a helpful assistant.";
  const stopInstruction =
    "CRITICAL: If user says 'Stop', 'Unsubscribe', or seems distressed, immediately say 'I understand, I will remove you from our list. Goodbye.' and hang up.";
  const fullSystemPrompt =
    `${MASTER_SYSTEM_PROMPT}\n\n${stopInstruction}\n\nRULES: ${constraints}\n\n${buildPersonaBlock(settings as PersonaSettings)}\n\nCUSTOM PROMPT: ${persona}\n\nFACTS: ${knowledge}`;
  return { systemPrompt: fullSystemPrompt, version: promptConfig?.version || 0 };
}
