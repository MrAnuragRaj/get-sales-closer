// lge_policy_manage — Phase 13: Adaptive Intelligence, Experimentation, Vertical Packs
// Actions:
//   generate_recommendations | list_recommendations | accept_recommendation | reject_recommendation
//   list_experiments | create_experiment | stop_experiment | evaluate_experiment
//   list_vertical_packs | apply_vertical_pack

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY    = Deno.env.get("OPENAI_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ── Permission resolver ──────────────────────────────────────────────────────
async function resolveOrgAndRole(req: Request, adminSb: ReturnType<typeof createClient>):
  Promise<{ orgId: string; role: "admin" | "operator" | "viewer" } | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const userSb = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
  const { data: { user }, error } = await userSb.auth.getUser();
  if (error || !user) return null;

  // Check platform admin
  const { data: profile } = await adminSb.from("profiles")
    .select("is_admin").eq("id", user.id).maybeSingle();
  if (profile?.is_admin) {
    const { data: m } = await adminSb.from("org_members")
      .select("org_id").eq("user_id", user.id).limit(1);
    if (m && m.length > 0) return { orgId: m[0].org_id, role: "admin" };
    // platform admin with no membership — look up profile org_id
    const { data: m2 } = await adminSb.from("organizations")
      .select("id").limit(1);
    if (m2 && m2.length > 0) return { orgId: m2[0].id, role: "admin" };
    return null;
  }

  const { data: membership } = await adminSb.from("org_members")
    .select("org_id, role").eq("user_id", user.id).limit(1);
  if (!membership || membership.length === 0) return null;
  const { org_id, role: memberRole } = membership[0];

  let resolvedRole: "admin" | "operator" | "viewer" = "viewer";
  if (!memberRole || memberRole === "agency_admin" || memberRole === "enterprise_admin") {
    resolvedRole = "admin";
  } else if (memberRole === "enterprise_agent") {
    resolvedRole = "operator";
  }
  return { orgId: org_id, role: resolvedRole };
}

// ── Calibration metrics helper (for recommendations generation) ──────────────
async function fetchCampaignMetrics(adminSb: ReturnType<typeof createClient>, orgId: string, campaignId: string) {
  const LAG_MS = 48 * 60 * 60 * 1000;
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const lagCutoff = new Date(Date.now() - LAG_MS).toISOString();

  const { data: rawLeads } = await adminSb.from("lge_raw_leads")
    .select("id, status, created_at, source")
    .eq("org_id", orgId).eq("campaign_id", campaignId)
    .gte("created_at", cutoff30d).limit(5000);

  if (!rawLeads || rawLeads.length === 0) return null;

  const ids = rawLeads.map((r: any) => r.id);
  const allIds = new Set(ids);

  const { data: scores } = await adminSb.from("lge_scores")
    .select("raw_lead_id, total_score, is_manual_override").in("raw_lead_id", ids);
  const { data: outcomes } = await adminSb.from("lge_outcomes")
    .select("raw_lead_id, outcome_stage").in("raw_lead_id", ids);

  const scoreMap = new Map((scores ?? []).map((s: any) => [s.raw_lead_id, s]));
  const outcomeMap = new Map((outcomes ?? []).map((o: any) => [o.raw_lead_id, o]));

  const pushed = rawLeads.filter((r: any) => r.status === "pushed");
  const pushedLag = pushed.filter((r: any) => new Date(r.created_at) <= new Date(lagCutoff));
  const failed = rawLeads.filter((r: any) => r.status === "failed_enrichment");
  const review = rawLeads.filter((r: any) => r.status === "review_queue");

  let pushedReplied = 0;
  for (const r of pushedLag) {
    const o = outcomeMap.get(r.id);
    if (o && ["replied", "booked", "closed"].includes(o.outcome_stage)) pushedReplied++;
  }

  const falsePushRate = pushedLag.length >= 20
    ? (pushedLag.filter((r: any) => {
        const o = outcomeMap.get(r.id);
        return !o || o.outcome_stage === "no_reply";
      }).length / pushedLag.length) * 100
    : null;

  const replyRate = pushedLag.length >= 20
    ? (pushedReplied / pushedLag.length) * 100
    : null;

  const failureRate = rawLeads.length > 0
    ? (failed.length / rawLeads.length) * 100 : 0;

  // Source breakdown
  const sourceCounts: Record<string, number> = {};
  for (const r of rawLeads) {
    const src = r.source ?? "unknown";
    sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
  }

  return {
    totalLeads: rawLeads.length,
    pushed: pushed.length,
    pushedLag: pushedLag.length,
    review: review.length,
    failed: failed.length,
    falsePushRate,
    replyRate,
    failureRate,
    sourceCounts,
  };
}

// ── Recommendations generation via GPT-4o-mini ──────────────────────────────
async function generateRecommendations(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  campaignId: string | null,
  campaignName: string,
  currentPolicy: Record<string, any>,
  metrics: { totalLeads: number; pushed: number; pushedLag: number; review: number; failed: number; falsePushRate: number | null; replyRate: number | null; failureRate: number; sourceCounts: Record<string, number> }
) {
  const prompt = `You are an expert sales operations advisor analyzing a lead generation campaign.

Campaign: "${campaignName}"
Current ICP Config: ${JSON.stringify(currentPolicy.icp_config ?? {}, null, 2)}
Current Thresholds: auto_push=${currentPolicy.thresholds?.auto_push ?? 80}, review_min=${currentPolicy.thresholds?.review_min ?? 60}

30-day Metrics (last 30 days, 48h outcome lag applied):
- Total leads processed: ${metrics.totalLeads}
- Pushed to sales: ${metrics.pushed}
- Outcome-eligible pushed (48h+ old): ${metrics.pushedLag}
- In review queue: ${metrics.review}
- Failed enrichment: ${metrics.failed}
- False push rate (no-reply %): ${metrics.falsePushRate !== null ? metrics.falsePushRate.toFixed(1) + "%" : "insufficient data (<20 outcome-eligible leads)"}
- Reply rate: ${metrics.replyRate !== null ? metrics.replyRate.toFixed(1) + "%" : "insufficient data"}
- Enrichment failure rate: ${metrics.failureRate.toFixed(1)}%
- Sources: ${JSON.stringify(metrics.sourceCounts)}

Generate 2-4 specific, actionable policy recommendations. Each must be:
1. Based directly on the metrics above
2. Concrete (change a specific threshold number, add/remove a designation, etc.)
3. Justified with a reason tied to the data

Return a JSON array of recommendations, each with:
{
  "recommendation_type": "threshold_adjustment" | "icp_refinement" | "source_quality" | "review_hygiene",
  "title": "short action title",
  "current_policy_json": { the relevant current config },
  "recommended_policy_json": { the specific change to make },
  "justification_json": { "reason": "...", "expected_impact": "...", "data_basis": "..." },
  "confidence_level": "low" | "medium" | "high",
  "severity": "info" | "warning" | "high"
}

Return ONLY the JSON array, no prose.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
  const json = await res.json();
  let content = json.choices?.[0]?.message?.content ?? "{}";

  // Parse — GPT might wrap in an object key
  let parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    // find the array value
    const arr = Object.values(parsed).find(Array.isArray);
    parsed = arr ?? [];
  }

  // Insert into DB
  const rows = parsed.map((r: any) => ({
    org_id: orgId,
    campaign_id: campaignId,
    recommendation_type: r.recommendation_type ?? "icp_refinement",
    title: r.title ?? "Unnamed recommendation",
    current_policy_json: r.current_policy_json ?? {},
    recommended_policy_json: r.recommended_policy_json ?? {},
    justification_json: r.justification_json ?? {},
    confidence_level: ["low","medium","high"].includes(r.confidence_level) ? r.confidence_level : "medium",
    severity: ["info","warning","high"].includes(r.severity) ? r.severity : "info",
    status: "open",
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }));

  if (rows.length > 0) {
    await adminSb.from("lge_policy_recommendations").insert(rows);
  }
  return rows;
}

// ── Experiment evaluation ────────────────────────────────────────────────────
async function evaluateExperiment(adminSb: ReturnType<typeof createClient>, experimentId: string, orgId: string) {
  const { data: exp, error } = await adminSb.from("lge_experiments")
    .select("*").eq("id", experimentId).eq("org_id", orgId).maybeSingle();
  if (error || !exp) return null;

  // Get leads processed since experiment started
  const { data: rawLeads } = await adminSb.from("lge_raw_leads")
    .select("id, status, created_at")
    .eq("org_id", orgId)
    .eq("campaign_id", exp.campaign_id)
    .gte("created_at", exp.started_at)
    .limit(2000);

  if (!rawLeads || rawLeads.length < 10) {
    return { evaluated: false, reason: "insufficient_data", lead_count: rawLeads?.length ?? 0 };
  }

  const ids = rawLeads.map((r: any) => r.id);
  const lagCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const lagIds = rawLeads
    .filter((r: any) => new Date(r.created_at) <= new Date(lagCutoff))
    .map((r: any) => r.id);

  if (lagIds.length < 10) {
    return { evaluated: false, reason: "insufficient_outcome_data", outcome_eligible: lagIds.length };
  }

  const { data: outcomes } = await adminSb.from("lge_outcomes")
    .select("raw_lead_id, outcome_stage").in("raw_lead_id", lagIds);

  const outcomeMap = new Map((outcomes ?? []).map((o: any) => [o.raw_lead_id, o]));

  // For shadow experiments: variant_b is the shadow; we simulate what would have happened
  // For alternating: leads alternate between A and B — we'd need metadata tagging (not yet built)
  // Current evaluation: compare overall reply rate vs variant thresholds
  const variantA = exp.variant_a_json as any;
  const variantB = exp.variant_b_json as any;

  const { data: scores } = await adminSb.from("lge_scores")
    .select("raw_lead_id, total_score").in("raw_lead_id", lagIds);
  const scoreMap = new Map((scores ?? []).map((s: any) => [s.raw_lead_id, s.total_score]));

  const aThreshold = variantA.auto_push ?? 80;
  const bThreshold = variantB.auto_push ?? 75;

  let aWouldPush = 0, aReplied = 0, bWouldPush = 0, bReplied = 0;

  for (const id of lagIds) {
    const score = scoreMap.get(id) ?? 0;
    const o = outcomeMap.get(id);
    const replied = o && ["replied","booked","closed"].includes(o.outcome_stage);

    if (score >= aThreshold) {
      aWouldPush++;
      if (replied) aReplied++;
    }
    if (score >= bThreshold) {
      bWouldPush++;
      if (replied) bReplied++;
    }
  }

  const aReplyRate = aWouldPush > 0 ? (aReplied / aWouldPush) * 100 : 0;
  const bReplyRate = bWouldPush > 0 ? (bReplied / bWouldPush) * 100 : 0;

  const SIGNIFICANCE_DELTA = 5; // 5pp minimum meaningful difference
  let winner: "a" | "b" | "inconclusive" = "inconclusive";
  if (Math.abs(aReplyRate - bReplyRate) >= SIGNIFICANCE_DELTA) {
    winner = aReplyRate > bReplyRate ? "a" : "b";
  }

  const result = {
    variant_a: { threshold: aThreshold, would_push: aWouldPush, replied: aReplied, reply_rate: aReplyRate },
    variant_b: { threshold: bThreshold, would_push: bWouldPush, replied: bReplied, reply_rate: bReplyRate },
    outcome_eligible: lagIds.length,
    significance_delta: SIGNIFICANCE_DELTA,
    winner,
    evaluated_at: new Date().toISOString(),
  };

  await adminSb.from("lge_experiments")
    .update({ result_json: result, winner })
    .eq("id", experimentId);

  return { evaluated: true, result, winner };
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function handleGenerateRecommendations(adminSb: ReturnType<typeof createClient>, orgId: string, body: any) {
  const { campaign_id } = body;
  if (!campaign_id) return err("campaign_id required", 400);

  const { data: campaign, error } = await adminSb.from("lge_campaigns")
    .select("id, name, icp_config, status").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (error || !campaign) return err("Campaign not found", 404);

  const metrics = await fetchCampaignMetrics(adminSb, orgId, campaign_id);
  if (!metrics || metrics.totalLeads < 5) {
    return err("Insufficient data — need at least 5 processed leads to generate recommendations", 422);
  }

  try {
    const recommendations = await generateRecommendations(
      adminSb, orgId, campaign_id, campaign.name,
      campaign.icp_config ?? {}, metrics
    );
    return ok({ recommendations, metrics_snapshot: metrics });
  } catch (e: any) {
    return err(`Generation failed: ${e.message}`, 500);
  }
}

async function handleListRecommendations(adminSb: ReturnType<typeof createClient>, orgId: string, body: any) {
  const { campaign_id, status, limit: lim = 50 } = body;
  let q = adminSb.from("lge_policy_recommendations")
    .select("*").eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(lim, 200));

  if (campaign_id) q = q.eq("campaign_id", campaign_id);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return err(error.message, 500);

  // Auto-expire
  const now = new Date().toISOString();
  const openToExpire = (data ?? [])
    .filter((r: any) => r.status === "open" && r.expires_at < now)
    .map((r: any) => r.id);
  if (openToExpire.length > 0) {
    await adminSb.from("lge_policy_recommendations")
      .update({ status: "expired" }).in("id", openToExpire).then(undefined, () => {});
    for (const r of data ?? []) {
      if (openToExpire.includes(r.id)) r.status = "expired";
    }
  }

  return ok({ recommendations: data ?? [] });
}

async function handleActOnRecommendation(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  body: any,
  actorId: string,
  newStatus: "accepted" | "rejected"
) {
  const { recommendation_id } = body;
  if (!recommendation_id) return err("recommendation_id required", 400);

  const { data: rec, error } = await adminSb.from("lge_policy_recommendations")
    .select("id, status, org_id").eq("id", recommendation_id).eq("org_id", orgId).maybeSingle();
  if (error || !rec) return err("Recommendation not found", 404);
  if (rec.status !== "open") return err(`Recommendation is already ${rec.status}`, 409);

  const { error: ue } = await adminSb.from("lge_policy_recommendations")
    .update({ status: newStatus, acted_at: new Date().toISOString(), acted_by: actorId })
    .eq("id", recommendation_id);
  if (ue) return err(ue.message, 500);

  return ok({ success: true, status: newStatus });
}

async function handleListExperiments(adminSb: ReturnType<typeof createClient>, orgId: string, body: any) {
  const { campaign_id, status, limit: lim = 50 } = body;
  let q = adminSb.from("lge_experiments")
    .select("*").eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(lim, 100));
  if (campaign_id) q = q.eq("campaign_id", campaign_id);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  return ok({ experiments: data ?? [] });
}

async function handleCreateExperiment(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  body: any,
  actorId: string
) {
  const { campaign_id, name, experiment_type = "threshold", variant_a_json, variant_b_json,
          assignment_method = "shadow", hypothesis } = body;
  if (!campaign_id || !name || !variant_a_json || !variant_b_json) {
    return err("campaign_id, name, variant_a_json, variant_b_json required", 400);
  }

  const { data: campaign } = await adminSb.from("lge_campaigns")
    .select("id").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!campaign) return err("Campaign not found", 404);

  // Only allow 1 active experiment per campaign
  const { data: existing } = await adminSb.from("lge_experiments")
    .select("id").eq("campaign_id", campaign_id).eq("status", "active").limit(1);
  if (existing && existing.length > 0) {
    return err("Campaign already has an active experiment — stop it before creating a new one", 409);
  }

  const { data, error } = await adminSb.from("lge_experiments").insert({
    org_id: orgId,
    campaign_id,
    name,
    experiment_type: ["threshold","scoring","prompt"].includes(experiment_type) ? experiment_type : "threshold",
    variant_a_json,
    variant_b_json,
    assignment_method: ["shadow","alternating"].includes(assignment_method) ? assignment_method : "shadow",
    hypothesis,
    status: "active",
    created_by: actorId,
  }).select().single();

  if (error) return err(error.message, 500);
  return ok({ experiment: data }, 201);
}

async function handleStopExperiment(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  body: any
) {
  const { experiment_id } = body;
  if (!experiment_id) return err("experiment_id required", 400);

  const { data: exp } = await adminSb.from("lge_experiments")
    .select("id, status").eq("id", experiment_id).eq("org_id", orgId).maybeSingle();
  if (!exp) return err("Experiment not found", 404);
  if (exp.status !== "active") return err("Experiment is not active", 409);

  await adminSb.from("lge_experiments")
    .update({ status: "stopped", stopped_at: new Date().toISOString() })
    .eq("id", experiment_id);

  return ok({ success: true });
}

async function handleEvaluateExperiment(adminSb: ReturnType<typeof createClient>, orgId: string, body: any) {
  const { experiment_id } = body;
  if (!experiment_id) return err("experiment_id required", 400);

  const result = await evaluateExperiment(adminSb, experiment_id, orgId);
  if (!result) return err("Experiment not found", 404);
  return ok(result);
}

async function handleListVerticalPacks(adminSb: ReturnType<typeof createClient>) {
  const { data, error } = await adminSb.from("lge_vertical_packs")
    .select("id, slug, name, description, version, config_json, is_active")
    .eq("is_active", true)
    .order("name");
  if (error) return err(error.message, 500);
  return ok({ packs: data ?? [] });
}

async function handleApplyVerticalPack(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  body: any,
  actorId: string
) {
  const { campaign_id, pack_id } = body;
  if (!campaign_id || !pack_id) return err("campaign_id and pack_id required", 400);

  const { data: campaign, error: ce } = await adminSb.from("lge_campaigns")
    .select("*").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (ce || !campaign) return err("Campaign not found", 404);

  const { data: pack, error: pe } = await adminSb.from("lge_vertical_packs")
    .select("*").eq("id", pack_id).eq("is_active", true).maybeSingle();
  if (pe || !pack) return err("Vertical pack not found", 404);

  const cfg = pack.config_json as any;

  // Snapshot current state
  const snapshotBefore = {
    icp_config: campaign.icp_config,
    status: campaign.status,
    pack_applied_at: campaign.pack_applied_at ?? null,
  };

  // Merge pack config into campaign
  const mergedIcp = {
    ...(campaign.icp_config ?? {}),
    ...(cfg.icp_config ?? {}),
  };

  const { error: ue } = await adminSb.from("lge_campaigns")
    .update({
      icp_config: mergedIcp,
      // Store pack metadata so UI can show which pack is applied
      pack_id: pack_id,
      pack_applied_at: new Date().toISOString(),
    })
    .eq("id", campaign_id);

  if (ue) {
    // If pack_id column doesn't exist yet, just update icp_config
    await adminSb.from("lge_campaigns")
      .update({ icp_config: mergedIcp })
      .eq("id", campaign_id);
  }

  // Write audit trail
  await adminSb.from("lge_pack_applications").insert({
    campaign_id,
    pack_id,
    applied_by: actorId,
    snapshot_before_json: snapshotBefore,
  });

  return ok({ success: true, pack_name: pack.name, merged_icp: mergedIcp });
}

// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const adminSb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const context = await resolveOrgAndRole(req, adminSb);
  if (!context) return err("Unauthorized", 401);
  const { orgId, role } = context;

  // Resolve actor user id
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
  const userSb = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
  const { data: { user } } = await userSb.auth.getUser();
  const actorId = user?.id ?? "";

  // Check LGE entitlement
  const { data: svc } = await adminSb.from("org_services")
    .select("status").eq("org_id", orgId).eq("service_key", "lead_gen").maybeSingle();
  if (svc?.status !== "active") return err("Lead Generation Engine not active for this org", 403);

  let body: any = {};
  try {
    if (req.method !== "GET") body = await req.json();
  } catch { /* empty body OK */ }

  const action = body.action ?? new URL(req.url).searchParams.get("action");

  switch (action) {
    // Recommendations
    case "generate_recommendations":
      if (role === "viewer") return err("Forbidden", 403);
      return handleGenerateRecommendations(adminSb, orgId, body);

    case "list_recommendations":
      return handleListRecommendations(adminSb, orgId, body);

    case "accept_recommendation":
      if (role === "viewer") return err("Forbidden", 403);
      return handleActOnRecommendation(adminSb, orgId, body, actorId, "accepted");

    case "reject_recommendation":
      if (role === "viewer") return err("Forbidden", 403);
      return handleActOnRecommendation(adminSb, orgId, body, actorId, "rejected");

    // Experiments
    case "list_experiments":
      return handleListExperiments(adminSb, orgId, body);

    case "create_experiment":
      if (role === "viewer") return err("Forbidden", 403);
      return handleCreateExperiment(adminSb, orgId, body, actorId);

    case "stop_experiment":
      if (role === "viewer") return err("Forbidden", 403);
      return handleStopExperiment(adminSb, orgId, body);

    case "evaluate_experiment":
      return handleEvaluateExperiment(adminSb, orgId, body);

    // Vertical Packs
    case "list_vertical_packs":
      return handleListVerticalPacks(adminSb);

    case "apply_vertical_pack":
      if (role === "viewer") return err("Forbidden", 403);
      return handleApplyVerticalPack(adminSb, orgId, body, actorId);

    default:
      return err(`Unknown action: ${action}`, 400);
  }
});
