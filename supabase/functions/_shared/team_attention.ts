/**
 * team_attention.ts
 *
 * Enterprise-only: per-agent performance rollup for Revenue Doctor reports.
 *
 * Computes per-user metrics from:
 *   - leads.assigned_to (which leads belong to this agent)
 *   - interactions.user_id (messages personally sent by this agent)
 *   - interactions.direction='inbound' (lead replies on those leads)
 *
 * Flag definitions (all counts are per-agent, per-window):
 *   slow_response:    leads where agent's first response came > 4h after first inbound reply
 *   no_response:      leads with ≥1 inbound reply but agent sent zero messages
 *   high_intent_loss: leads with high-purchase-intent signal, no appointment booked
 *   pricing_leak:     leads with pricing signal detected, no appointment booked
 *   booking_weakness: leads with ≥1 inbound reply but no appointment booked
 *   one_sided:        leads where agent sent ≥3 msgs but lead replied ≤1 time
 *
 * Priority score formula:
 *   25*slow_response + 20*no_response + 20*high_intent_loss + 15*pricing_leak
 *   + 10*booking_weakness + 10*one_sided + min(10, floor(leadsAssigned/2))
 *
 * Buckets:
 *   immediate_attention: score ≥ 60
 *   coaching:            score 35–59, or score < 35 with no deals closed
 *   top_performer:       score < 35 AND eligible AND dealsClosed > 0
 *   insufficient_data:   leadsAssigned < 10 OR conversationsStarted < 5
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { DateWindow, RevenueLeadFact, RevenueFunnelFact } from "./revenue_adapters.ts";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const SLOW_RESPONSE_THRESHOLD_MIN = 240;  // 4 hours
const MIN_LEADS_FOR_RANKING       = 10;
const MIN_CONVS_FOR_RANKING       = 5;

const HIGH_INTENT_INTENTS = new Set([
  "ready_to_proceed", "demo_request", "scheduling", "availability_check",
]);

const PRICING_TERMS = [
  "price", "pricing", "cost", "budget", "afford", "expensive",
  "cheap", "fee", "rate", "quote", "payment", "charge",
];

// ─────────────────────────────────────────────
// OUTPUT TYPES
// ─────────────────────────────────────────────

export interface AgentMetrics {
  userId:               string;
  displayName:          string;
  leadsAssigned:        number;
  conversationsStarted: number;
  dealsClosed:          number;
  avgResponseMinutes:   number | null;

  // Flag counts (each = number of leads where this flag fired)
  slowResponseCount:    number;
  noResponseCount:      number;
  highIntentLossCount:  number;
  pricingLeakCount:     number;
  bookingWeaknessCount: number;
  oneSidedCount:        number;

  // Derived
  priorityScore:        number;
  bucket:               "immediate_attention" | "coaching" | "top_performer" | "insufficient_data";
}

export interface TeamAttentionResult {
  totalAgents:        number;
  eligibleAgents:     number;
  immediateAttention: AgentMetrics[];
  coaching:           AgentMetrics[];
  topPerformers:      AgentMetrics[];
  insufficientData:   AgentMetrics[];
  windowSummary:      string;
}

// ─────────────────────────────────────────────
// INTERNAL PER-LEAD SUMMARY
// ─────────────────────────────────────────────

interface LeadSummary {
  leadId:               string;
  assignedTo:           string | null;
  inboundCount:         number;
  firstInboundAt:       string | null;
  inboundIntents:       Set<string>;
  inboundTexts:         string[];
  // Per human agent: how many messages sent and when was the first
  agentMsgCount:        Map<string, number>;
  agentFirstSentAt:     Map<string, string>;
  hadAppointment:       boolean;
  dealClosed:           boolean;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function hasPricingSignal(texts: string[]): boolean {
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (PRICING_TERMS.some((t) => lower.includes(t))) return true;
  }
  return false;
}

function computePriorityScore(m: Omit<AgentMetrics, "priorityScore" | "bucket">): number {
  return (
    25 * m.slowResponseCount   +
    20 * m.noResponseCount     +
    20 * m.highIntentLossCount +
    15 * m.pricingLeakCount    +
    10 * m.bookingWeaknessCount +
    10 * m.oneSidedCount       +
    Math.min(10, Math.floor(m.leadsAssigned / 2))
  );
}

function classifyBucket(
  score:                number,
  leadsAssigned:        number,
  conversationsStarted: number,
  dealsClosed:          number,
): AgentMetrics["bucket"] {
  if (leadsAssigned < MIN_LEADS_FOR_RANKING || conversationsStarted < MIN_CONVS_FOR_RANKING) {
    return "insufficient_data";
  }
  if (score >= 60) return "immediate_attention";
  if (score >= 35) return "coaching";
  return dealsClosed > 0 ? "top_performer" : "coaching";
}

// ─────────────────────────────────────────────
// MAIN: BUILD TEAM ATTENTION
// ─────────────────────────────────────────────

/**
 * Builds per-agent performance metrics for enterprise Revenue Doctor reports.
 *
 * @param supabase   Service-role client
 * @param orgId      Organization ID
 * @param window     Analysis window (for interaction query bounds)
 * @param leads      RevenueLeadFact[] — already fetched, used for assigned_to
 * @param funnel     RevenueFunnelFact[] — already fetched, used for appointment/deal flags
 * @param memberMap  userId → displayName (full_name || email)
 */
export async function buildTeamAttention(
  supabase:  SupabaseClient,
  orgId:     string,
  window:    DateWindow,
  leads:     RevenueLeadFact[],
  funnel:    RevenueFunnelFact[],
  memberMap: Map<string, string>,
): Promise<TeamAttentionResult> {
  const empty: TeamAttentionResult = {
    totalAgents:        memberMap.size,
    eligibleAgents:     0,
    immediateAttention: [],
    coaching:           [],
    topPerformers:      [],
    insufficientData:   [],
    windowSummary:      "Insufficient data to compute team performance metrics.",
  };

  if (leads.length === 0 || memberMap.size === 0) return empty;

  // ── 1. Fetch interactions for this org/window in parallel ─────────────────
  // Two targeted queries: human outbound (for agent attribution) + inbound (for lead signals)
  const [{ data: humanOutRows }, { data: inboundRows }] = await Promise.all([
    supabase
      .from("interactions")
      .select("lead_id, user_id, created_at")
      .eq("org_id", orgId)
      .eq("direction", "outbound")
      .not("user_id", "is", null)
      .gte("created_at", window.windowStart.toISOString())
      .lt("created_at", window.windowEnd.toISOString())
      .limit(5000),
    supabase
      .from("interactions")
      .select("lead_id, created_at, intent, content")
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .gte("created_at", window.windowStart.toISOString())
      .lt("created_at", window.windowEnd.toISOString())
      .limit(5000),
  ]);

  // ── 2. Build funnel lookup ─────────────────────────────────────────────────
  const funnelMap = new Map<string, RevenueFunnelFact>();
  for (const f of funnel) funnelMap.set(f.leadId, f);

  // ── 3. Initialize per-lead summaries from RevenueLeadFact ─────────────────
  const leadSummaries = new Map<string, LeadSummary>();
  for (const lead of leads) {
    const ff = funnelMap.get(lead.leadId);
    leadSummaries.set(lead.leadId, {
      leadId:           lead.leadId,
      assignedTo:       lead.assignedTo ?? null,
      inboundCount:     0,
      firstInboundAt:   null,
      inboundIntents:   new Set(),
      inboundTexts:     [],
      agentMsgCount:    new Map(),
      agentFirstSentAt: new Map(),
      hadAppointment:   ff?.hadAppointment ?? false,
      dealClosed:       ff?.dealClosed ?? false,
    });
  }

  // ── 4. Populate from interaction rows ─────────────────────────────────────
  for (const row of (inboundRows ?? [])) {
    const s = leadSummaries.get(row.lead_id as string);
    if (!s) continue;
    s.inboundCount++;
    const ts = row.created_at as string;
    if (!s.firstInboundAt || ts < s.firstInboundAt) s.firstInboundAt = ts;
    if (row.intent)  s.inboundIntents.add(row.intent as string);
    if (row.content) s.inboundTexts.push((row.content as string).slice(0, 300));
  }

  for (const row of (humanOutRows ?? [])) {
    const s   = leadSummaries.get(row.lead_id as string);
    if (!s)   continue;
    const uid = row.user_id  as string;
    const ts  = row.created_at as string;
    s.agentMsgCount.set(uid, (s.agentMsgCount.get(uid) ?? 0) + 1);
    const existing = s.agentFirstSentAt.get(uid);
    if (!existing || ts < existing) s.agentFirstSentAt.set(uid, ts);
  }

  // ── 5. Group leads by assignedTo ──────────────────────────────────────────
  const agentLeads = new Map<string, LeadSummary[]>();
  for (const s of leadSummaries.values()) {
    if (!s.assignedTo) continue;
    if (!agentLeads.has(s.assignedTo)) agentLeads.set(s.assignedTo, []);
    agentLeads.get(s.assignedTo)!.push(s);
  }

  // ── 6. Compute per-agent metrics ──────────────────────────────────────────
  const allMetrics: AgentMetrics[] = [];

  for (const [userId, agentLeadList] of agentLeads) {
    const displayName = memberMap.get(userId) ?? `Agent [${userId.slice(0, 6)}]`;

    let leadsAssigned        = agentLeadList.length;
    let conversationsStarted = 0;
    let dealsClosed          = 0;
    let slowResponseCount    = 0;
    let noResponseCount      = 0;
    let highIntentLossCount  = 0;
    let pricingLeakCount     = 0;
    let bookingWeaknessCount = 0;
    let oneSidedCount        = 0;
    const responseTimes: number[] = [];

    for (const s of agentLeadList) {
      const hadInbound     = s.inboundCount > 0;
      const agentMsgCount  = s.agentMsgCount.get(userId) ?? 0;
      const agentFirstOut  = s.agentFirstSentAt.get(userId) ?? null;

      if (hadInbound) conversationsStarted++;
      if (s.dealClosed) dealsClosed++;

      // slow_response / no_response
      if (hadInbound && s.firstInboundAt) {
        if (agentFirstOut) {
          const diffMin = (new Date(agentFirstOut).getTime() - new Date(s.firstInboundAt).getTime()) / 60_000;
          if (diffMin > SLOW_RESPONSE_THRESHOLD_MIN) slowResponseCount++;
          if (diffMin >= 0) responseTimes.push(diffMin);
        } else {
          // Agent never responded to an inbound message on their assigned lead
          noResponseCount++;
        }
      }

      // high_intent_loss
      const hasHighIntent = [...s.inboundIntents].some((i) => HIGH_INTENT_INTENTS.has(i));
      if (hasHighIntent && !s.hadAppointment) highIntentLossCount++;

      // pricing_leak
      if (hasPricingSignal(s.inboundTexts) && !s.hadAppointment) pricingLeakCount++;

      // booking_weakness
      if (hadInbound && !s.hadAppointment) bookingWeaknessCount++;

      // one_sided: agent sent ≥3 messages but lead replied ≤1 time
      if (agentMsgCount >= 3 && s.inboundCount <= 1) oneSidedCount++;
    }

    const avgResponseMinutes =
      responseTimes.length > 0
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : null;

    const metricsNoScore = {
      userId, displayName, leadsAssigned, conversationsStarted, dealsClosed, avgResponseMinutes,
      slowResponseCount, noResponseCount, highIntentLossCount,
      pricingLeakCount, bookingWeaknessCount, oneSidedCount,
    };

    const priorityScore = computePriorityScore(metricsNoScore);
    const bucket        = classifyBucket(priorityScore, leadsAssigned, conversationsStarted, dealsClosed);
    allMetrics.push({ ...metricsNoScore, priorityScore, bucket });
  }

  // Include members with zero assigned leads as insufficient_data
  for (const [userId, displayName] of memberMap) {
    if (!agentLeads.has(userId)) {
      allMetrics.push({
        userId, displayName,
        leadsAssigned: 0, conversationsStarted: 0, dealsClosed: 0, avgResponseMinutes: null,
        slowResponseCount: 0, noResponseCount: 0, highIntentLossCount: 0,
        pricingLeakCount: 0, bookingWeaknessCount: 0, oneSidedCount: 0,
        priorityScore: 0,
        bucket: "insufficient_data",
      });
    }
  }

  // Sort by priority score descending
  allMetrics.sort((a, b) => b.priorityScore - a.priorityScore);

  const immediateAttention = allMetrics.filter((m) => m.bucket === "immediate_attention");
  const coaching           = allMetrics.filter((m) => m.bucket === "coaching");
  const topPerformers      = allMetrics.filter((m) => m.bucket === "top_performer");
  const insufficientData   = allMetrics.filter((m) => m.bucket === "insufficient_data");

  const eligibleAgents = allMetrics.filter(
    (m) => m.leadsAssigned >= MIN_LEADS_FOR_RANKING && m.conversationsStarted >= MIN_CONVS_FOR_RANKING,
  ).length;

  // Window summary
  const totalAssigned = allMetrics.reduce((s, m) => s + m.leadsAssigned, 0);
  const totalClosed   = allMetrics.reduce((s, m) => s + m.dealsClosed, 0);
  const windowSummary =
    `${allMetrics.length} agent(s) active, ${totalAssigned} leads assigned, ${totalClosed} deals closed. ` +
    (immediateAttention.length > 0
      ? `${immediateAttention.length} agent(s) require immediate attention.`
      : "No agents flagged for immediate attention.");

  return {
    totalAgents:     memberMap.size,
    eligibleAgents,
    immediateAttention,
    coaching,
    topPerformers,
    insufficientData,
    windowSummary,
  };
}
