/**
 * revenue-doctor-reports — Edge Function
 *
 * Retrieval-only endpoint for Revenue Doctor reports.
 * No generation side effects. Reads from revenue_doctor_reports only.
 *
 * ── LIST ────────────────────────────────────────────────────────────────────
 * GET /revenue-doctor-reports?org_id=UUID[&window_type=weekly][&limit=10][&before=ISO_TS]
 *
 * Returns compact rows (no report_content):
 *   id, window_type, window_start, window_end, executive_summary,
 *   overall_score, data_confidence, generated_at, model_used,
 *   input_token_count, output_token_count
 *
 * Ordering: generated_at DESC
 * Default limit: 10 | Max limit: 50
 * Cursor pagination: ?before=<generated_at ISO timestamp of last item seen>
 *
 * ── SINGLE REPORT ────────────────────────────────────────────────────────────
 * GET /revenue-doctor-reports?org_id=UUID&report_id=UUID
 *
 * Returns full payload:
 *   all list fields + report_content + health_snapshot
 *
 * Security: if report_id exists but belongs to a different org → 404 (no existence leak)
 *
 * ── ACCESS CONTROL ───────────────────────────────────────────────────────────
 * Requires valid user JWT.
 * Caller must be an org_members row for org_id, OR profiles.is_admin = true.
 * No cross-org access possible — org_id scopes all queries.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getServiceSupabaseClient, getUserSupabaseClient } from "../_shared/db.ts";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT     = 50;

const CORS_HEADERS = {
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
// COMPACT ROW SHAPE (list view — no report_content)
// ─────────────────────────────────────────────

function toCompactRow(row: Record<string, unknown>) {
  return {
    id:                  row.id,
    window_type:         row.window_type,
    window_start:        row.window_start,
    window_end:          row.window_end,
    executive_summary:   row.executive_summary,
    overall_score:       row.overall_score !== null ? Number(row.overall_score) : null,
    data_confidence:     (row.health_snapshot as Record<string, unknown>)?.data_confidence ?? null,
    generated_at:        row.generated_at,
    model_used:          row.model_used,
    input_token_count:   row.input_token_count,
    output_token_count:  row.output_token_count,
  };
}

// ─────────────────────────────────────────────
// FULL ROW SHAPE (single-report view)
// ─────────────────────────────────────────────

function toFullRow(row: Record<string, unknown>) {
  return {
    ...toCompactRow(row),
    health_snapshot: row.health_snapshot,
    report_content:  row.report_content,
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

  // ── 1. Parse params ─────────────────────────────────────────────────────
  const url        = new URL(req.url);
  const orgId      = url.searchParams.get("org_id");
  const reportId   = url.searchParams.get("report_id");  // present → single-report mode
  const windowType = url.searchParams.get("window_type");
  const before     = url.searchParams.get("before");     // cursor: ISO timestamp
  const limitRaw   = url.searchParams.get("limit");

  if (!orgId) return err(400, "org_id is required");

  if (windowType && !["daily", "weekly", "monthly"].includes(windowType)) {
    return err(400, "window_type must be daily, weekly, or monthly");
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  // ── 2. Auth check — user JWT required ────────────────────────────────────
  const userSb = getUserSupabaseClient(req);
  const { data: { user }, error: authErr } = await userSb.auth.getUser();
  if (authErr || !user) return err(401, "Unauthorized");
  const userId = user.id;

  const sb = getServiceSupabaseClient();

  // ── 3. Org membership gate ────────────────────────────────────────────────
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

  const isMember = Array.isArray(memRow) && memRow.length > 0;
  const isAdmin  = profileRow?.is_admin === true;
  if (!isMember && !isAdmin) {
    return err(403, "Forbidden — you are not a member of this organisation");
  }

  // ── 4. Route: single report OR list ──────────────────────────────────────

  if (reportId) {
    return handleSingleReport(sb, orgId, reportId);
  }
  return handleList(sb, orgId, windowType, limit, before);
});

// ─────────────────────────────────────────────
// SINGLE REPORT HANDLER
// ─────────────────────────────────────────────

async function handleSingleReport(
  sb:       ReturnType<typeof getServiceSupabaseClient>,
  orgId:    string,
  reportId: string,
): Promise<Response> {
  // Fetch the report filtering by BOTH report_id AND org_id in the same query.
  // If the row exists but belongs to another org, the org_id filter excludes it
  // and we return the same 404 shape — no existence is leaked.
  const { data: row, error: fetchErr } = await sb
    .from("revenue_doctor_reports")
    .select(
      "id, org_id, window_type, window_start, window_end, " +
      "health_snapshot, executive_summary, overall_score, " +
      "model_used, input_token_count, output_token_count, " +
      "generated_at, generated_by, report_content",
    )
    .eq("id", reportId)
    .eq("org_id", orgId)   // org-scope filter — prevents cross-org access
    .maybeSingle();

  if (fetchErr) {
    console.error("[revenue-doctor-reports] Single fetch error:", fetchErr);
    return err(500, "Failed to retrieve report");
  }

  // Both "not found" and "wrong org" return 404 — no existence leak
  if (!row) {
    return err(404, "Report not found");
  }

  return new Response(
    JSON.stringify(toFullRow(row as Record<string, unknown>)),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

// ─────────────────────────────────────────────
// LIST HANDLER
// ─────────────────────────────────────────────

async function handleList(
  sb:          ReturnType<typeof getServiceSupabaseClient>,
  orgId:       string,
  windowType:  string | null,
  limit:       number,
  before:      string | null,
): Promise<Response> {
  // Compact columns only — report_content deliberately excluded
  let query = sb
    .from("revenue_doctor_reports")
    .select(
      "id, window_type, window_start, window_end, " +
      "health_snapshot, executive_summary, overall_score, " +
      "model_used, input_token_count, output_token_count, " +
      "generated_at",
    )
    .eq("org_id", orgId)
    .order("generated_at", { ascending: false })
    .limit(limit + 1);  // fetch one extra to determine has_more

  if (windowType) {
    query = query.eq("window_type", windowType);
  }

  // Cursor pagination: return rows strictly before the given timestamp
  if (before) {
    query = query.lt("generated_at", before);
  }

  const { data: rows, error: fetchErr } = await query;

  if (fetchErr) {
    console.error("[revenue-doctor-reports] List fetch error:", fetchErr);
    return err(500, "Failed to retrieve reports");
  }

  const items   = (rows ?? []) as Array<Record<string, unknown>>;
  const hasMore = items.length > limit;
  if (hasMore) items.pop();  // remove the extra probe row

  const compact     = items.map(toCompactRow);
  const nextCursor  = hasMore && compact.length > 0
    ? compact[compact.length - 1].generated_at as string
    : null;

  return new Response(
    JSON.stringify({
      reports:     compact,
      count:       compact.length,
      has_more:    hasMore,
      next_cursor: nextCursor,  // pass as ?before= on next page request
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}
