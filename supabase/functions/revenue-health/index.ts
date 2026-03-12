/**
 * revenue-health — Edge Function
 *
 * Computes and serves the Revenue Health snapshot for an org.
 *
 * GET /revenue-health?org_id=UUID&window_type=daily|weekly|monthly&reference_date=YYYY-MM-DD
 *
 * Behavior:
 *   1. Auth check (user JWT or internal service-role bypass for cache warming)
 *   2. Org membership gate (user must be member, OR platform admin)
 *   3. Cache check: revenue_health_snapshots where computed_at > NOW()-4h
 *      → returns cached snapshot immediately (source: "cache")
 *   4. On cache miss (or ?force=true): compute live across all 4 categories
 *      → upserts revenue_health_snapshots → returns result (source: "live")
 *
 * Entitlement: Revenue Health is FREE for ALL plans including Sentinel.
 * No quota gate. Any authenticated org member always has access.
 *
 * ── v1 COMMERCIAL MAPPING note ────────────────────────────────────────────
 * Revenue Health has no entitlement gate (always free). Revenue Doctor does.
 * The entitlement check for Doctor is in revenue-doctor-generate, not here.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getServiceSupabaseClient, getUserSupabaseClient } from "../_shared/db.ts";
import {
  buildDateWindow,
  fetchLeadFacts,
  fetchConversationFacts,
  fetchChannelFacts,
  fetchFunnelFacts,
  fetchCampaignFacts,
  type WindowType,
  type DateWindow,
} from "../_shared/revenue_adapters.ts";
import {
  scoreLeadResponse,
  scoreConversationQuality,
  scoreChannelHealth,
  scoreConversionHealth,
  computeOverallScore,
  generateWarnings,
  type CategoryScore,
  type HealthSnapshot,
} from "../_shared/health_scorer.ts";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const CACHE_TTL_MS   = 4 * 60 * 60 * 1000;  // 4 hours
const CORS_HEADERS   = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

// ─────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────

function ok(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}
function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}

// ─────────────────────────────────────────────
// PREV WINDOW HELPER
// Returns a DateWindow shifted to cover the previous equivalent period.
// Used to pass to fetch adapters (which only read windowStart/windowEnd).
// ─────────────────────────────────────────────

function makePrevPeriodWindow(w: DateWindow): DateWindow {
  return {
    ...w,
    windowStart: w.prevWindowStart,
    windowEnd:   w.prevWindowEnd,
    // These fields won't be used for fetching — set to sensible values
    prevWindowStart: new Date(w.prevWindowStart.getTime() - (w.windowEnd.getTime() - w.windowStart.getTime())),
    prevWindowEnd:   w.prevWindowStart,
  };
}

// ─────────────────────────────────────────────
// CANONICAL RESPONSE SHAPE
// Matches Part 3 spec + adds source/computed_at/data_confidence
// ─────────────────────────────────────────────

function buildResponse(snapshot: HealthSnapshot, source: "cache" | "live") {
  return {
    org_id:          snapshot.orgId,
    window:          snapshot.windowType,
    reference_date:  snapshot.referenceDate,
    window_start:    snapshot.windowStart,
    window_end:      snapshot.windowEnd,
    overall_score:   snapshot.overallScore,
    data_confidence: snapshot.dataConfidence,
    categories:      snapshot.categories.map((c) => ({
      category:         c.category,
      score:            c.score,
      delta_vs_previous: c.deltaVsPrevious,
      raw_metrics:      c.rawMetrics,
      flags:            c.flags,
      summary:          c.summary,
    })),
    warnings:     snapshot.warnings.map((w) => ({
      code:               w.code,
      severity:           w.severity,
      category:           w.category,
      message:            w.message,
      supporting_metrics: w.supportingMetrics,
      cta:                w.cta,
    })),
    computed_at: snapshot.computedAt,
    source,
  };
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return err(405, "Method not allowed");
  }

  // ── 1. Parse & validate params ─────────────────────────────────────────
  const url           = new URL(req.url);
  const orgId         = url.searchParams.get("org_id");
  const windowTypeRaw = url.searchParams.get("window_type") ?? "weekly";
  const referenceDate = url.searchParams.get("reference_date") ?? undefined;
  const forceRefresh  = url.searchParams.get("force") === "true";

  if (!orgId) return err(400, "org_id is required");
  if (!["daily", "weekly", "monthly"].includes(windowTypeRaw)) {
    return err(400, "window_type must be daily, weekly, or monthly");
  }
  const windowType = windowTypeRaw as WindowType;

  // ── 2. Auth check ───────────────────────────────────────────────────────
  // Internal cache-warm calls use the service role key as Bearer token.
  // Regular user calls use their own JWT.
  //
  // v1: No plan-tier gating here. Revenue Health is free for all.
  const serviceKey = Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
                     Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader  = req.headers.get("Authorization") ?? "";
  const isInternal  = serviceKey.length > 0 && authHeader === `Bearer ${serviceKey}`;

  const sb = getServiceSupabaseClient();
  let userId: string | null = null;

  if (!isInternal) {
    // Validate user JWT
    const userSb = getUserSupabaseClient(req);
    const { data: { user }, error: authErr } = await userSb.auth.getUser();
    if (authErr || !user) return err(401, "Unauthorized");
    userId = user.id;

    // ── 3. Org membership gate ────────────────────────────────────────────
    // Allow: org_members row for this org, OR platform admin (profiles.is_admin)
    const [{ data: memRow }, { data: profileRow }] = await Promise.all([
      sb.from("org_members")
        .select("org_id")
        .eq("user_id", userId)
        .eq("org_id", orgId)
        .limit(1),
      sb.from("profiles")
        .select("is_admin")
        .eq("id", userId)
        .maybeSingle(),
    ]);

    const isMember  = Array.isArray(memRow) && memRow.length > 0;
    const isAdmin   = profileRow?.is_admin === true;

    if (!isMember && !isAdmin) {
      return err(403, "Forbidden — you are not a member of this organisation");
    }
  }

  // ── 4. Build date window ────────────────────────────────────────────────
  const window = buildDateWindow(windowType, referenceDate);

  // ── 5. Cache check ──────────────────────────────────────────────────────
  if (!forceRefresh) {
    const staleBefore = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const { data: cached, error: cacheErr } = await sb
      .from("revenue_health_snapshots")
      .select("*")
      .eq("org_id", orgId)
      .eq("window_type", windowType)
      .eq("reference_date", window.referenceDate)
      .gte("computed_at", staleBefore)
      .maybeSingle();

    if (!cacheErr && cached) {
      // Reconstruct HealthSnapshot from cached row and return immediately
      const snap = rowToSnapshot(cached);
      return ok(buildResponse(snap, "cache"));
    }
  }

  // ── 6. Compute live ─────────────────────────────────────────────────────
  // Fetch current window facts (all 5 adapters in parallel)
  // Fetch previous window facts simultaneously (4 adapters — campaigns not needed for scoring)
  const prevW = makePrevPeriodWindow(window);

  let leads, convs, channels, funnel, campaigns;
  let prevLeads, prevConvs, prevChannels, prevFunnel;

  try {
    [
      [leads, convs, channels, funnel, campaigns],
      [prevLeads, prevConvs, prevChannels, prevFunnel],
    ] = await Promise.all([
      Promise.all([
        fetchLeadFacts(sb, orgId, window),
        fetchConversationFacts(sb, orgId, window),
        fetchChannelFacts(sb, orgId, window),
        fetchFunnelFacts(sb, orgId, window),
        fetchCampaignFacts(sb, orgId, window),
      ]),
      Promise.all([
        fetchLeadFacts(sb, orgId, prevW),
        fetchConversationFacts(sb, orgId, prevW),
        fetchChannelFacts(sb, orgId, prevW),
        fetchFunnelFacts(sb, orgId, prevW),
      ]),
    ]);
  } catch (fetchErr) {
    console.error("[revenue-health] Data fetch failed:", fetchErr);
    return err(500, "Failed to fetch analytics data");
  }

  // ── 7. Score all 4 categories ───────────────────────────────────────────
  const leadResponseCat  = scoreLeadResponse(leads, prevLeads);
  const convQualityCat   = scoreConversationQuality(convs, prevConvs);
  const channelHealthCat = scoreChannelHealth(channels, prevChannels);
  const { score: convHealthCat, dataConfidence } =
    scoreConversionHealth(funnel, prevFunnel);

  const categories: CategoryScore[] = [
    leadResponseCat,
    convQualityCat,
    channelHealthCat,
    convHealthCat,
  ];

  const overallScore = computeOverallScore(categories);
  const warnings     = generateWarnings(categories);
  const computedAt   = new Date().toISOString();

  // Determine overall data confidence from worst category
  const confidenceOrder: Record<string, number> = {
    sufficient: 2, partial: 1, insufficient: 0,
  };
  const overallConfidence = (
    leads.length   === 0 &&
    convs.length   === 0 &&
    channels.length === 0
  ) ? "insufficient" : dataConfidence;

  const snapshot: HealthSnapshot = {
    orgId:          orgId,
    windowType,
    referenceDate:  window.referenceDate,
    windowStart:    window.windowStart.toISOString(),
    windowEnd:      window.windowEnd.toISOString(),
    overallScore,
    categories,
    warnings,
    dataConfidence: overallConfidence,
    computedAt,
  };

  // ── 8. Upsert cache ─────────────────────────────────────────────────────
  // Fire-and-forget upsert (don't block response on cache write)
  sb.from("revenue_health_snapshots")
    .upsert(
      {
        org_id:          orgId,
        window_type:     windowType,
        reference_date:  window.referenceDate,
        window_start:    window.windowStart.toISOString(),
        window_end:      window.windowEnd.toISOString(),
        overall_score:   overallScore,
        category_scores: Object.fromEntries(categories.map((c) => [c.category, c.score])),
        raw_metrics:     Object.fromEntries(categories.map((c) => [c.category, c.rawMetrics])),
        warnings:        warnings,
        data_confidence: overallConfidence,
        computed_at:     computedAt,
      },
      { onConflict: "org_id,window_type,reference_date" },
    )
    .then(undefined, (e: unknown) => console.error("[revenue-health] Cache upsert failed:", e));

  // ── 9. Return live result ───────────────────────────────────────────────
  return ok(buildResponse(snapshot, "live"));
});

// ─────────────────────────────────────────────
// ROW → SNAPSHOT CONVERTER
// Reconstructs a HealthSnapshot from a revenue_health_snapshots row
// so cached rows can go through the same buildResponse() path.
// ─────────────────────────────────────────────

function rowToSnapshot(row: Record<string, unknown>): HealthSnapshot {
  // category_scores: { lead_response: 91, ... }
  const catScores = (row.category_scores as Record<string, number>) ?? {};
  // raw_metrics:    { lead_response: { total_leads: 10, ... }, ... }
  const rawMetrics = (row.raw_metrics as Record<string, Record<string, number | null>>) ?? {};

  const categories: CategoryScore[] = Object.entries(catScores).map(([cat, score]) => ({
    category:        cat,
    score:           score as number,
    rawMetrics:      rawMetrics[cat] ?? {},
    deltaVsPrevious: null,     // not stored in cache row — delta visible on live compute only
    flags:           [],       // re-derived from warnings array; not needed for display
    summary:         "",       // not stored separately in cache
  }));

  return {
    orgId:          row.org_id  as string,
    windowType:     row.window_type as WindowType,
    referenceDate:  row.reference_date as string,
    windowStart:    row.window_start as string,
    windowEnd:      row.window_end as string,
    overallScore:   Number(row.overall_score),
    categories,
    warnings:       (row.warnings as unknown[]) ?? [],
    dataConfidence: (row.data_confidence as "sufficient" | "partial" | "insufficient") ?? "sufficient",
    computedAt:     row.computed_at as string,
  };
}
