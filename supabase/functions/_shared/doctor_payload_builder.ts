/**
 * doctor_payload_builder.ts
 *
 * Assembles the structured DiagnosticPayload for Revenue Doctor LLM generation.
 *
 * Pipeline:
 *   1. Intelligent message sampling (Change 3 spec — approved rules)
 *   2. GPT-4o-mini conversation classification (objections, intents, buying signals)
 *   3. Funnel stage analysis (deterministic)
 *   4. Automation task analysis (deterministic)
 *   5. PII-scrubbed evidence sample selection
 *   6. Full payload assembly
 *
 * The DiagnosticPayload is: (a) stored as health_snapshot + diagnostic_payload
 * in revenue_doctor_reports for audit, and (b) the input to the GPT-4o
 * diagnostic prompt in revenue-doctor-generate.
 *
 * COST CONTROLS (enforced in this module):
 *   - Max 50 messages sampled for classification
 *   - Max 10 evidence excerpts, each ≤300 chars
 *   - All excerpts PII-scrubbed before leaving this module
 *   - LLM call capped at 800 output tokens (json_object mode)
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { WindowType, DateWindow, RevenueConversationFact, RevenueFunnelFact, RevenueCampaignFact, RevenueLeadFact } from "./revenue_adapters.ts";
import type { HealthSnapshot } from "./health_scorer.ts";
import { scrubPII, truncateExcerpt } from "./pii_scrubber.ts";
import { buildTeamAttention, type TeamAttentionResult } from "./team_attention.ts";

// ─────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────

export interface ConversationIntelligence {
  topObjections:              Array<{ label: string; count: number; sharePct: number }>;
  topIntents:                 Array<{ label: string; count: number }>;
  unansweredQuestionPatterns: string[];
  buyingSignals:              string[];
  sentimentSummary:           string;
  sampleCount:                number;
  classificationModel:        string;
}

export interface FunnelInsights {
  stages: Array<{
    from:        string;
    to:          string;
    absoluteIn:  number;
    absoluteOut: number;
    rate:        number;               // percentage (0–100)
  }>;
  biggestDropOff:   string;
  dropOffRate:      number;
  dataConfidence:   "sufficient" | "partial" | "insufficient";
}

export interface AutomationInsights {
  totalTasks:       number;
  completedTasks:   number;
  failedTasks:      number;
  deadLetteredTasks: number;
  completionRate:   number;
  failureRate:      number;
  avgTasksPerLead:  number;
  channelBreakdown: Record<string, number>;
}

export interface DiagnosticPayload {
  orgId:          string;
  analysisWindow: WindowType;
  windowStart:    string;
  windowEnd:      string;
  generatedAt:    string;

  orgSummary: {
    leadsTotal:            number;
    leadsContacted:        number;
    conversationsStarted:  number;
    appointmentsBooked:    number;
    dealsClosed:           number;
    channelMix:            Record<string, number>;
    primaryChannel:        string;
  };

  healthSnapshot: {
    overallScore: number;
    categories:   Array<{
      category: string;
      score:    number;
      delta:    number | null;
      flags:    string[];
      summary:  string;
    }>;
    warnings: Array<{
      code:     string;
      severity: string;
      message:  string;
    }>;
  };

  conversationIntelligence: ConversationIntelligence;
  funnelInsights:           FunnelInsights;
  automationInsights:       AutomationInsights;

  /** Enterprise-only — present only when org_type = 'enterprise' */
  teamAttention?: TeamAttentionResult;

  evidenceSamples: Array<{
    type:      string;
    channel:   string;
    direction: string;
    excerpt:   string;              // PII-scrubbed, ≤300 chars
    leadRef:   string;              // anonymized
  }>;
}

// ─────────────────────────────────────────────
// INTELLIGENT MESSAGE SAMPLING
// Approved rules (Change 3):
//   Priority 1: Messages containing lead questions
//   Priority 2: Messages preceding conversation drop-off
//   Priority 3: Remaining substantive inbound messages
//   Excluded:   System messages, short acknowledgements, automation pings
//   Hard limit: 50 messages, GPT-4o-mini
// ─────────────────────────────────────────────

const SHORT_ACK_RE = /^(ok|okay|sure|yes|no|thanks|thank\s*you|k|got\s*it|understood|noted|👍|✅|🙏|great|perfect|sounds\s*good|alright|yep|nope|bye|hello|hi|hey|cool|nice|fine|good|np|no\s*problem|awesome|wow)\.?!?$/i;

const QUESTION_SIGNALS = [
  "?", "how ", "what ", "when ", "where ", "why ", "who ",
  "can you", "do you", "is there", "will you", "could you", "would you",
  "i want to know", "can i", "is it", "are you", "does it",
];

function isShortAck(text: string): boolean {
  const t = text.trim();
  return t.length <= 60 && SHORT_ACK_RE.test(t);
}

function hasLeadQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return QUESTION_SIGNALS.some((s) => lower.includes(s));
}

function isSystemOrAutomation(conv: RevenueConversationFact): boolean {
  return (
    conv.direction === "system" ||
    conv.actorType === "system" ||
    conv.text.trim().length < 10          // automation ping guard
  );
}

/**
 * Selects up to maxSamples inbound lead messages using approved priority tiers.
 * Input: all conversation facts for the window.
 * Output: representative sample for GPT-4o-mini classification.
 */
export function selectConversationSamples(
  convs:      RevenueConversationFact[],
  maxSamples = 50,
): RevenueConversationFact[] {
  // Filter: only substantive inbound lead messages
  const eligible = convs.filter(
    (c) =>
      c.direction === "inbound" &&
      c.actorType === "lead" &&
      !isSystemOrAutomation(c) &&
      !isShortAck(c.text) &&
      c.text.trim().length > 0,
  );

  if (eligible.length <= maxSamples) return eligible;

  // Priority tier 1 (up to 50%): Messages containing lead questions
  const tier1 = eligible.filter((c) => hasLeadQuestion(c.text));

  // Priority tier 2 (up to 30%): Last inbound message per lead (pre-drop-off signal)
  const lastInboundPerLead = new Map<string, RevenueConversationFact>();
  for (const c of eligible) {
    const existing = lastInboundPerLead.get(c.leadId);
    if (!existing || c.occurredAt > existing.occurredAt) {
      lastInboundPerLead.set(c.leadId, c);
    }
  }
  const tier2key  = (c: RevenueConversationFact) => `${c.leadId}|${c.occurredAt}`;
  const tier1keys = new Set(tier1.map(tier2key));
  const tier2     = [...lastInboundPerLead.values()].filter((c) => !tier1keys.has(tier2key(c)));

  // Slot allocation
  const t1Count = Math.min(tier1.length, Math.floor(maxSamples * 0.50));
  const t2Count = Math.min(tier2.length, Math.floor(maxSamples * 0.30));
  const t3Count = Math.max(0, maxSamples - t1Count - t2Count);

  const selectedKeys = new Set<string>();
  const result: RevenueConversationFact[] = [];

  for (const c of tier1.slice(0, t1Count)) {
    selectedKeys.add(tier2key(c));
    result.push(c);
  }
  for (const c of tier2.slice(0, t2Count)) {
    if (!selectedKeys.has(tier2key(c))) {
      selectedKeys.add(tier2key(c));
      result.push(c);
    }
  }

  // Tier 3: fill remaining slots from eligible (not already selected)
  let t3Added = 0;
  for (const c of eligible) {
    if (t3Added >= t3Count) break;
    if (!selectedKeys.has(tier2key(c))) {
      result.push(c);
      t3Added++;
    }
  }

  return result.slice(0, maxSamples);
}

// ─────────────────────────────────────────────
// CONVERSATION INTELLIGENCE ENGINE
// GPT-4o-mini — structured JSON classification
// ─────────────────────────────────────────────

export async function buildConversationIntelligence(
  samples:    RevenueConversationFact[],
  openAiKey:  string,
): Promise<ConversationIntelligence> {
  const empty: ConversationIntelligence = {
    topObjections:              [],
    topIntents:                 [],
    unansweredQuestionPatterns: [],
    buyingSignals:              [],
    sentimentSummary:           "Insufficient conversation data to analyze.",
    sampleCount:                0,
    classificationModel:        "gpt-4o-mini",
  };

  if (samples.length === 0) return empty;

  // PII-scrub and truncate all samples before sending to OpenAI
  const scrubbed = samples.map((s, i) => ({
    n:    i + 1,
    text: truncateExcerpt(scrubPII(s.text), 250),
  }));

  const prompt = `You are a revenue intelligence analyst for a B2B sales automation platform.

Analyze these ${scrubbed.length} inbound lead messages from a sales pipeline.
Each message is a real reply from a prospect to an AI sales agent.

Messages:
${scrubbed.map((s) => `[${s.n}] ${s.text}`).join("\n")}

Produce a JSON object with EXACTLY this structure (no extra text outside the JSON):
{
  "top_objections": [
    {"label": "price_concern", "count": 0},
    {"label": "timing_not_right", "count": 0},
    {"label": "trust_credibility", "count": 0},
    {"label": "competitor_comparison", "count": 0},
    {"label": "availability_fit", "count": 0},
    {"label": "commitment_concern", "count": 0},
    {"label": "budget_constraint", "count": 0}
  ],
  "top_intents": [
    {"label": "pricing_inquiry", "count": 0},
    {"label": "availability_check", "count": 0},
    {"label": "demo_request", "count": 0},
    {"label": "more_information", "count": 0},
    {"label": "ready_to_proceed", "count": 0},
    {"label": "not_interested", "count": 0},
    {"label": "scheduling", "count": 0}
  ],
  "unanswered_question_patterns": [],
  "buying_signals": [],
  "sentiment_summary": ""
}

Classification rules:
- Set count = how many of the ${scrubbed.length} messages express that objection/intent
- Keep only entries with count > 0
- unanswered_question_patterns: themes of questions that likely went unanswered (max 5 short phrases)
- buying_signals: phrases or patterns indicating genuine purchase intent (max 5)
- sentiment_summary: one precise factual sentence describing overall prospect sentiment
- Do not include vague or motivational language in sentiment_summary`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:           "gpt-4o-mini",
        messages:        [{ role: "user", content: prompt }],
        temperature:     0.1,
        max_tokens:      800,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);

    const json   = await res.json();
    const parsed = JSON.parse(json.choices[0].message.content);
    const n      = scrubbed.length;

    const topObjections = ((parsed.top_objections ?? []) as Array<{ label: string; count: number }>)
      .filter((o) => (o.count ?? 0) > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((o) => ({
        label:    o.label,
        count:    o.count,
        sharePct: Math.round((o.count / n) * 1000) / 10,
      }));

    const topIntents = ((parsed.top_intents ?? []) as Array<{ label: string; count: number }>)
      .filter((i) => (i.count ?? 0) > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((i) => ({ label: i.label, count: i.count }));

    return {
      topObjections,
      topIntents,
      unansweredQuestionPatterns: ((parsed.unanswered_question_patterns ?? []) as string[]).slice(0, 5),
      buyingSignals:              ((parsed.buying_signals ?? []) as string[]).slice(0, 5),
      sentimentSummary:           (parsed.sentiment_summary ?? "").slice(0, 300) || "No sentiment data available.",
      sampleCount:                n,
      classificationModel:        "gpt-4o-mini",
    };
  } catch (err) {
    console.error("[ConvIntel] Classification failed:", err);
    return { ...empty, sampleCount: samples.length };
  }
}

// ─────────────────────────────────────────────
// FUNNEL INSIGHTS BUILDER (deterministic)
// ─────────────────────────────────────────────

export function buildFunnelInsights(funnel: RevenueFunnelFact[]): FunnelInsights {
  const total = funnel.length;

  if (total === 0) {
    return {
      stages:         [],
      biggestDropOff: "unknown",
      dropOffRate:    0,
      dataConfidence: "insufficient",
    };
  }

  const contacted = funnel.filter((f) => f.wasContacted).length;
  const replied   = funnel.filter((f) => f.hadReply).length;
  const appointed = funnel.filter((f) => f.hadAppointment).length;
  const closed    = funnel.filter((f) => f.dealClosed).length;

  function rate(out: number, inn: number): number {
    return inn === 0 ? 0 : Math.round((out / inn) * 1000) / 10;
  }

  const stages = [
    { from: "lead_created",       to: "contacted",          absoluteIn: total,     absoluteOut: contacted, rate: rate(contacted, total)    },
    { from: "contacted",          to: "replied",            absoluteIn: contacted, absoluteOut: replied,   rate: rate(replied,   contacted) },
    { from: "replied",            to: "appointment_booked", absoluteIn: replied,   absoluteOut: appointed, rate: rate(appointed, replied)   },
    { from: "appointment_booked", to: "deal_closed",        absoluteIn: appointed, absoluteOut: closed,    rate: rate(closed,    appointed) },
  ];

  // Biggest drop-off = stage with lowest conversion rate (only stages with input > 0)
  const withData    = stages.filter((s) => s.absoluteIn > 0);
  const biggestDrop = withData.sort((a, b) => a.rate - b.rate)[0];

  return {
    stages,
    biggestDropOff: biggestDrop?.from  ?? "unknown",
    dropOffRate:    biggestDrop ? 100 - biggestDrop.rate : 0,
    dataConfidence: total >= 10 ? "sufficient" : total >= 3 ? "partial" : "insufficient",
  };
}

// ─────────────────────────────────────────────
// AUTOMATION INSIGHTS BUILDER (deterministic)
// ─────────────────────────────────────────────

export function buildAutomationInsights(campaigns: RevenueCampaignFact[]): AutomationInsights {
  const total       = campaigns.length;
  const completed   = campaigns.filter((c) => c.taskStatus === "completed").length;
  const failed      = campaigns.filter((c) => c.taskStatus === "failed_permanent" || c.taskStatus === "failed").length;
  const deadLettered = campaigns.filter((c) => c.taskStatus === "dead_lettered").length;

  const channelBreakdown: Record<string, number> = {};
  for (const c of campaigns) {
    channelBreakdown[c.channel] = (channelBreakdown[c.channel] ?? 0) + 1;
  }

  const uniqueLeads    = new Set(campaigns.map((c) => c.leadId)).size;
  const avgTasksPerLead = uniqueLeads > 0
    ? Math.round((total / uniqueLeads) * 10) / 10
    : 0;

  return {
    totalTasks:        total,
    completedTasks:    completed,
    failedTasks:       failed,
    deadLetteredTasks: deadLettered,
    completionRate:    total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
    failureRate:       total > 0 ? Math.round(((failed + deadLettered) / total) * 1000) / 10 : 0,
    avgTasksPerLead,
    channelBreakdown,
  };
}

// ─────────────────────────────────────────────
// EVIDENCE SAMPLE SELECTOR
// Diverse, PII-scrubbed excerpts for the LLM context section
// ─────────────────────────────────────────────

export function buildEvidenceSamples(
  convs:      RevenueConversationFact[],
  maxSamples = 10,
): DiagnosticPayload["evidenceSamples"] {
  // Only substantive inbound lead messages
  const candidates = convs.filter(
    (c) =>
      c.direction === "inbound" &&
      c.actorType === "lead" &&
      !isShortAck(c.text) &&
      c.text.trim().length > 30,
  );

  // Diverse selection: prefer spread across leads and channels
  const seenLeadChannel = new Set<string>();
  const selected: typeof candidates = [];

  for (const c of candidates) {
    if (selected.length >= maxSamples) break;
    const key = `${c.leadId}:${c.channel}`;
    if (!seenLeadChannel.has(key)) {
      seenLeadChannel.add(key);
      selected.push(c);
    }
  }

  // Fill remaining slots
  for (const c of candidates) {
    if (selected.length >= maxSamples) break;
    if (!selected.includes(c)) selected.push(c);
  }

  return selected.map((c) => ({
    type:      "lead_message",
    channel:   c.channel,
    direction: c.direction,
    excerpt:   truncateExcerpt(scrubPII(c.text), 300),
    leadRef:   `[LEAD_${c.leadId.slice(0, 8)}]`,
  }));
}

// ─────────────────────────────────────────────
// MAIN: BUILD DIAGNOSTIC PAYLOAD
// ─────────────────────────────────────────────

/**
 * Assembles the full DiagnosticPayload from canonical fact arrays.
 * This is called by the revenue-doctor-generate edge function after
 * all facts have been fetched and the health snapshot computed.
 *
 * @param supabase     Service-role client (for any supplementary queries)
 * @param orgId        Organization ID (all data must be pre-filtered to this org)
 * @param window       Analysis window
 * @param health       Pre-computed HealthSnapshot
 * @param convs        Conversation facts for the window
 * @param funnel       Funnel facts for the window
 * @param campaigns    Campaign/task facts for the window
 * @param openAiKey    OpenAI API key for conversation classification
 * @param leads        Lead facts (required for enterprise team analysis)
 * @param isEnterprise When true, builds per-agent TeamAttentionResult
 * @param memberMap    userId → displayName (required when isEnterprise=true)
 */
export async function buildDiagnosticPayload(
  supabase:     SupabaseClient,
  orgId:        string,
  window:       DateWindow,
  health:       HealthSnapshot,
  convs:        RevenueConversationFact[],
  funnel:       RevenueFunnelFact[],
  campaigns:    RevenueCampaignFact[],
  openAiKey:    string,
  leads?:       RevenueLeadFact[],
  isEnterprise?: boolean,
  memberMap?:   Map<string, string>,
): Promise<DiagnosticPayload> {
  // Step 1: Intelligent sampling + conversation classification (concurrent safe — read-only)
  const samples  = selectConversationSamples(convs, 50);
  const [convIntel, teamAttention] = await Promise.all([
    buildConversationIntelligence(samples, openAiKey),
    isEnterprise && leads && memberMap && memberMap.size > 0
      ? buildTeamAttention(supabase, orgId, window, leads, funnel, memberMap)
      : Promise.resolve(undefined as TeamAttentionResult | undefined),
  ]);

  // Step 2: Deterministic funnel + automation insights
  const funnelInsights     = buildFunnelInsights(funnel);
  const automationInsights = buildAutomationInsights(campaigns);

  // Step 3: PII-scrubbed evidence samples
  const evidenceSamples = buildEvidenceSamples(convs, 10);

  // Step 4: Org summary from funnel facts + conversation channel mix
  const channelMix: Record<string, number> = {};
  for (const c of convs.filter((c) => c.direction === "outbound")) {
    channelMix[c.channel] = (channelMix[c.channel] ?? 0) + 1;
  }
  const primaryChannel = Object.entries(channelMix)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  const leadsTotal         = funnel.length;
  const leadsContacted     = funnel.filter((f) => f.wasContacted).length;
  const conversationsStarted = funnel.filter((f) => f.hadReply).length;
  const appointmentsBooked = funnel.filter((f) => f.hadAppointment).length;
  const dealsClosed        = funnel.filter((f) => f.dealClosed).length;

  return {
    orgId,
    analysisWindow: window.windowType,
    windowStart:    window.windowStart.toISOString(),
    windowEnd:      window.windowEnd.toISOString(),
    generatedAt:    new Date().toISOString(),

    orgSummary: {
      leadsTotal,
      leadsContacted,
      conversationsStarted,
      appointmentsBooked,
      dealsClosed,
      channelMix,
      primaryChannel,
    },

    healthSnapshot: {
      overallScore: health.overallScore,
      categories:   health.categories.map((c) => ({
        category: c.category,
        score:    c.score,
        delta:    c.deltaVsPrevious,
        flags:    c.flags,
        summary:  c.summary,
      })),
      warnings: health.warnings.map((w) => ({
        code:     w.code,
        severity: w.severity,
        message:  w.message,
      })),
    },

    conversationIntelligence: convIntel,
    funnelInsights,
    automationInsights,
    ...(teamAttention ? { teamAttention } : {}),
    evidenceSamples,
  };
}
