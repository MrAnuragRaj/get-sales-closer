/**
 * pii_scrubber.ts
 *
 * Server-side PII sanitization for Revenue Doctor diagnostic payloads.
 * All conversation excerpts pass through this module before reaching any
 * external LLM (OpenAI). No raw contact data is ever sent externally.
 *
 * Patterns covered: phone numbers, email addresses, SSN-like sequences,
 * street addresses. Lead IDs are anonymized to short tokens.
 *
 * This module has zero external dependencies — pure string manipulation.
 */

// ─────────────────────────────────────────────
// REGEX PATTERNS
// Order matters: email before phone (email contains @ which breaks phone regex)
// ─────────────────────────────────────────────

/** Matches most email formats */
const EMAIL_RE =
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Matches phone numbers in various formats:
 * +1-800-555-0100, (800) 555-0100, 800.555.0100, +918888888888
 * Guard: only replace if the digit sequence is 7–15 digits.
 */
const PHONE_RE =
  /(\+?[\d][\d\s\-().]{5,18}[\d])/g;

/** US SSN: 123-45-6789 or 123 45 6789 */
const SSN_RE =
  /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g;

/**
 * Street addresses: "123 Main Street", "45 Oak Ave", etc.
 * Conservative — only replaces if it starts with a number followed by street word.
 */
const ADDRESS_RE =
  /\b\d{1,5}\s+(?:[A-Za-z]+\s){1,4}(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Circle|Cir|Terrace|Ter)\b\.?/gi;

// Replacement tokens — clearly marked so LLM understands they are redacted
const T_EMAIL   = "[EMAIL]";
const T_PHONE   = "[PHONE]";
const T_SSN     = "[ID_NUM]";
const T_ADDRESS = "[ADDRESS]";

// ─────────────────────────────────────────────
// CORE SCRUBBER
// ─────────────────────────────────────────────

/**
 * Scrubs PII from a single text string.
 * Returns the sanitized string. Safe to call on empty/null input.
 */
export function scrubPII(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";

  return text
    // Email first — must precede phone (email has digits that confuse phone regex)
    .replace(EMAIL_RE, T_EMAIL)
    // Phone: validate digit count before replacing
    .replace(PHONE_RE, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 15 ? T_PHONE : match;
    })
    // SSN
    .replace(SSN_RE, T_SSN)
    // Street addresses
    .replace(ADDRESS_RE, T_ADDRESS);
}

/**
 * Truncates text to maxChars, appending "…" if truncated.
 * Prevents individual long messages from blowing up LLM token budgets.
 */
export function truncateExcerpt(text: string, maxChars = 300): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

// ─────────────────────────────────────────────
// CONVERSATION EXCERPT TYPE
// ─────────────────────────────────────────────

export interface ConversationExcerpt {
  leadId:     string;
  channel:    string;
  direction:  string;
  text:       string;
  occurredAt: string;
}

/**
 * Scrubs an array of conversation excerpts.
 * - Replaces lead UUIDs with short anonymized tokens.
 * - Scrubs PII from text.
 * - Truncates long messages.
 * Returns a new array — input is not mutated.
 */
export function scrubExcerpts(
  excerpts: ConversationExcerpt[],
  maxCharsPerExcerpt = 300,
): ConversationExcerpt[] {
  return excerpts.map((e) => ({
    ...e,
    // Anonymize lead ID: keep first 8 chars of UUID for internal traceability
    leadId: `[LEAD_${e.leadId.slice(0, 8)}]`,
    text: truncateExcerpt(scrubPII(e.text), maxCharsPerExcerpt),
  }));
}

/**
 * Scrubs a single text value and truncates it.
 * Convenience wrapper for single-string use cases.
 */
export function sanitize(text: string, maxChars = 300): string {
  return truncateExcerpt(scrubPII(text), maxChars);
}
