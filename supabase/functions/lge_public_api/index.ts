// lge_public_api — Phase 19: Public REST API for LGE
// Authentication: X-LGE-Key header containing the raw API key.
// The raw key is SHA-256 hashed and looked up in lge_api_keys.
//
// Endpoints (action in request body or ?action= query param):
//   POST ingest       — submit a lead for processing
//   POST score        — score a lead inline (no DB write)
//   GET  campaigns    — list org campaigns
//   GET  leads        — list leads (paginated)
//   GET  outcomes     — list outcomes for pushed leads
//   GET  usage        — get today's usage vs quota

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { computeFitScore, computeConfidenceScore, computeTotalScore, routeByScore } from "../_shared/lge_scorer.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lge-key",
};

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function apiErr(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// SHA-256 hash of the raw API key
async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Resolve org from API key
async function resolveApiKey(sb: ReturnType<typeof getServiceSupabaseClient>, rawKey: string):
  Promise<{ orgId: string; keyId: string; scopes: string[]; rateLimitPerMin: number } | null> {
  const hash = await hashKey(rawKey);
  const { data, error } = await sb.from("lge_api_keys")
    .select("id, org_id, scopes, rate_limit_per_min, expires_at")
    .eq("key_hash", hash)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

  // Update last_used_at (fire-and-forget)
  sb.from("lge_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id)
    .then(undefined, () => {});

  return {
    orgId: data.org_id,
    keyId: data.id,
    scopes: data.scopes ?? ["read"],
    rateLimitPerMin: data.rate_limit_per_min ?? 60,
  };
}

// Simple per-minute rate limit using lge_api_requests count
async function checkRateLimit(sb: ReturnType<typeof getServiceSupabaseClient>, keyId: string, limitPerMin: number): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await sb.from("lge_api_requests")
    .select("id", { count: "exact", head: true })
    .eq("api_key_id", keyId)
    .gte("created_at", since);
  return (count ?? 0) >= limitPerMin;
}

// Log API request
async function logRequest(sb: ReturnType<typeof getServiceSupabaseClient>, keyId: string, orgId: string, endpoint: string, method: string, statusCode: number, startMs: number) {
  await sb.from("lge_api_requests").insert({
    api_key_id: keyId,
    org_id: orgId,
    endpoint,
    method,
    status_code: statusCode,
    response_ms: Date.now() - startMs,
  }).then(undefined, () => {});
}

serve(async (req: Request) => {
  const startMs = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = getServiceSupabaseClient();

  // Authenticate
  const rawKey = req.headers.get("x-lge-key") ?? req.headers.get("X-LGE-Key") ?? "";
  if (!rawKey) return apiErr("Missing X-LGE-Key header", 401);

  const keyCtx = await resolveApiKey(sb, rawKey);
  if (!keyCtx) return apiErr("Invalid or expired API key", 401);
  const { orgId, keyId, scopes, rateLimitPerMin } = keyCtx;

  // Rate limit
  const limited = await checkRateLimit(sb, keyId, rateLimitPerMin);
  if (limited) return apiErr("Rate limit exceeded — retry after 60 seconds", 429);

  // Check LGE entitlement
  const { data: svc } = await sb.from("org_services")
    .select("status").eq("org_id", orgId).eq("service_key", "lead_gen").maybeSingle();
  if (svc?.status !== "active") return apiErr("LGE not active for this org", 403);

  const url   = new URL(req.url);
  const action = url.searchParams.get("action") ?? (req.method === "POST" ? (await req.json().catch(() => ({}))).action : "");
  const endpoint = action || url.pathname.split("/").pop() || "unknown";

  try {
    // ── GET campaigns ─────────────────────────────────────────────────────────
    if (action === "campaigns" || endpoint === "campaigns") {
      if (!scopes.includes("read")) return apiErr("Scope 'read' required", 403);
      const { data, error } = await sb.from("lge_campaigns")
        .select("id, name, status, mode, icp_config, auto_push_threshold, review_threshold, created_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return apiErr(error.message, 500);
      await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs);
      return ok({ campaigns: data ?? [] });
    }

    // ── GET leads ─────────────────────────────────────────────────────────────
    if (action === "leads" || endpoint === "leads") {
      if (!scopes.includes("read")) return apiErr("Scope 'read' required", 403);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      const { campaign_id, status, limit: lim = 50, offset: off = 0 } = body;
      let q = sb.from("lge_raw_leads")
        .select("id, name, email, phone, company, source, status, created_at, gsc_lead_id")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .range(Number(off), Number(off) + Math.min(Number(lim), 200) - 1);
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) return apiErr(error.message, 500);
      await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs);
      return ok({ leads: data ?? [] });
    }

    // ── GET outcomes ──────────────────────────────────────────────────────────
    if (action === "outcomes" || endpoint === "outcomes") {
      if (!scopes.includes("read")) return apiErr("Scope 'read' required", 403);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      const { campaign_id, limit: lim = 100, offset: off = 0 } = body;
      let q = sb.from("lge_outcomes")
        .select("id, raw_lead_id, gsc_lead_id, outcome_stage, observed_at, is_manual")
        .eq("org_id", orgId)
        .order("observed_at", { ascending: false })
        .range(Number(off), Number(off) + Math.min(Number(lim), 500) - 1);
      if (campaign_id) {
        const { data: ids } = await sb.from("lge_raw_leads").select("id").eq("campaign_id", campaign_id).eq("org_id", orgId);
        if (ids?.length) q = q.in("raw_lead_id", ids.map((r: any) => r.id));
        else { await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs); return ok({ outcomes: [] }); }
      }
      const { data, error } = await q;
      if (error) return apiErr(error.message, 500);
      await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs);
      return ok({ outcomes: data ?? [] });
    }

    // ── POST ingest ───────────────────────────────────────────────────────────
    if (action === "ingest" || endpoint === "ingest") {
      if (!scopes.includes("ingest")) return apiErr("Scope 'ingest' required", 403);
      const body = await req.json().catch(() => null);
      if (!body) return apiErr("JSON body required", 400);

      const { campaign_id, name, email, phone, company, raw_data } = body;
      if (!campaign_id) return apiErr("campaign_id required", 400);
      if (!name && !email && !phone) return apiErr("At least one of name, email, phone required", 400);

      // Verify campaign belongs to org
      const { data: camp } = await sb.from("lge_campaigns")
        .select("id, status").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
      if (!camp) return apiErr("Campaign not found", 404);
      if (camp.status !== "active") return apiErr("Campaign is not active", 422);

      const { data: lead, error: insErr } = await sb.from("lge_raw_leads").insert({
        org_id: orgId,
        campaign_id,
        name: name ?? null,
        email: email ?? null,
        phone: phone ?? null,
        company: company ?? null,
        source: "api",
        raw_data: raw_data ?? {},
        status: "pending",
        attempt: 0,
        max_attempts: 3,
      }).select("id, status, created_at").single();

      if (insErr) return apiErr(insErr.message, 500);

      // Increment usage
      await sb.rpc("lge_increment_usage", { p_org_id: orgId, p_field: "leads_ingested" }).then(undefined, () => {});

      await logRequest(sb, keyId, orgId, endpoint, req.method, 201, startMs);
      return ok({ lead_id: lead.id, status: lead.status, created_at: lead.created_at }, 201);
    }

    // ── POST score (inline — no DB write) ────────────────────────────────────
    if (action === "score" || endpoint === "score") {
      if (!scopes.includes("score")) return apiErr("Scope 'score' required", 403);
      const body = await req.json().catch(() => null);
      if (!body) return apiErr("JSON body required", 400);

      const { lead, icp_config = {}, thresholds = {} } = body;
      if (!lead) return apiErr("lead object required", 400);

      const leadForScoring = {
        name: lead.name ?? null,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        company: lead.company ?? null,
        designation: lead.designation ?? null,
      };

      // Minimal enrichment from provided data
      const enrich = {
        industry: lead.industry ?? null,
        company_size: lead.company_size ?? null,
        designation: lead.designation ?? null,
        email_verified: lead.email_verified ?? null,
        phone_valid: lead.phone_valid ?? null,
        phone_line_type: lead.phone_line_type ?? null,
        website_reachable: lead.website_reachable ?? null,
      };

      const fitScore        = computeFitScore(enrich, icp_config);
      const confidenceScore = computeConfidenceScore(leadForScoring, enrich, 0);
      const fitWeight       = typeof icp_config.fit_weight === "number" ? icp_config.fit_weight : 0.6;
      const confWeight      = typeof icp_config.confidence_weight === "number" ? icp_config.confidence_weight : 0.4;
      const totalScore      = computeTotalScore(fitScore, confidenceScore, fitWeight, confWeight);
      const autoThreshold   = thresholds.auto_push ?? 80;
      const reviewThreshold = thresholds.review     ?? 60;
      const decision        = routeByScore(totalScore, autoThreshold, reviewThreshold);

      await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs);
      return ok({ fit_score: fitScore, confidence_score: confidenceScore, total_score: totalScore, decision });
    }

    // ── GET usage ─────────────────────────────────────────────────────────────
    if (action === "usage" || endpoint === "usage") {
      if (!scopes.includes("read")) return apiErr("Scope 'read' required", 403);
      const { data: usage } = await sb.from("lge_usage_metrics")
        .select("*").eq("org_id", orgId).eq("window_date", new Date().toISOString().slice(0, 10)).maybeSingle();
      const { data: quota } = await sb.from("lge_plan_quotas").select("*").eq("org_id", orgId).maybeSingle();
      await logRequest(sb, keyId, orgId, endpoint, req.method, 200, startMs);
      return ok({ today: usage ?? { org_id: orgId, window_date: new Date().toISOString().slice(0, 10) }, quotas: quota ?? null });
    }

    await logRequest(sb, keyId, orgId, endpoint, req.method, 400, startMs);
    return apiErr(`Unknown action: ${action}`, 400);
  } catch (e: any) {
    console.error("[lge_public_api] error:", e.message);
    await logRequest(sb, keyId, orgId, endpoint, req.method, 500, startMs);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
