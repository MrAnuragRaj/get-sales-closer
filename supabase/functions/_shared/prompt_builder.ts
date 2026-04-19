/**
 * prompt_builder.ts — shared safety guardrails + knowledge-base block.
 *
 * Purpose: ensure widget_inbound and any future channel that doesn't route
 * through brain.ts still receives the same critical compliance guardrails and
 * org knowledge-base context that SMS/email/voice channels get via brain.ts.
 *
 * Usage:
 *   import { MASTER_GUARDRAILS, buildKnowledgeBlock } from "../_shared/prompt_builder.ts";
 *
 *   const kb = await buildKnowledgeBlock(supabase, org_id);
 *   const systemPrompt = [MASTER_GUARDRAILS, personaBlock, kb, channelSpecific].filter(Boolean).join("\n\n");
 */

/**
 * Critical safety guardrails injected into every channel system prompt.
 * Mirrors MASTER_SYSTEM_PROMPT in brain.ts — keep these in sync.
 */
export const MASTER_GUARDRAILS = `[CRITICAL INSTRUCTIONS - NON-NEGOTIABLE]
You are an AI Sales Liaison. You are NOT a lawyer, doctor, or financial advisor.
1. ZERO TOLERANCE: Under no circumstances provide legal opinions, medical diagnoses, or financial forecasts.
2. FRAMING: You are an "Intake Coordinator" or "Assistant". Never claim to be the primary professional.
3. CONCISENESS: SMS < 160 chars. Voice = natural speech patterns.
4. SAFETY: If user is hostile or mentions self-harm, output "STOP_INTERACTION".
5. KNOWLEDGE: If no facts are provided, explicitly say you will confirm or defer to a human. Never guess.`;

/**
 * Fetches the org's knowledge_base (text rules, up to 10) and returns a
 * formatted block ready to include in a system prompt.
 * Returns an empty string if no rules exist.
 */
export async function buildKnowledgeBlock(supabase: any, org_id: string): Promise<string> {
  const { data: kbRules } = await supabase
    .from("knowledge_base")
    .select("title, content_text")
    .eq("org_id", org_id)
    .eq("type", "text_rule")
    .limit(10);

  if (!kbRules?.length) return "";

  return "ORG KNOWLEDGE BASE:\n" +
    kbRules.map((r: any) => `- ${r.title}: ${r.content_text}`).join("\n");
}
