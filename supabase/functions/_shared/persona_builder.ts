// ============================================================
// persona_builder.ts — Vertical Lexicon / Persona Injection
// Builds a structured persona block injected into every AI
// system prompt at inference time.
// ============================================================

const TONE_DESCRIPTORS: Record<string, string> = {
  neutral_balanced:     "Be clear, concise, and helpful. Balanced tone suitable for most business contexts.",
  formal_professional:  "Use formal, professional language. Maintain a respectful tone. Avoid casual expressions or contractions.",
  warm_empathetic:      "Be compassionate and understanding. Acknowledge the person's situation before moving to business. Use warm, approachable language.",
  casual_friendly:      "Keep it conversational and friendly. Use natural, everyday language. Build rapport before pitching.",
  urgent_persuasive:    "Create a sense of urgency. Emphasize time-sensitive opportunities. Every message should move toward a decision.",
  educational_advisory: "Educate before you sell. Explain benefits clearly. Position yourself as a trusted guide, not a salesperson.",
};

const LANGUAGE_PACKS: Record<string, { consultation: string; professional: string; action_verb: string; intro_phrase: string }> = {
  law:         { consultation: "legal consultation",         professional: "attorney",            action_verb: "advise on",         intro_phrase: "on behalf of our legal team"       },
  medical:     { consultation: "medical consultation",       professional: "healthcare provider", action_verb: "help coordinate",   intro_phrase: "from our care coordination team"   },
  real_estate: { consultation: "property viewing",           professional: "real estate agent",   action_verb: "help you find",     intro_phrase: "from our property team"            },
  solar:       { consultation: "energy assessment",          professional: "solar consultant",    action_verb: "help you with",     intro_phrase: "from our energy solutions team"    },
  finance:     { consultation: "financial planning session", professional: "financial advisor",   action_verb: "guide you through", intro_phrase: "from our advisory team"            },
  general:     { consultation: "consultation",               professional: "specialist",          action_verb: "assist you with",   intro_phrase: "from our team"                     },
};

// Hardcoded — not user-editable (safety / compliance)
const COMPLIANCE_GUARDRAILS: Record<string, string> = {
  law:     "NEVER provide legal advice or predict case outcomes. ALWAYS clarify you are an intake assistant, not an attorney. If asked for legal advice say: 'I cannot provide legal advice, but I can connect you with our attorneys.'",
  medical: "NEVER diagnose, suggest treatments, or interpret medical results. ALWAYS advise urgent cases to call 911. State: 'I am an intake assistant — please consult your healthcare provider for medical questions.'",
  finance: "NEVER guarantee returns or investment outcomes. ALWAYS add: 'Past performance is not indicative of future results.' Do not provide specific investment advice.",
  solar:   "NEVER guarantee savings amounts without a formal assessment. State that actual savings depend on usage and installation conditions.",
  general: "",
};

const BOT_DISCLOSURE: Record<string, string> = {
  transparent: "If asked whether you are a bot, AI, or robot, respond honestly: 'Yes, I\\'m {name}, the AI assistant for this company. I\\'m here to help you get connected with our team quickly.'",
  deflective:  "If asked whether you are a bot, AI, or robot, redirect gracefully: 'I\\'m {name}, here to make sure you get the fastest possible response from our team. What can I help you with today?'",
};

const CONVERSION_OBJECTIVES: Record<string, string> = {
  book_appointment:          "PRIMARY GOAL: Get the lead to book an appointment. Collect their contact details so our team can schedule a time with them.",
  book_appointment_with_link:"PRIMARY GOAL: Get the lead to book an appointment. Share the booking link and confirm they have clicked it.",
  drop_cal_link:    "PRIMARY GOAL: Share the booking link early and encourage the lead to schedule immediately. Mention the link in your first or second message.",
  collect_contact:  "PRIMARY GOAL: Collect the lead's email address and phone number before ending the conversation. Do not conclude without both.",
  handoff_alert:    "PRIMARY GOAL: Qualify the lead and then signal readiness for a live human handoff. Say: 'Let me get someone from our team on the line right now.'",
};

export interface PersonaSettings {
  persona_name?: string | null;
  tone_preset?: string | null;
  bot_disclosure?: string | null;
  conversion_objective?: string | null;
  terminology_overrides?: Record<string, string> | null;
  industry?: string | null;
  cal_link?: string | null;
}

export function buildPersonaBlock(s: PersonaSettings): string {
  const name = s.persona_name || "Assistant";
  const industry = s.industry || "general";
  const pack = LANGUAGE_PACKS[industry] || LANGUAGE_PACKS.general;
  const tone = TONE_DESCRIPTORS[s.tone_preset || "neutral_balanced"] || TONE_DESCRIPTORS.neutral_balanced;
  const guardrail = COMPLIANCE_GUARDRAILS[industry] || "";
  const disclosure = (BOT_DISCLOSURE[s.bot_disclosure || "transparent"] || BOT_DISCLOSURE.transparent)
    .replace("{name}", name);
  const objKey = s.conversion_objective || "book_appointment";
  // If objective needs a booking link but cal_link is absent, use the no-link variant
  let effectiveObjKey = objKey;
  if (!s.cal_link && (objKey === "book_appointment" || objKey === "drop_cal_link")) {
    effectiveObjKey = "book_appointment"; // no-link safe variant
  } else if (s.cal_link && objKey === "book_appointment") {
    effectiveObjKey = "book_appointment_with_link";
  }
  const baseObjective = CONVERSION_OBJECTIVES[effectiveObjKey] || CONVERSION_OBJECTIVES.book_appointment;
  const objective = s.cal_link && (objKey === "book_appointment" || objKey === "drop_cal_link")
    ? `${baseObjective} Booking link: ${s.cal_link}`
    : baseObjective;

  const termLines: string[] = [
    `- Refer to consultations as "${pack.consultation}"`,
    `- Refer to professionals as "${pack.professional}"`,
  ];
  for (const [from, to] of Object.entries(s.terminology_overrides || {})) {
    if (from && to) termLines.push(`- Use "${to}" instead of "${from}"`);
  }

  return [
    `PERSONA: You are ${name}, an AI assistant ${pack.intro_phrase}.`,
    `TONE: ${tone}`,
    `TERMINOLOGY:\n${termLines.join("\n")}`,
    guardrail ? `COMPLIANCE:\n${guardrail}` : null,
    `BOT DISCLOSURE: ${disclosure}`,
    `OBJECTIVE: ${objective}`,
  ].filter(Boolean).join("\n\n");
}
