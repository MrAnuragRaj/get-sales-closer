import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { inputSentry } from "../_shared/guardrails/input_sentry.ts";
import { outputAuditor } from "../_shared/guardrails/output_auditor.ts";
import { buildIsolatedPrompt } from "../_shared/guardrails/prompt_packager.ts";

// ⚙️ Same dual-model policy as brain.ts
const MODEL_POLICY = {
  standard: { model: "gpt-4o-mini" },
  premium: { model: "gpt-4o" },
};
const COMPLEX_INDUSTRIES = ["law", "medical"];

// Fetch org industry and return the appropriate model string.
// Law/medical → GPT-4o (high-stakes, nuanced answers needed).
// All others  → GPT-4o-mini (cost-efficient).
async function resolveModel(supabase: any, org_id: string): Promise<string> {
  const { data: settings } = await supabase
    .from("org_settings")
    .select("industry")
    .eq("org_id", org_id)
    .maybeSingle();

  const industry = settings?.industry || "general";

  if (COMPLEX_INDUSTRIES.includes(industry)) {
    console.log(`💎 Knowledge Brain escalating to GPT-4o: industry=${industry}`);
    return MODEL_POLICY.premium.model;
  }

  return MODEL_POLICY.standard.model;
}

serve(async (req) => {
  const { lead_id, org_id, lead_text, vault_text } = await req.json();
  const supabase = getSupabaseClient(req);

  // 1. 🛡️ Input Sentry — block prompt injection attempts
  const inputCheck = inputSentry(lead_text);
  if (!inputCheck.allowed) {
    await supabase.from("security_events").insert({
      lead_id,
      org_id: org_id ?? null,
      layer: "input_sentry",
      rule: inputCheck.reason,
      action_taken: "blocked",
      metadata: inputCheck,
    });

    return new Response(
      JSON.stringify({
        output: "I'll have our team verify that and get back to you.",
        safe: false,
      }),
      { status: 200 },
    );
  }

  // 2. 🧂 RAG Sandbox — wrap vault + lead query in salt-tagged isolation
  const salt = crypto.randomUUID().slice(0, 8);
  const prompt = buildIsolatedPrompt({
    vaultText: vault_text || "No proprietary data available.",
    leadText: lead_text,
    salt,
  });

  // 3. 🤖 Resolve model — GPT-4o for law/medical, GPT-4o-mini for all others
  const model = org_id
    ? await resolveModel(supabase, org_id)
    : MODEL_POLICY.standard.model;

  // 4. 🧠 LLM Call — real OpenAI fetch with isolated RAG prompt
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_KEY) {
    console.error("OPENAI_API_KEY not set");
    return new Response(
      JSON.stringify({
        output: "Our knowledge assistant is temporarily unavailable. A team member will follow up shortly.",
        safe: false,
      }),
      { status: 200 },
    );
  }

  let llmOutput: string;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3, // Lower temp = more faithful to vault content
        max_tokens: 300,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "Please respond to the lead query in the context above." },
        ],
      }),
    });

    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);

    llmOutput = json.choices[0].message.content.trim().replace(/^"|"$/g, "");
    console.log(`🧠 Knowledge Brain [${model}]: response generated for lead=${lead_id}`);
  } catch (err) {
    console.error("Knowledge Brain LLM Error:", err);
    return new Response(
      JSON.stringify({
        output: "Let me confirm that detail and loop in our specialist.",
        safe: false,
      }),
      { status: 200 },
    );
  }

  // 5. 🛡️ Output Auditor — ensure response is grounded in vault, no hallucinations
  const outputCheck = outputAuditor(llmOutput, vault_text || "");
  if (!outputCheck.allowed) {
    await supabase.from("security_events").insert({
      lead_id,
      org_id: org_id ?? null,
      layer: "output_auditor",
      rule: outputCheck.reason,
      action_taken: "blocked",
      metadata: outputCheck,
    });

    return new Response(
      JSON.stringify({
        output: "Let me confirm that detail and loop in the lead architect.",
        safe: false,
      }),
      { status: 200 },
    );
  }

  // 6. ✅ Success
  return new Response(
    JSON.stringify({ output: llmOutput, model, safe: true }),
    { status: 200 },
  );
});
