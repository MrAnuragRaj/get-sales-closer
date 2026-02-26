export type Intent =
  | "request_callback"
  | "request_meeting"
  | "request_pricing_details" // ✅ NEW: Money specific
  | "clarification_business"
  | "qualification_answer"
  | "objection_soft"
  | "objection_hard"
  | "affirmative"
  | "negative"
  | "not_interested"
  | "unsubscribe"
  | "off_topic"
  | "ambiguous";

export function ruleBasedIntentClassifier(text: string): Intent | null {
  const t = text.toLowerCase().trim();

  // 1. PRIORITY: LEGAL COMPLIANCE
  if (/(stop|unsubscribe|cancel|remove me|do not contact|don't contact|opt out)/i.test(t)) {
    return "unsubscribe";
  }

  // 2. PRIORITY: ACTIONS
  if (/(call me|phone call|can you call|talk on phone|give me a call|speak to someone)/i.test(t)) {
    return "request_callback";
  }
  if (/(book|schedule|calendar|time to meet|zoom|appointment|availability)/i.test(t)) {
    return "request_meeting";
  }

  // 3. PRIORITY: PRICING (Specific)
  if (/(how much|price|cost|fee|rate|quote|billing|charge|expensive|payment)/i.test(t)) {
    // If they say "too expensive", it's an objection. If "how much", it's a request.
    if (/(too|very|so) (expensive|much|high)/i.test(t)) return "objection_soft";
    return "request_pricing_details";
  }

  // 4. PRIORITY: OBJECTIONS
  if (/(scam|fraud|waste of time|leave me alone|harassment|stop calling)/i.test(t)) {
    return "objection_hard";
  }
  if (/(not interested|pass|no thanks|not looking|good set)/i.test(t)) {
    return "not_interested";
  }

  // 5. GENERAL
  if (/^(yes|yeah|yep|sure|ok|okay|correct)$/i.test(t)) return "affirmative";
  if (/^(no|nah|nope)$/i.test(t)) return "negative";

  // 6. DOMAIN LOCK
  if (/(explain|what is|solve|calculate).*(relativity|physics|math|quantum|history|recipe)/i.test(t)) {
    return "off_topic";
  }

  return null; // Fallback to AI
}