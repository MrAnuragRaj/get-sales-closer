/**
 * revenue_adapters.ts
 *
 * Canonical data adapters for the Revenue Health + Revenue Doctor system.
 *
 * These adapters translate raw Supabase table rows into stable, typed
 * logical contracts (Facts). The fact interfaces are the stable API surface:
 * table/column names below may evolve, but the output types of each
 * fetchXxxFacts() function must not change without versioning.
 *
 * Adapters are pure async functions — no side effects, no caching.
 * All queries are strictly org-scoped (tenant isolation guarantee).
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────
// WINDOW TYPES
// ─────────────────────────────────────────────

export type WindowType = "daily" | "weekly" | "monthly";

export interface DateWindow {
  windowType:      WindowType;
  referenceDate:   string;       // YYYY-MM-DD anchor date
  windowStart:     Date;         // inclusive
  windowEnd:       Date;         // exclusive (start of next period)
  prevWindowStart: Date;         // previous equivalent period start
  prevWindowEnd:   Date;         // previous equivalent period end
}

/**
 * Builds a DateWindow for a given window type and optional reference date.
 * Reference date defaults to today UTC. All boundaries are at UTC midnight.
 *
 * daily   → reference_date day (00:00–24:00 UTC)
 * weekly  → ISO week (Mon–Sun) containing reference_date
 * monthly → calendar month containing reference_date
 */
export function buildDateWindow(
  windowType: WindowType,
  referenceDate?: string,
): DateWindow {
  // Parse reference date at UTC midnight
  const refStr = referenceDate
    ? referenceDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const ref = new Date(refStr + "T00:00:00Z");

  let windowStart:     Date;
  let windowEnd:       Date;
  let prevWindowStart: Date;
  let prevWindowEnd:   Date;

  const DAY_MS = 86_400_000;

  if (windowType === "daily") {
    windowStart     = new Date(ref);
    windowEnd       = new Date(ref.getTime() + DAY_MS);
    prevWindowStart = new Date(ref.getTime() - DAY_MS);
    prevWindowEnd   = new Date(ref);

  } else if (windowType === "weekly") {
    // ISO week: starts Monday
    const dow          = ref.getUTCDay();              // 0=Sun … 6=Sat
    const daysToMonday = dow === 0 ? 6 : dow - 1;
    windowStart        = new Date(ref.getTime() - daysToMonday * DAY_MS);
    windowEnd          = new Date(windowStart.getTime() + 7 * DAY_MS);
    prevWindowStart    = new Date(windowStart.getTime() - 7 * DAY_MS);
    prevWindowEnd      = new Date(windowStart);

  } else {
    // monthly: calendar month
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth();
    windowStart     = new Date(Date.UTC(y, m, 1));
    windowEnd       = new Date(Date.UTC(y, m + 1, 1));
    prevWindowStart = new Date(Date.UTC(y, m - 1, 1));
    prevWindowEnd   = new Date(Date.UTC(y, m, 1));
  }

  return {
    windowType,
    referenceDate: refStr,
    windowStart,
    windowEnd,
    prevWindowStart,
    prevWindowEnd,
  };
}

// ─────────────────────────────────────────────
// FACT TYPES — stable logical contracts
// ─────────────────────────────────────────────

/** One lead created within a window, enriched with first-contact timing. */
export interface RevenueLeadFact {
  orgId:                   string;
  leadId:                  string;
  createdAt:               string;
  source?:                 string;
  status?:                 string;
  assignedTo?:             string;
  firstOutboundAt?:        string;          // timestamp of first outbound message
  firstInboundReplyAt?:    string;          // timestamp of first lead reply
  minutesToFirstResponse?: number;          // null if lead was never contacted
  wasContacted:            boolean;
  hadInboundReply:         boolean;
}

/** One message in a conversation, normalized across all channels. */
export interface RevenueConversationFact {
  orgId:      string;
  leadId:     string;
  channel:    string;                       // sms | email | whatsapp | voice | rcs | messenger
  direction:  "inbound" | "outbound" | "system";
  actorType:  "lead" | "ai" | "human" | "system" | "unknown";
  text:       string;
  occurredAt: string;
  intent?:    string;
}

/** One delivery attempt, normalized for channel health scoring. */
export interface RevenueChannelFact {
  orgId:        string;
  channel:      string;
  status:       string;                     // sent | delivered | read | failed | pending | received
  sentAt?:      string;
  deliveredAt?: string;
  readAt?:      string;
}

/** Funnel state for one lead created within the window. */
export interface RevenueFunnelFact {
  orgId:           string;
  leadId:          string;
  createdAt:       string;
  wasContacted:    boolean;
  hadReply:        boolean;
  hadAppointment:  boolean;
  dealClosed:      boolean;
}

/** One execution task associated with a campaign or automation. */
export interface RevenueCampaignFact {
  orgId:         string;
  campaignId:    string;
  leadId:        string;
  taskStatus:    string;
  channel:       string;
  scheduledFor?: string;
  executedAt?:   string;
  lastError?:    string;
}

// ─────────────────────────────────────────────
// ADAPTER: Lead Facts
// ─────────────────────────────────────────────

/**
 * Fetches all leads created within the window and enriches each with
 * first-outbound and first-inbound timestamps for response-time analysis.
 * Uses two parallel interaction queries to avoid N+1.
 */
export async function fetchLeadFacts(
  supabase:  SupabaseClient,
  orgId:     string,
  window:    DateWindow,
): Promise<RevenueLeadFact[]> {
  const { data: leads } = await supabase
    .from("leads")
    .select("id, created_at, source, status, assigned_to")
    .eq("org_id", orgId)
    .gte("created_at", window.windowStart.toISOString())
    .lt("created_at", window.windowEnd.toISOString())
    .order("created_at", { ascending: true });

  if (!leads || leads.length === 0) return [];

  const leadIds = leads.map((l: any) => l.id as string);

  // Fetch first outbound and first inbound per lead in parallel
  const [{ data: outbounds }, { data: inbounds }] = await Promise.all([
    supabase
      .from("interactions")
      .select("lead_id, created_at, user_id")
      .eq("org_id", orgId)
      .eq("direction", "outbound")
      .in("lead_id", leadIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("interactions")
      .select("lead_id, created_at")
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .in("lead_id", leadIds)
      .order("created_at", { ascending: true }),
  ]);

  // Build maps: leadId → first timestamp
  const firstOut = new Map<string, string>();
  const firstIn  = new Map<string, string>();

  for (const row of (outbounds ?? [])) {
    if (!firstOut.has(row.lead_id)) firstOut.set(row.lead_id, row.created_at);
  }
  for (const row of (inbounds ?? [])) {
    if (!firstIn.has(row.lead_id)) firstIn.set(row.lead_id, row.created_at);
  }

  return leads.map((lead: any): RevenueLeadFact => {
    const outTs = firstOut.get(lead.id);
    const inTs  = firstIn.get(lead.id);

    let minutesToFirst: number | undefined;
    if (outTs) {
      const delta = new Date(outTs).getTime() - new Date(lead.created_at).getTime();
      minutesToFirst = Math.max(0, Math.round(delta / 60_000));
    }

    return {
      orgId,
      leadId:                  lead.id,
      createdAt:               lead.created_at,
      source:                  lead.source    ?? undefined,
      status:                  lead.status    ?? undefined,
      assignedTo:              lead.assigned_to ?? undefined,
      firstOutboundAt:         outTs,
      firstInboundReplyAt:     inTs,
      minutesToFirstResponse:  minutesToFirst,
      wasContacted:            !!outTs,
      hadInboundReply:         !!inTs,
    };
  });
}

// ─────────────────────────────────────────────
// ADAPTER: Conversation Facts
// ─────────────────────────────────────────────

/**
 * Fetches all interactions within the window.
 * Actor type is inferred from direction + user_id:
 *   inbound  → lead
 *   system   → system
 *   outbound + user_id set  → human agent
 *   outbound + no user_id   → AI
 *
 * Safety cap: 5,000 rows (prevents runaway queries for high-volume orgs).
 */
export async function fetchConversationFacts(
  supabase: SupabaseClient,
  orgId:    string,
  window:   DateWindow,
): Promise<RevenueConversationFact[]> {
  const { data: rows } = await supabase
    .from("interactions")
    .select("lead_id, type, direction, content, intent, user_id, created_at")
    .eq("org_id", orgId)
    .gte("created_at", window.windowStart.toISOString())
    .lt("created_at", window.windowEnd.toISOString())
    .order("created_at", { ascending: true })
    .limit(5000);

  if (!rows) return [];

  return rows.map((row: any): RevenueConversationFact => {
    let actorType: RevenueConversationFact["actorType"];
    if (row.direction === "inbound")       actorType = "lead";
    else if (row.direction === "system")   actorType = "system";
    else if (row.user_id)                  actorType = "human";
    else                                   actorType = "ai";

    return {
      orgId,
      leadId:     row.lead_id,
      channel:    row.type      ?? "unknown",
      direction:  row.direction as RevenueConversationFact["direction"],
      actorType,
      text:       row.content   ?? "",
      occurredAt: row.created_at,
      intent:     row.intent    ?? undefined,
    };
  });
}

// ─────────────────────────────────────────────
// ADAPTER: Channel / Delivery Facts
// ─────────────────────────────────────────────

/**
 * Fetches delivery_attempts within the window for channel health scoring.
 * Filters by created_at (always set) rather than sent_at (may be null on
 * immediate failures).
 *
 * Safety cap: 10,000 rows.
 */
export async function fetchChannelFacts(
  supabase: SupabaseClient,
  orgId:    string,
  window:   DateWindow,
): Promise<RevenueChannelFact[]> {
  const { data: rows } = await supabase
    .from("delivery_attempts")
    .select("channel, status, sent_at, delivered_at, read_at")
    .eq("org_id", orgId)
    .gte("created_at", window.windowStart.toISOString())
    .lt("created_at", window.windowEnd.toISOString())
    .limit(10000);

  if (!rows) return [];

  return rows.map((row: any): RevenueChannelFact => ({
    orgId,
    channel:     row.channel      ?? "unknown",
    status:      row.status       ?? "unknown",
    sentAt:      row.sent_at      ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    readAt:      row.read_at      ?? undefined,
  }));
}

// ─────────────────────────────────────────────
// ADAPTER: Funnel Facts
// ─────────────────────────────────────────────

/**
 * Derives funnel stage completion for every lead created in the window.
 * Stages: created → contacted → replied → appointment_booked → deal_closed
 *
 * deal_closed is inferred from leads.status = 'closed_won'.
 * All three interaction/appointment lookups run in parallel.
 */
export async function fetchFunnelFacts(
  supabase: SupabaseClient,
  orgId:    string,
  window:   DateWindow,
): Promise<RevenueFunnelFact[]> {
  const { data: leads } = await supabase
    .from("leads")
    .select("id, created_at, status")
    .eq("org_id", orgId)
    .gte("created_at", window.windowStart.toISOString())
    .lt("created_at", window.windowEnd.toISOString());

  if (!leads || leads.length === 0) return [];

  const leadIds = leads.map((l: any) => l.id as string);

  const [
    { data: contacted },
    { data: replied },
    { data: appointed },
  ] = await Promise.all([
    supabase
      .from("interactions")
      .select("lead_id")
      .eq("org_id", orgId)
      .eq("direction", "outbound")
      .in("lead_id", leadIds),
    supabase
      .from("interactions")
      .select("lead_id")
      .eq("org_id", orgId)
      .eq("direction", "inbound")
      .in("lead_id", leadIds),
    supabase
      .from("appointments")
      .select("lead_id")
      .eq("org_id", orgId)
      .in("lead_id", leadIds),
  ]);

  const contactedSet  = new Set((contacted  ?? []).map((r: any) => r.lead_id as string));
  const repliedSet    = new Set((replied    ?? []).map((r: any) => r.lead_id as string));
  const appointedSet  = new Set((appointed  ?? []).map((r: any) => r.lead_id as string));

  return leads.map((lead: any): RevenueFunnelFact => ({
    orgId,
    leadId:          lead.id,
    createdAt:       lead.created_at,
    wasContacted:    contactedSet.has(lead.id),
    hadReply:        repliedSet.has(lead.id),
    hadAppointment:  appointedSet.has(lead.id),
    dealClosed:      lead.status === "closed_won",
  }));
}

// ─────────────────────────────────────────────
// ADAPTER: Campaign / Automation Facts
// ─────────────────────────────────────────────

/**
 * Fetches execution tasks scheduled within the window.
 * Joins decision_plans to extract campaign_id where available.
 *
 * Safety cap: 5,000 rows.
 */
export async function fetchCampaignFacts(
  supabase: SupabaseClient,
  orgId:    string,
  window:   DateWindow,
): Promise<RevenueCampaignFact[]> {
  const { data: tasks } = await supabase
    .from("execution_tasks")
    .select("id, plan_id, lead_id, channel, status, scheduled_for, executed_at, last_error")
    .eq("org_id", orgId)
    .gte("scheduled_for", window.windowStart.toISOString())
    .lt("scheduled_for", window.windowEnd.toISOString())
    .limit(5000);

  if (!tasks || tasks.length === 0) return [];

  // Extract campaign_id from decision_plans.plan JSONB
  const planIds = [...new Set(
    tasks.map((t: any) => t.plan_id).filter(Boolean)
  )] as string[];

  const planCampaignMap = new Map<string, string>();

  if (planIds.length > 0) {
    const { data: plans } = await supabase
      .from("decision_plans")
      .select("id, plan")
      .in("id", planIds);

    for (const p of (plans ?? [])) {
      const cid = (p.plan as any)?.campaign_id ?? null;
      if (cid) planCampaignMap.set(p.id, cid);
    }
  }

  return tasks.map((task: any): RevenueCampaignFact => ({
    orgId,
    campaignId:    planCampaignMap.get(task.plan_id) ?? task.plan_id ?? "untracked",
    leadId:        task.lead_id,
    taskStatus:    task.status       ?? "unknown",
    channel:       task.channel      ?? "unknown",
    scheduledFor:  task.scheduled_for ?? undefined,
    executedAt:    task.executed_at   ?? undefined,
    lastError:     task.last_error    ?? undefined,
  }));
}
