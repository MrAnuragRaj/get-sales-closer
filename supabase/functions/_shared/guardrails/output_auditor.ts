// supabase/functions/_shared/guardrails/output_auditor.ts

const FORBIDDEN_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUIDs
  /\.pdf\b/i, // Internal file names
  /100%\s+guarantee/i,
  /final\s+quote/i,
  /promise\s+you/i,
];

export interface AuditResult {
  allowed: boolean;
  reason?: string;
  pattern?: string;
  debug?: Record<string, unknown>;
}

/**
 * STOPWORDS: used to avoid overlap being dominated by "the, and, is..."
 * Keep small + safe.
 */
const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","so","because","as","at","by","for","from","in","into","of","on","to","with",
  "i","you","we","they","he","she","it","me","my","your","our","their",
  "is","are","was","were","be","been","being","do","does","did","can","could","should","would","may","might","will",
  "this","that","these","those","there","here",
]);

function normalize(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // keep letters/numbers/spaces
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  const norm = normalize(text);
  if (!norm) return [];
  return norm
    .split(" ")
    .map(w => w.trim())
    .filter(w => w.length >= 3)
    .filter(w => !STOPWORDS.has(w));
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Detects "hard claims" that should be supported by retrieved context:
 * - numbers/currency/percentages
 * - dates/times
 * - absolute claims ("guarantee", "definitely") (partly covered by forbidden patterns)
 */
function hasHardClaims(sentence: string): boolean {
  const s = sentence || "";
  const hasNumberLike =
    /\b\d{1,}\b/.test(s) ||                // any number
    /\$\s?\d+/.test(s) ||                  // $100
    /\b\d+%\b/.test(s) ||                  // 20%
    /\b\d{1,2}:\d{2}\b/.test(s) ||         // 10:30
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(s) || // month words
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(s); // 12/31/2026

  return hasNumberLike;
}

/**
 * Overlap score: fraction of sentence tokens found in context tokens.
 */
function overlapScore(sentenceTokens: string[], contextTokenSet: Set<string>): number {
  if (sentenceTokens.length === 0) return 1;
  let hit = 0;
  for (const w of sentenceTokens) {
    if (contextTokenSet.has(w)) hit++;
  }
  return hit / sentenceTokens.length;
}

export function outputAuditor(outputText: string, retrievedContext: string): AuditResult {
  if (!outputText) return { allowed: true };

  // 1) Blacklist check — always enforced
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(outputText)) {
      return {
        allowed: false,
        reason: "forbidden_output_pattern",
        pattern: pattern.toString(),
      };
    }
  }

  // 2) Faithfulness check — only meaningful when we actually have usable retrieved context
  const contextTokens = unique(tokenize(retrievedContext || ""));
  const contextTokenSet = new Set(contextTokens);

  // If context is sparse, overlap checks are meaningless and will false-positive.
  // Use a fallback rule: allow general outreach language BUT block "hard claims"
  // that are not supported by context.
  const CONTEXT_MIN_TOKENS = 25; // tuneable; 25 significant tokens ~= "some real facts exist"
  const contextIsSufficient = contextTokens.length >= CONTEXT_MIN_TOKENS;

  // Split into sentences (best-effort)
  const sentences = outputText.match(/[^.!?]+[.!?]+/g) || [outputText];

  // If context is not sufficient:
  // - allow generic outreach
  // - but if a sentence contains hard claims, require at least minimal overlap with context
  if (!contextIsSufficient) {
    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (clean.length < 20) continue;

      if (hasHardClaims(clean)) {
        const stoks = tokenize(clean);
        const score = overlapScore(stoks, contextTokenSet);

        // With sparse context, we demand that hard-claim sentences match *something*
        // (even a low bar) to avoid making up numbers/dates.
        if (score < 0.25) {
          return {
            allowed: false,
            reason: "hallucination_detected_low_overlap",
            debug: {
              mode: "sparse_context_hard_claim_block",
              context_tokens: contextTokens.length,
              score,
              sentence: clean.slice(0, 160),
            },
          };
        }
      }
    }

    return { allowed: true };
  }

  // If context is sufficient:
  // enforce overlap for substantial sentences (still allowing paraphrase)
  // NOTE: your old rule was 0.6 overlap which is extremely strict.
  // 0.35 is a reasonable “faithfulness” heuristic for paraphrasing.
  const REQUIRED_OVERLAP = 0.35;

  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (clean.length < 20) continue;

    const stoks = tokenize(clean);
    const score = overlapScore(stoks, contextTokenSet);

    if (score < REQUIRED_OVERLAP) {
      return {
        allowed: false,
        reason: "hallucination_detected_low_overlap",
        debug: {
          mode: "sufficient_context_overlap_block",
          context_tokens: contextTokens.length,
          required: REQUIRED_OVERLAP,
          score,
          sentence: clean.slice(0, 160),
        },
      };
    }
  }

  return { allowed: true };
}