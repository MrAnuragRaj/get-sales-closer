/**
 * health_scorer.ts
 *
 * Deterministic Revenue Health scoring engine.
 *
 * Takes canonical fact arrays (from revenue_adapters.ts) and produces:
 *   - Four category scores (0–100) with raw metrics and trend deltas
 *   - An overall weighted score (0–100)
 *   - Machine-readable warnings with severity, CTA, and supporting metrics
 *
 * NO LLM involvement. Every calculation is deterministic and reproducible.
 * Scoring thresholds live in SCORING_CONFIG — configurable without code changes.
 *
 * Category weights (25% each) match the approved spec formula:
 *   overall = 0.25 × lead_response
 *           + 0.25 × conversation_quality
 *           + 0.25 × channel_health
 *           + 0.25 × conversion_health
 */

import type {
  WindowType,
  RevenueLeadFact,
  RevenueConversationFact,
  RevenueChannelFact,
  RevenueFunnelFact,
} from "./revenue_adapters.ts";

// ─────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────

export interface CategoryScore {
  category:         string;
  score:            number;                           // 0–100
  rawMetrics:       Record<string, number | null>;
  deltaVsPrevious:  number | null;                    // null if no previous-period data
  flags:            string[];
  summary:          string;
}

export interface HealthWarning {
  code:               string;
  severity:           "high" | "medium" | "low";
  category:           string;
  message:            string;
  supportingMetrics:  Record<string, number | null>;
  cta:                string;
}

export interface HealthSnapshot {
  orgId:           string;
  windowType:      WindowType;
  referenceDate:   string;
  windowStart:     string;
  windowEnd:       string;
  overallScore:    number;
  categories:      CategoryScore[];
  warnings:        HealthWarning[];
  dataConfidence:  "sufficient" | "partial" | "insufficient";
  computedAt:      string;
}

// ─────────────────────────────────────────────
// SCORING CONFIG — all thresholds in one place
// ─────────────────────────────────────────────

const SCORING_CONFIG = {
  leadResponse: {
    targetResponseMinutes:   5,      // ideal: respond within 5 min
    warningResponseMinutes:  10,     // warn above 10 min
    criticalResponseMinutes: 20,     // critical above 20 min
    targetContactedPct:      90,     // target: 90% of leads contacted
    warningUncontactedPct:   15,     // warn: >15% never contacted
    criticalUncontactedPct:  30,     // critical: >30% never contacted
  },
  conversationQuality: {
    targetReplyRatePct:      50,     // target: 50% of leads reply
    warningReplyRatePct:     30,     // warn below 30%
    criticalReplyRatePct:    15,     // critical below 15%
    targetAvgMessages:        4,     // healthy: 4+ messages per lead
    warningAvgMessages:       2,     // warn below 2
    warningOneSidedPct:      40,     // warn: >40% conversations one-sided
  },
  channelHealth: {
    targetDeliveryRatePct:   95,     // target: 95% delivered
    warningFailureRatePct:    5,     // warn above 5% failure
    criticalFailureRatePct:  15,     // critical above 15% failure
  },
  conversionHealth: {
    warningConversionDrop:   15,     // warn: score drops >15 points vs prev period
    criticalConversionDrop:  30,     // critical: score drops >30 points
    minimumLeadsForConfidence: 10,   // need 10+ leads for "sufficient" confidence
  },
  weights: {
    leadResponse:         0.25,
    conversationQuality:  0.25,
    channelHealth:        0.25,
    conversionHealth:     0.25,
  },
} as const;

// ─────────────────────────────────────────────
// MATH HELPERS
// ─────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function pct(num: number, den: number): number {
  return den === 0 ? 0 : (num / den) * 100;
}

function avg(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

/**
 * Linear interpolation scoring.
 * higherIsBetter = true:  score=100 at ideal, 0 at worst (lower bound).
 * higherIsBetter = false: score=100 at ideal (low), 0 at worst (high).
 */
function linearScore(
  value:          number,
  ideal:          number,
  worst:          number,
  higherIsBetter: boolean,
): number {
  if (higherIsBetter) {
    if (value >= ideal) return 100;
    if (value <= worst) return 0;
    return clamp(((value - worst) / (ideal - worst)) * 100);
  } else {
    if (value <= ideal) return 100;
    if (value >= worst) return 0;
    return clamp(((worst - value) / (worst - ideal)) * 100);
  }
}

// ─────────────────────────────────────────────
// CATEGORY SCORER: Lead Response Health
// ─────────────────────────────────────────────

export function scoreLeadResponse(
  leads:     RevenueLeadFact[],
  prevLeads: RevenueLeadFact[],
): CategoryScore {
  const cfg   = SCORING_CONFIG.leadResponse;
  const total = leads.length;

  if (total === 0) {
    return {
      category:        "lead_response",
      score:           100,
      rawMetrics:      { total_leads: 0, contacted: null, uncontacted_pct: null, avg_response_minutes: null, median_response_minutes: null },
      deltaVsPrevious: null,
      flags:           [],
      summary:         "No new leads in this period.",
    };
  }

  const contacted      = leads.filter((l) => l.wasContacted).length;
  const uncontacted    = total - contacted;
  const uncontactedPct = pct(uncontacted, total);
  const contactedPct   = pct(contacted, total);

  const responseTimes  = leads
    .filter((l) => l.minutesToFirstResponse !== undefined && l.minutesToFirstResponse! >= 0)
    .map((l) => l.minutesToFirstResponse!);
  const avgMinutes    = avg(responseTimes);
  const medianMinutes = median(responseTimes);

  // Three sub-scores, weighted
  const uncontactedScore  = linearScore(uncontactedPct, 0,   50,                           false);
  const responseTimeScore = avgMinutes !== null
    ? linearScore(avgMinutes, cfg.targetResponseMinutes, cfg.criticalResponseMinutes, false)
    : 100; // no data = assume healthy (no penalty for new orgs)
  const contactedScore    = linearScore(contactedPct, cfg.targetContactedPct, 50,           true);

  const score = clamp(
    uncontactedScore  * 0.40 +
    responseTimeScore * 0.40 +
    contactedScore    * 0.20,
  );

  // Previous period comparison
  const prevScore = prevLeads.length > 0
    ? _leadResponseScore(prevLeads, cfg)
    : null;

  // Flags
  const flags: string[] = [];
  if (uncontactedPct >= cfg.criticalUncontactedPct)  flags.push("critical_uncontacted_leads");
  else if (uncontactedPct >= cfg.warningUncontactedPct) flags.push("high_uncontacted_leads");
  if (avgMinutes !== null && avgMinutes >= cfg.criticalResponseMinutes) flags.push("critical_response_time");
  else if (avgMinutes !== null && avgMinutes >= cfg.warningResponseMinutes) flags.push("slow_response_time");

  const summaryParts: string[] = [];
  if (avgMinutes !== null) summaryParts.push(`Avg first response: ${avgMinutes.toFixed(1)} min.`);
  if (uncontactedPct > 5) summaryParts.push(`${uncontactedPct.toFixed(0)}% of leads never contacted.`);
  const summary = summaryParts.join(" ") || "Lead response metrics are within healthy range.";

  return {
    category: "lead_response",
    score:    Math.round(score),
    rawMetrics: {
      total_leads:              total,
      contacted,
      uncontacted,
      uncontacted_pct:          round1(uncontactedPct),
      avg_response_minutes:     round1(avgMinutes),
      median_response_minutes:  round1(medianMinutes),
    },
    deltaVsPrevious: prevScore !== null ? round1(Math.round(score) - prevScore) : null,
    flags,
    summary,
  };
}

function _leadResponseScore(leads: RevenueLeadFact[], cfg: typeof SCORING_CONFIG.leadResponse): number {
  const total     = leads.length;
  if (total === 0) return 100;
  const contacted = leads.filter((l) => l.wasContacted).length;
  const uncontPct = pct(total - contacted, total);
  const times     = leads.filter((l) => l.minutesToFirstResponse !== undefined && l.minutesToFirstResponse! >= 0).map((l) => l.minutesToFirstResponse!);
  const avgM      = avg(times);
  return clamp(
    linearScore(uncontPct, 0, 50, false) * 0.40 +
    (avgM !== null ? linearScore(avgM, cfg.targetResponseMinutes, cfg.criticalResponseMinutes, false) : 100) * 0.40 +
    linearScore(pct(contacted, total), cfg.targetContactedPct, 50, true) * 0.20,
  );
}

// ─────────────────────────────────────────────
// CATEGORY SCORER: Conversation Quality
// ─────────────────────────────────────────────

export function scoreConversationQuality(
  convs:     RevenueConversationFact[],
  prevConvs: RevenueConversationFact[],
): CategoryScore {
  const cfg = SCORING_CONFIG.conversationQuality;

  if (convs.length === 0) {
    return {
      category:        "conversation_quality",
      score:           100,
      rawMetrics:      { total_messages: 0, lead_messages: null, reply_rate_pct: null, avg_messages_per_lead: null, one_sided_pct: null },
      deltaVsPrevious: null,
      flags:           [],
      summary:         "No conversation data in this period.",
    };
  }

  const metrics     = _convQualityMetrics(convs);
  const score       = _convQualityScore(metrics, cfg);
  const prevMetrics = prevConvs.length > 0 ? _convQualityMetrics(prevConvs) : null;
  const prevScore   = prevMetrics ? _convQualityScore(prevMetrics, cfg) : null;

  const flags: string[] = [];
  if (metrics.replyRatePct < cfg.criticalReplyRatePct) flags.push("critical_low_reply_rate");
  else if (metrics.replyRatePct < cfg.warningReplyRatePct) flags.push("low_reply_rate");
  if (metrics.oneSidedPct > cfg.warningOneSidedPct)    flags.push("high_one_sided_conversations");
  if (metrics.avgOutbound < cfg.warningAvgMessages)     flags.push("weak_follow_up_sequences");

  const summary = [
    `Lead reply rate: ${metrics.replyRatePct.toFixed(0)}%.`,
    `Avg ${metrics.avgOutbound.toFixed(1)} messages sent per lead.`,
    metrics.oneSidedPct > 10 ? `${metrics.oneSidedPct.toFixed(0)}% of conversations had no lead reply.` : "",
  ].filter(Boolean).join(" ");

  return {
    category: "conversation_quality",
    score:    Math.round(score),
    rawMetrics: {
      total_messages:               convs.length,
      inbound_messages:             metrics.inboundCount,
      outbound_messages:            metrics.outboundCount,
      total_leads_in_conversation:  metrics.totalLeads,
      leads_with_reply:             metrics.leadsWithReply,
      reply_rate_pct:               round1(metrics.replyRatePct),
      avg_messages_per_lead:        round1(metrics.avgOutbound),
      one_sided_pct:                round1(metrics.oneSidedPct),
    },
    deltaVsPrevious: prevScore !== null ? round1(Math.round(score) - Math.round(prevScore)) : null,
    flags,
    summary,
  };
}

interface ConvMetrics {
  inboundCount:   number;
  outboundCount:  number;
  totalLeads:     number;
  leadsWithReply: number;
  replyRatePct:   number;
  avgOutbound:    number;
  oneSidedPct:    number;
}

function _convQualityMetrics(convs: RevenueConversationFact[]): ConvMetrics {
  const byLead = new Map<string, RevenueConversationFact[]>();
  for (const c of convs) {
    if (!byLead.has(c.leadId)) byLead.set(c.leadId, []);
    byLead.get(c.leadId)!.push(c);
  }
  const totalLeads    = byLead.size;
  const inboundCount  = convs.filter((c) => c.direction === "inbound").length;
  const outboundCount = convs.filter((c) => c.direction === "outbound").length;
  const leadsWithReply = [...byLead.values()].filter((msgs) => msgs.some((m) => m.direction === "inbound")).length;
  const replyRatePct  = pct(leadsWithReply, totalLeads);
  const outPerLead    = [...byLead.values()].map((msgs) => msgs.filter((m) => m.direction === "outbound").length);
  const avgOutbound   = avg(outPerLead) ?? 0;
  const oneSidedLeads = [...byLead.values()].filter((msgs) =>
    msgs.some((m) => m.direction === "outbound") && !msgs.some((m) => m.direction === "inbound")
  ).length;
  const oneSidedPct   = pct(oneSidedLeads, totalLeads);
  return { inboundCount, outboundCount, totalLeads, leadsWithReply, replyRatePct, avgOutbound, oneSidedPct };
}

function _convQualityScore(m: ConvMetrics, cfg: typeof SCORING_CONFIG.conversationQuality): number {
  return clamp(
    linearScore(m.replyRatePct, cfg.targetReplyRatePct, cfg.criticalReplyRatePct, true) * 0.50 +
    linearScore(m.avgOutbound,  cfg.targetAvgMessages, 1,                          true) * 0.30 +
    linearScore(m.oneSidedPct,  0, 80,                                             false) * 0.20,
  );
}

// ─────────────────────────────────────────────
// CATEGORY SCORER: Channel Health
// ─────────────────────────────────────────────

export function scoreChannelHealth(
  channels:     RevenueChannelFact[],
  prevChannels: RevenueChannelFact[],
): CategoryScore {
  const cfg = SCORING_CONFIG.channelHealth;

  if (channels.length === 0) {
    return {
      category:        "channel_health",
      score:           100,
      rawMetrics:      { total_attempts: 0 },
      deltaVsPrevious: null,
      flags:           [],
      summary:         "No delivery data in this period.",
    };
  }

  const metrics   = _channelMetrics(channels);
  const score     = _channelScore(metrics, cfg);
  const prevScore = prevChannels.length > 0
    ? _channelScore(_channelMetrics(prevChannels), cfg)
    : null;

  const flags: string[] = [];
  if (metrics.failureRatePct >= cfg.criticalFailureRatePct) flags.push("critical_delivery_failure_rate");
  else if (metrics.failureRatePct >= cfg.warningFailureRatePct) flags.push("elevated_delivery_failure_rate");

  // Per-channel flags
  for (const [ch, stats] of Object.entries(metrics.perChannel)) {
    const chFail = pct(stats.failed, stats.sent);
    if (chFail >= cfg.criticalFailureRatePct)  flags.push(`${ch}_delivery_critical`);
    else if (chFail >= cfg.warningFailureRatePct) flags.push(`${ch}_delivery_warning`);
  }

  // Build raw metrics
  const rawMetrics: Record<string, number | null> = {
    total_attempts:       channels.length,
    total_failed:         metrics.totalFailed,
    total_delivered:      metrics.totalDelivered,
    failure_rate_pct:     round1(metrics.failureRatePct),
    delivery_rate_pct:    round1(metrics.deliveryRatePct),
  };
  for (const [ch, s] of Object.entries(metrics.perChannel)) {
    rawMetrics[`${ch}_sent`]        = s.sent;
    rawMetrics[`${ch}_failed`]      = s.failed;
    rawMetrics[`${ch}_failure_pct`] = round1(pct(s.failed, s.sent));
  }

  return {
    category: "channel_health",
    score:    Math.round(score),
    rawMetrics,
    deltaVsPrevious: prevScore !== null ? round1(Math.round(score) - Math.round(prevScore)) : null,
    flags,
    summary: `Overall delivery rate ${metrics.deliveryRatePct.toFixed(0)}%. Failure rate ${metrics.failureRatePct.toFixed(1)}%.`,
  };
}

interface ChannelMetrics {
  totalFailed:     number;
  totalDelivered:  number;
  failureRatePct:  number;
  deliveryRatePct: number;
  perChannel:      Record<string, { sent: number; delivered: number; failed: number }>;
}

function _channelMetrics(channels: RevenueChannelFact[]): ChannelMetrics {
  const perChannel: Record<string, { sent: number; delivered: number; failed: number }> = {};
  for (const a of channels) {
    const ch = a.channel;
    if (!perChannel[ch]) perChannel[ch] = { sent: 0, delivered: 0, failed: 0 };
    perChannel[ch].sent++;
    if (a.status === "delivered" || a.status === "read") perChannel[ch].delivered++;
    if (a.status === "failed")                           perChannel[ch].failed++;
  }
  const totalFailed    = channels.filter((c) => c.status === "failed").length;
  const totalDelivered = channels.filter((c) => c.status === "delivered" || c.status === "read").length;
  return {
    totalFailed,
    totalDelivered,
    failureRatePct:  pct(totalFailed,    channels.length),
    deliveryRatePct: pct(totalDelivered, channels.length),
    perChannel,
  };
}

function _channelScore(m: ChannelMetrics, cfg: typeof SCORING_CONFIG.channelHealth): number {
  return clamp(
    linearScore(m.failureRatePct,  0,                          cfg.criticalFailureRatePct,  false) * 0.70 +
    linearScore(m.deliveryRatePct, cfg.targetDeliveryRatePct,  50,                          true)  * 0.30,
  );
}

// ─────────────────────────────────────────────
// CATEGORY SCORER: Conversion Health
// ─────────────────────────────────────────────

export function scoreConversionHealth(
  funnel:     RevenueFunnelFact[],
  prevFunnel: RevenueFunnelFact[],
): { score: CategoryScore; dataConfidence: "sufficient" | "partial" | "insufficient" } {
  const cfg   = SCORING_CONFIG.conversionHealth;
  const total = funnel.length;

  if (total === 0) {
    return {
      score: {
        category:        "conversion_health",
        score:           100,
        rawMetrics:      { total_leads: 0 },
        deltaVsPrevious: null,
        flags:           [],
        summary:         "No lead data available for this period.",
      },
      dataConfidence: "insufficient",
    };
  }

  const metrics   = _funnelMetrics(funnel);
  const score     = _conversionScore(metrics);
  const prevScore = prevFunnel.length > 0 ? _conversionScore(_funnelMetrics(prevFunnel)) : null;
  const delta     = prevScore !== null ? Math.round(score) - Math.round(prevScore) : null;

  const flags: string[] = [];
  if (delta !== null && delta <= -cfg.criticalConversionDrop) flags.push("critical_conversion_drop");
  else if (delta !== null && delta <= -cfg.warningConversionDrop) flags.push("conversion_declining");
  if (metrics.contactRate < 50) flags.push("low_contact_rate");
  if (metrics.replyRate < 15)   flags.push("very_low_reply_rate");

  const dataConfidence: "sufficient" | "partial" | "insufficient" =
    total >= cfg.minimumLeadsForConfidence ? "sufficient" :
    total >= 3                             ? "partial"    : "insufficient";

  const summary = [
    `${total} leads: ${metrics.contacted} contacted (${metrics.contactRate.toFixed(0)}%),`,
    `${metrics.replied} replied (${metrics.replyRate.toFixed(0)}% of contacted),`,
    `${metrics.appointed} appointments, ${metrics.closed} deals closed.`,
  ].join(" ");

  return {
    score: {
      category: "conversion_health",
      score:    Math.round(score),
      rawMetrics: {
        total_leads:             total,
        contacted:               metrics.contacted,
        replied:                 metrics.replied,
        appointments:            metrics.appointed,
        deals_closed:            metrics.closed,
        contact_rate_pct:        round1(metrics.contactRate),
        reply_rate_pct:          round1(metrics.replyRate),
        appointment_rate_pct:    round1(metrics.apptRate),
        close_rate_pct:          round1(metrics.closeRate),
        overall_conversion_pct:  round1(pct(metrics.closed, total)),
      },
      deltaVsPrevious: delta !== null ? round1(delta) : null,
      flags,
      summary,
    },
    dataConfidence,
  };
}

interface FunnelMetrics {
  contacted:   number;
  replied:     number;
  appointed:   number;
  closed:      number;
  contactRate: number;
  replyRate:   number;
  apptRate:    number;
  closeRate:   number;
}

function _funnelMetrics(funnel: RevenueFunnelFact[]): FunnelMetrics {
  const total     = funnel.length;
  const contacted = funnel.filter((f) => f.wasContacted).length;
  const replied   = funnel.filter((f) => f.hadReply).length;
  const appointed = funnel.filter((f) => f.hadAppointment).length;
  const closed    = funnel.filter((f) => f.dealClosed).length;
  return {
    contacted,
    replied,
    appointed,
    closed,
    contactRate: pct(contacted, total),
    replyRate:   pct(replied,   contacted || 1),
    apptRate:    pct(appointed, replied   || 1),
    closeRate:   pct(closed,    appointed || 1),
  };
}

function _conversionScore(m: FunnelMetrics): number {
  return clamp(
    linearScore(m.contactRate, 90, 40, true) * 0.40 +
    linearScore(m.replyRate,   50, 10, true) * 0.35 +
    linearScore(m.apptRate,    30,  5, true) * 0.25,
  );
}

// ─────────────────────────────────────────────
// OVERALL SCORE
// ─────────────────────────────────────────────

/** Weighted average of all four category scores per approved spec formula. */
export function computeOverallScore(categories: CategoryScore[]): number {
  const w   = SCORING_CONFIG.weights;
  const map = Object.fromEntries(categories.map((c) => [c.category, c.score]));
  return clamp(Math.round(
    (map["lead_response"]        ?? 100) * w.leadResponse        +
    (map["conversation_quality"] ?? 100) * w.conversationQuality +
    (map["channel_health"]       ?? 100) * w.channelHealth       +
    (map["conversion_health"]    ?? 100) * w.conversionHealth,
  ));
}

// ─────────────────────────────────────────────
// WARNING GENERATOR
// ─────────────────────────────────────────────

/** Produces de-duplicated, machine-readable warnings from all category flags. */
export function generateWarnings(categories: CategoryScore[]): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  for (const cat of categories) {
    for (const flag of cat.flags) {
      const template = WARNING_TEMPLATES[flag];
      if (template) {
        warnings.push({
          ...template,
          category:          cat.category,
          supportingMetrics: cat.rawMetrics,
        });
      }
    }

    // Auto-generate delta-based warning if score drops significantly
    if (cat.deltaVsPrevious !== null && cat.deltaVsPrevious <= -15) {
      warnings.push({
        code:               `${cat.category}_declining`,
        severity:           cat.deltaVsPrevious <= -25 ? "high" : "medium",
        category:           cat.category,
        message:            `${cat.category.replace(/_/g, " ")} score dropped ${Math.abs(cat.deltaVsPrevious).toFixed(0)} points vs previous period.`,
        supportingMetrics:  { delta: cat.deltaVsPrevious, current_score: cat.score },
        cta:                "Run Revenue Doctor",
      });
    }
  }

  // Deduplicate by code — first occurrence wins
  const seen = new Set<string>();
  return warnings.filter((w) => {
    if (seen.has(w.code)) return false;
    seen.add(w.code);
    return true;
  });
}

// ─────────────────────────────────────────────
// WARNING TEMPLATES
// ─────────────────────────────────────────────

type WarningTemplate = Omit<HealthWarning, "category" | "supportingMetrics">;

const WARNING_TEMPLATES: Record<string, WarningTemplate> = {
  critical_uncontacted_leads: {
    code:     "critical_uncontacted_leads",
    severity: "high",
    message:  "More than 30% of new leads were never contacted this period.",
    cta:      "Run Revenue Doctor",
  },
  high_uncontacted_leads: {
    code:     "high_uncontacted_leads",
    severity: "medium",
    message:  "Over 15% of new leads were never contacted.",
    cta:      "Review lead queue",
  },
  critical_response_time: {
    code:     "critical_response_time",
    severity: "high",
    message:  "Average first response time exceeds 20 minutes. Industry benchmark is <2 minutes.",
    cta:      "Run Revenue Doctor",
  },
  slow_response_time: {
    code:     "slow_response_time",
    severity: "medium",
    message:  "Average first response time exceeds 10 minutes.",
    cta:      "Enable instant AI response",
  },
  critical_low_reply_rate: {
    code:     "critical_low_reply_rate",
    severity: "high",
    message:  "Fewer than 15% of leads replied to any message this period.",
    cta:      "Run Revenue Doctor",
  },
  low_reply_rate: {
    code:     "low_reply_rate",
    severity: "medium",
    message:  "Lead reply rate is below 30%. Messaging may not be resonating.",
    cta:      "Run Revenue Doctor",
  },
  high_one_sided_conversations: {
    code:     "high_one_sided_conversations",
    severity: "medium",
    message:  "More than 40% of conversations had no lead reply.",
    cta:      "Review message templates",
  },
  weak_follow_up_sequences: {
    code:     "weak_follow_up_sequences",
    severity: "medium",
    message:  "Average follow-up sequence is below 2 messages. Industry best practice is 7+ touches.",
    cta:      "Extend follow-up campaigns",
  },
  critical_delivery_failure_rate: {
    code:     "critical_delivery_failure_rate",
    severity: "high",
    message:  "Delivery failure rate exceeds 15%. Messages are not reaching leads.",
    cta:      "Check channel configuration",
  },
  elevated_delivery_failure_rate: {
    code:     "elevated_delivery_failure_rate",
    severity: "medium",
    message:  "Delivery failure rate is above 5%.",
    cta:      "Review channel health",
  },
  critical_conversion_drop: {
    code:     "critical_conversion_drop",
    severity: "high",
    message:  "Conversion health dropped more than 30 points compared to the previous period.",
    cta:      "Run Revenue Doctor",
  },
  conversion_declining: {
    code:     "conversion_declining",
    severity: "medium",
    message:  "Conversion health is declining compared to the previous period.",
    cta:      "Run Revenue Doctor",
  },
  low_contact_rate: {
    code:     "low_contact_rate",
    severity: "high",
    message:  "Fewer than 50% of new leads were contacted.",
    cta:      "Review lead routing and automation",
  },
  very_low_reply_rate: {
    code:     "very_low_reply_rate",
    severity: "high",
    message:  "Less than 15% of contacted leads replied.",
    cta:      "Run Revenue Doctor",
  },
};

// Dynamically add per-channel delivery warning templates
for (const ch of ["sms", "whatsapp", "rcs", "messenger", "email", "voice"] as const) {
  WARNING_TEMPLATES[`${ch}_delivery_critical`] = {
    code:     `${ch}_delivery_critical`,
    severity: "high",
    message:  `${ch.toUpperCase()} delivery failure rate is critical (>15%).`,
    cta:      "Check channel configuration",
  };
  WARNING_TEMPLATES[`${ch}_delivery_warning`] = {
    code:     `${ch}_delivery_warning`,
    severity: "medium",
    message:  `${ch.toUpperCase()} delivery failure rate is elevated (>5%).`,
    cta:      "Monitor channel health",
  };
}
