import { ruleBasedIntentClassifier, Intent } from "./intent_rules.ts";
import { aiIntentClassifier } from "./intent_ai.ts";

export async function resolveIntent(text: string): Promise<Intent> {
  if (!text) return "ambiguous";

  // Layer 1: Rules (Fast)
  const ruleIntent = ruleBasedIntentClassifier(text);
  if (ruleIntent) {
    console.log(`🧩 Intent (Rule): ${ruleIntent}`);
    return ruleIntent;
  }

  // Layer 2: AI (Smart)
  const aiIntent = await aiIntentClassifier(text);
  console.log(`🧠 Intent (AI): ${aiIntent}`);
  return aiIntent;
}