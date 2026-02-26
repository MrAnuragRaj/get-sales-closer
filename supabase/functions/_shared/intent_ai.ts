import { Intent } from "./intent_rules.ts";

export async function aiIntentClassifier(text: string): Promise<Intent> {
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_KEY) return "ambiguous";

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0, // Deterministic
        max_tokens: 50,
        messages: [
          {
            role: "system",
            content: `CLASSIFY INTENT. JSON ONLY.
ALLOWED LABELS:
- request_callback
- request_meeting
- request_pricing_details
- clarification_business
- qualification_answer
- objection_soft
- objection_hard
- affirmative
- negative
- not_interested
- unsubscribe
- off_topic
- ambiguous`
          },
          { role: "user", content: text }
        ]
      })
    });

    const json = await resp.json();
    let intent = json.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, '').toLowerCase();

    // STRICT VALIDATION LIST
    const validIntents: Intent[] = [
      "request_callback", "request_meeting", "request_pricing_details",
      "clarification_business", "qualification_answer", "objection_soft",
      "objection_hard", "affirmative", "negative", "not_interested",
      "unsubscribe", "off_topic", "ambiguous"
    ];

    return validIntents.includes(intent as Intent) ? (intent as Intent) : "ambiguous";

  } catch (error) {
    console.error("Intent AI Fail (Safe Fallback):", error);
    return "ambiguous";
  }
}