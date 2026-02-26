const INJECTION_PATTERNS = [
    /ignore (all )?previous instructions/i,
    /system prompt/i,
    /developer mode/i,
    /DAN\b/i,
    /jailbreak/i,
    /act as a/i
  ];
  
  export interface SentryResult {
    allowed: boolean;
    reason?: string;
    pattern?: string;
  }
  
  export function inputSentry(userText: string): SentryResult {
    if (!userText) return { allowed: true };
    const lowered = userText.toLowerCase();
  
    // 1. Regex Check
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(lowered)) {
        return {
          allowed: false,
          reason: "regex_injection_match",
          pattern: pattern.toString()
        };
      }
    }
  
    // 2. Imperative Density Heuristic
    const tokens = lowered.split(/\s+/);
    const imperatives = tokens.filter(t =>
      ["do", "give", "tell", "show", "reveal", "list", "execute"].includes(t)
    ).length;
  
    // If >25% of words are commands, block it.
    if (tokens.length > 3 && imperatives / tokens.length > 0.25) {
      return {
        allowed: false,
        reason: "instruction_density_high"
      };
    }
  
    return { allowed: true };
  }