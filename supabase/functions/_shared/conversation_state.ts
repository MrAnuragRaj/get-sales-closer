import { Intent } from "./intent_rules.ts";

export type Stage = 
  | "outreach" | "engaged" | "qualified" 
  | "meeting_requested" | "callback_requested" 
  | "booked" | "closed" | "dnc";

// 1. STATE TRANSITION MATRIX
// Defines how intents move leads through the funnel
function determineNewStage(currentStage: Stage, intent: Intent): Stage {
  // Terminal stages (No return)
  if (currentStage === "dnc" || currentStage === "booked" || currentStage === "closed") {
    return currentStage;
  }

  switch (intent) {
    case "unsubscribe": return "dnc";
    case "objection_hard": return "dnc"; // Soft block
    
    case "request_meeting": return "meeting_requested";
    case "request_callback": return "callback_requested";
    
    case "affirmative": 
    case "clarification_business":
    case "qualification_answer":
    case "request_pricing_details":
    case "objection_soft":
      return (currentStage === "outreach") ? "engaged" : currentStage;

    default: return currentStage;
  }
}

// 2. FACT EXTRACTION (Rule-Based First)
// Extracts budget and timeline without paying for AI
function extractFacts(text: string, currentMemory: any) {
  const t = text.toLowerCase();
  const memory = { ...currentMemory };

  // Budget Extraction (Simple Regex)
  if (/(budget|cost|price|spend).{0,20}(\$|£|€|₹)?\d+(k|m|000)?/i.test(t)) {
    // If text looks like "budget is 50k", flagging it for human review is often safer 
    // than parsing the number wrongly. We store the raw snippet or a flag.
    memory.has_discussed_budget = true;
  }

  // Timeline Extraction
  if (/(asap|now|immediately|urgent|next week|next month|tomorrow)/i.test(t)) {
    memory.timeline_signal = "urgent/near-term";
  }

  // Preference Extraction
  if (/email me/i.test(t)) memory.preferred_contact = "email";
  if (/text me|message me/i.test(t)) memory.preferred_contact = "sms";
  if (/call me|phone/i.test(t)) memory.preferred_contact = "voice";

  return memory;
}

// 🚀 MAIN FUNCTION: UPDATE STATE
export async function updateConversationState(
  supabase: any, 
  lead_id: string, 
  org_id: string, 
  intent: Intent, 
  content: string
) {
  // 1. Fetch Current State
  const { data: current } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("lead_id", lead_id)
    .maybeSingle();

  const oldStage = current?.stage || "outreach";
  const oldMemory = current?.memory_json || {};

  // 2. Calculate New Values
  const newStage = determineNewStage(oldStage as Stage, intent);
  const newMemory = extractFacts(content, oldMemory);

  // 3. Save
  const { error } = await supabase
    .from("conversation_state")
    .upsert({
      lead_id,
      org_id,
      stage: newStage,
      last_intent: intent,
      memory_json: newMemory,
      updated_at: new Date().toISOString()
    });

  if (error) console.error("State Update Failed:", error);

  return { stage: newStage, memory: newMemory };
}