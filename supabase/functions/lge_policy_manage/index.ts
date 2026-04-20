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
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  // Direct fetch to /auth/v1/user — bypasses SDK ES256 local-parse (this project uses ES256 JWTs)
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { "Authorization": `Bearer ${token}`, "apikey": SERVICE_ROLE },
  });
  if (!userResp.ok) return null;
  const userData = await userResp.json();
  const userId: string = userData?.id;
  if (!userId) return null;

  // Wrap as user object for the rest of the function
  const user = { id: userId };

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

// ── Experiment evaluation (Phase 14 upgrade: statistical significance) ─────────
// Uses a two-proportion z-test to determine if the difference between variant
// reply rates is statistically significant at 90% confidence (z ≥ 1.645).
// Minimum sample: 100 outcome-eligible leads per variant (shadow) or 50 each (alternating).
async function evaluateExperiment(adminSb: ReturnType<typeof createClient>, experimentId: string, orgId: string) {
  const { data: exp, error } = await adminSb.from("lge_experiments")
    .select("*").eq("id", experimentId).eq("org_id", orgId).maybeSingle();
  if (error || !exp) return null;

  const { data: rawLeads } = await adminSb.from("lge_raw_leads")
    .select("id, status, created_at")
    .eq("org_id", orgId)
    .eq("campaign_id", exp.campaign_id)
    .gte("created_at", exp.started_at)
    .limit(5000);

  const MIN_PER_VARIANT = 100; // Phase 14: require 100 outcome-eligible leads per variant

  if (!rawLeads || rawLeads.length < MIN_PER_VARIANT) {
    return { evaluated: false, reason: "insufficient_data", lead_count: rawLeads?.length ?? 0, min_required: MIN_PER_VARIANT };
  }

  const lagCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const lagIds = (rawLeads as any[])
    .filter((r: any) => new Date(r.created_at) <= new Date(lagCutoff))
    .map((r: any) => r.id);

  if (lagIds.length < MIN_PER_VARIANT) {
    return { evaluated: false, reason: "insufficient_outcome_data", outcome_eligible: lagIds.length, min_required: MIN_PER_VARIANT };
  }

  const { data: outcomes } = await adminSb.from("lge_outcomes")
    .select("raw_lead_id, outcome_stage").in("raw_lead_id", lagIds);
  const outcomeMap = new Map((outcomes ?? []).map((o: any) => [o.raw_lead_id, o]));

  const { data: scores } = await adminSb.from("lge_scores")
    .select("raw_lead_id, total_score").in("raw_lead_id", lagIds);
  const scoreMap = new Map((scores ?? []).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

  const variantA = exp.variant_a_json as any;
  const variantB = exp.variant_b_json as any;
  const aThreshold = variantA.auto_push ?? 80;
  const bThreshold = variantB.auto_push ?? 75;

  let aWouldPush = 0, aReplied = 0, bWouldPush = 0, bReplied = 0;

  for (const id of lagIds) {
    const score   = scoreMap.get(id) ?? 0;
    const o       = outcomeMap.get(id);
    const replied = !!o && ["replied","booked","closed"].includes((o as any).outcome_stage);

    if (score >= aThreshold) { aWouldPush++; if (replied) aReplied++; }
    if (score >= bThreshold) { bWouldPush++; if (replied) bReplied++; }
  }

  if (aWouldPush < MIN_PER_VARIANT || bWouldPush < MIN_PER_VARIANT) {
    return {
      evaluated: false,
      reason: "insufficient_variant_sample",
      variant_a_sample: aWouldPush,
      variant_b_sample: bWouldPush,
      min_per_variant:  MIN_PER_VARIANT,
    };
  }

  const aReplyRate = (aReplied / aWouldPush) * 100;
  const bReplyRate = (bReplied / bWouldPush) * 100;

  // Two-proportion z-test
  const pA = aReplied / aWouldPush;
  const pB = bReplied / bWouldPush;
  const pPool = (aReplied + bReplied) / (aWouldPush + bWouldPush);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / aWouldPush + 1 / bWouldPush));
  const zStat = se > 0 ? Math.abs(pA - pB) / se : 0;

  // 90% CI → z = 1.645; 95% CI → z = 1.96
  const Z_90 = 1.645;
  const Z_95 = 1.96;
  const significant90 = zStat >= Z_90;
  const significant95 = zStat >= Z_95;
  const confidence    = significant95 ? 0.95 : significant90 ? 0.90 : Math.min(0.89, zStat / Z_90 * 0.89);

  let winner: "a" | "b" | "inconclusive" = "inconclusive";
  if (significant90) winner = aReplyRate > bReplyRate ? "a" : "b";

  const status = significant90 ? "significant" : "inconclusive";
  const delta  = Math.abs(aReplyRate - bReplyRate);

  const result = {
    variant_a:          { threshold: aThreshold, would_push: aWouldPush, replied: aReplied, reply_rate: Math.round(aReplyRate * 10) / 10 },
    variant_b:          { threshold: bThreshold, would_push: bWouldPush, replied: bReplied, reply_rate: Math.round(bReplyRate * 10) / 10 },
    outcome_eligible:   lagIds.length,
    z_stat:             Math.round(zStat * 1000) / 1000,
    confidence:         Math.round(confidence * 1000) / 1000,
    significant_at_90:  significant90,
    significant_at_95:  significant95,
    delta:              Math.round(delta * 10) / 10,
    status,
    winner,
    evaluated_at:       new Date().toISOString(),
  };

  await adminSb.from("lge_experiments")
    .update({ result_json: result, winner })
    .eq("id", experimentId);

  return { evaluated: true, result, winner };
}

// ── Policy simulation (Phase 14) ────────────────────────────────────────────────
// Simulates the effect of changing push/review thresholds on historical leads
// (last 30 days, outcome-eligible) without actually applying any change.
async function simulatePolicy(
  adminSb: ReturnType<typeof createClient>,
  orgId: string,
  campaignId: string,
  newAutoThreshold: number,
  newReviewThreshold: number,
  actorId: string,
) {
  const LAG_MS    = 48 * 60 * 60 * 1000;
  const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const lagCutoff   = new Date(Date.now() - LAG_MS).toISOString();
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data: campaign } = await adminSb.from("lge_campaigns")
    .select("auto_push_threshold, review_threshold")
    .eq("id", campaignId).eq("org_id", orgId).maybeSingle();
  if (!campaign) throw new Error("Campaign not found");

  const { data: rawLeads } = await adminSb.from("lge_raw_leads")
    .select("id, status")
    .eq("org_id", orgId).eq("campaign_id", campaignId)
    .gte("created_at", windowStart).lt("updated_at", lagCutoff)
    .limit(5000);

  if (!rawLeads?.length) {
    return { simulated: false, reason: "no_outcome_eligible_leads" };
  }

  const ids = (rawLeads as any[]).map((l: any) => l.id);
  const { data: scores } = await adminSb.from("lge_scores")
    .select("raw_lead_id, total_score").in("raw_lead_id", ids);
  const scoreMap = new Map((scores ?? []).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

  const { data: outcomes } = await adminSb.from("lge_outcomes")
    .select("raw_lead_id, outcome_stage").in("raw_lead_id", ids);
  const outcomeMap = new Map((outcomes ?? []).map((o: any) => [o.raw_lead_id, (o as any).outcome_stage]));

  const oldAuto   = campaign.auto_push_threshold;
  const oldReview = campaign.review_threshold;

  const simulate = (autoT: number, reviewT: number) => {
    let push = 0, review = 0, discard = 0;
    let pushReplied = 0, pushNoReply = 0;
    for (const id of ids) {
      const score = scoreMap.get(id) ?? 0;
      if (score >= autoT) {
        push++;
        const stage = outcomeMap.get(id);
        if (stage && ["replied","booked","closed"].includes(stage)) pushReplied++;
        else if (stage === "no_reply") pushNoReply++;
      } else if (score >= reviewT) { review++; }
      else { discard++; }
    }
    const withOutcome = pushReplied + pushNoReply;
    return {
      push, review, discard,
      reply_rate:       withOutcome > 0 ? Math.round((pushReplied / withOutcome) * 100 * 10) / 10 : null,
      false_push_rate:  withOutcome > 0 ? Math.round((pushNoReply / withOutcome) * 100 * 10) / 10 : null,
    };
  };

  const oldResult = simulate(oldAuto,         oldReview);
  const newResult = simulate(newAutoThreshold, newReviewThreshold);

  const simulatedOutput = {
    old_policy:    { auto_push_threshold: oldAuto, review_threshold: oldReview,         ...oldResult },
    new_policy:    { auto_push_threshold: newAutoThreshold, review_threshold: newReviewThreshold, ...newResult },
    delta: {
      push:            newResult.push   - oldResult.push,
      review:          newResult.review - oldResult.review,
      discard:         newResult.discard - oldResult.discard,
      reply_rate_est:  (newResult.reply_rate ?? 0) - (oldResult.reply_rate ?? 0),
      false_push_est:  (newResult.false_push_rate ?? 0) - (oldResult.false_push_rate ?? 0),
    },
    sample_size:   ids.length,
    simulated_at:  new Date().toISOString(),
  };

  // Persist simulation for audit/reference
  await adminSb.from("lge_policy_simulations").insert({
    org_id: orgId,
    campaign_id: campaignId,
    input_policy_json: { auto_push_threshold: newAutoThreshold, review_threshold: newReviewThreshold },
    simulated_output_json: simulatedOutput,
    created_by: actorId,
  });

  return { simulated: true, result: simulatedOutput };
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

    // ── Phase 14: Policy Simulation ──────────────────────────────────────────
    case "simulate_policy": {
      if (role === "viewer") return err("Forbidden", 403);
      const { campaign_id, auto_push_threshold, review_threshold } = body;
      if (!campaign_id || auto_push_threshold == null || review_threshold == null) {
        return err("campaign_id, auto_push_threshold, review_threshold required", 400);
      }
      if (Number(auto_push_threshold) <= Number(review_threshold)) {
        return err("auto_push_threshold must be greater than review_threshold", 400);
      }
      try {
        const result = await simulatePolicy(adminSb, orgId, campaign_id, Number(auto_push_threshold), Number(review_threshold), actorId);
        return ok(result);
      } catch (e: any) { return err(e.message, 500); }
    }

    // ── Phase 14: Auto-Assist Mode ────────────────────────────────────────────
    case "update_auto_assist_mode": {
      if (role !== "admin") return err("admin role required", 403);
      const { campaign_id, auto_assist_mode } = body;
      if (!campaign_id || !auto_assist_mode) return err("campaign_id, auto_assist_mode required", 400);
      if (!["off","suggest_only","assist"].includes(auto_assist_mode)) return err("auto_assist_mode must be off|suggest_only|assist", 400);

      const { data: camp } = await adminSb.from("lge_campaigns")
        .select("id").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
      if (!camp) return err("Campaign not found", 404);

      const { error: ue } = await adminSb.from("lge_campaigns")
        .update({ auto_assist_mode }).eq("id", campaign_id);
      if (ue) return err(ue.message, 500);
      return ok({ ok: true, campaign_id, auto_assist_mode });
    }

    // ── Phase 14: Auto-Assist Action History ──────────────────────────────────
    case "list_auto_assist_actions": {
      const { campaign_id, limit: lim = 50 } = body;
      if (!campaign_id) return err("campaign_id required", 400);
      const { data, error: qe } = await adminSb.from("lge_auto_assist_actions")
        .select("*")
        .eq("campaign_id", campaign_id).eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(Math.min(lim, 200));
      if (qe) return err(qe.message, 500);
      return ok({ actions: data ?? [] });
    }

    case "reverse_auto_assist_action": {
      if (role !== "admin") return err("admin role required", 403);
      const { action_id } = body;
      if (!action_id) return err("action_id required", 400);

      const { data: action } = await adminSb.from("lge_auto_assist_actions")
        .select("*").eq("id", action_id).eq("org_id", orgId).maybeSingle();
      if (!action) return err("Action not found", 404);
      if (!action.is_reversible) return err("Action is not reversible", 400);
      if (action.reversed_at) return err("Action already reversed", 409);

      // Reverse the threshold or source_downweight
      if (action.action_type === "threshold_adjust") {
        const before = action.before_json as any;
        await adminSb.from("lge_campaigns")
          .update({ auto_push_threshold: before.auto_push_threshold })
          .eq("id", action.campaign_id);
      } else if (action.action_type === "source_downweight") {
        const before = action.before_json as any;
        await adminSb.from("lge_source_stats").upsert(
          { org_id: orgId, source: before.source, confidence_adj: before.confidence_adj },
          { onConflict: "org_id,source" }
        );
      }

      await adminSb.from("lge_auto_assist_actions")
        .update({ reversed_at: new Date().toISOString(), reversed_by: actorId })
        .eq("id", action_id);

      return ok({ ok: true, action_id, reversed: true });
    }

    // ── Phase 14: Recommendation feedback ────────────────────────────────────
    case "list_recommendation_feedback": {
      const { campaign_id, limit: lim = 30 } = body;
      let q = adminSb.from("lge_recommendation_feedback")
        .select("id, recommendation_id, evaluation_window_days, before_metrics_json, after_metrics_json, effectiveness_score, evaluated_at")
        .eq("org_id", orgId)
        .order("evaluated_at", { ascending: false })
        .limit(Math.min(lim, 100));
      if (campaign_id) {
        // Join via recommendation_id (filter by campaign's recs)
        const { data: campRecs } = await adminSb.from("lge_policy_recommendations")
          .select("id").eq("campaign_id", campaign_id).eq("org_id", orgId);
        const recIds = (campRecs ?? []).map((r: any) => r.id);
        if (recIds.length) q = q.in("recommendation_id", recIds);
        else return ok({ feedback: [] });
      }
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ feedback: data ?? [] });
    }

    // ── Phase 15: Global Patterns ─────────────────────────────────────────────
    case "list_global_patterns": {
      const { pattern_type, limit: lim = 50 } = body;
      let q = adminSb.from("lge_global_patterns")
        .select("*").eq("org_id", orgId)
        .order("computed_at", { ascending: false })
        .limit(Math.min(lim, 200));
      if (pattern_type) q = q.eq("pattern_type", pattern_type);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ patterns: data ?? [] });
    }

    // ── Phase 15: Org Policy Engine ───────────────────────────────────────────
    case "get_org_policy": {
      const { data } = await adminSb.from("lge_org_policies")
        .select("*").eq("org_id", orgId).maybeSingle();
      return ok({ policy: data ?? { org_id: orgId, max_daily_push: 100, allowed_sources: null, blocked_sources: null, compliance_filters: {}, risk_threshold: 0, pii_handling_rules: {} } });
    }

    case "update_org_policy": {
      if (role !== "admin") return err("admin role required", 403);
      const { max_daily_push, allowed_sources, blocked_sources, compliance_filters, risk_threshold, pii_handling_rules } = body;
      const updates: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
      if (max_daily_push     != null) updates.max_daily_push      = Math.max(1, Math.min(10000, Number(max_daily_push)));
      if (allowed_sources    != null) updates.allowed_sources     = Array.isArray(allowed_sources) ? allowed_sources : null;
      if (blocked_sources    != null) updates.blocked_sources     = Array.isArray(blocked_sources) ? blocked_sources : null;
      if (compliance_filters != null) updates.compliance_filters  = compliance_filters;
      if (risk_threshold     != null) updates.risk_threshold      = Math.max(0, Math.min(100, Number(risk_threshold)));
      if (pii_handling_rules != null) updates.pii_handling_rules  = pii_handling_rules;
      const { error: ue } = await adminSb.from("lge_org_policies").upsert(updates, { onConflict: "org_id" });
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 15: Cost Metrics ────────────────────────────────────────────────
    case "get_cost_metrics": {
      const { campaign_id, days = 30 } = body;
      const since = new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let q = adminSb.from("lge_cost_metrics")
        .select("*").eq("org_id", orgId)
        .gte("period_date", since)
        .order("period_date", { ascending: false })
        .limit(365);
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      else q = q.is("campaign_id", null);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ cost_metrics: data ?? [], days: Math.min(days, 365) });
    }

    // ── Phase 16: Replay Engine ───────────────────────────────────────────────
    // Runs in-memory: reads existing lge_scores, applies new thresholds, writes lge_replay_results.
    // Does NOT mutate lge_raw_leads or any live table.
    case "create_replay": {
      if (role === "viewer") return err("Forbidden", 403);
      const { campaign_id, name, auto_push_threshold = 80, review_threshold = 60,
              date_from, date_to, source_adj_overrides } = body;
      if (!campaign_id) return err("campaign_id required", 400);
      if (!name) return err("name required", 400);
      if (Number(auto_push_threshold) <= Number(review_threshold))
        return err("auto_push_threshold must be greater than review_threshold", 400);

      // Quota check
      const { data: quotaExceeded } = await adminSb.rpc("lge_check_quota", { p_org_id: orgId, p_field: "replay_runs" });
      if (quotaExceeded) return err("Daily replay quota exceeded", 429);

      const { data: camp } = await adminSb.from("lge_campaigns")
        .select("id, auto_push_threshold, review_threshold").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
      if (!camp) return err("Campaign not found", 404);

      // Fetch scored leads for the campaign
      let leadsQuery = adminSb.from("lge_raw_leads")
        .select("id, status, created_at")
        .eq("org_id", orgId).eq("campaign_id", campaign_id)
        .not("status", "in", '("pending","enriching")')
        .limit(5000);
      if (date_from) leadsQuery = leadsQuery.gte("created_at", date_from);
      if (date_to)   leadsQuery = leadsQuery.lte("created_at", date_to);
      const { data: leads } = await leadsQuery;

      if (!leads?.length) {
        return err("No processed leads found for this campaign (filter returned 0 results)", 422);
      }

      const ids = (leads as any[]).map((l: any) => l.id);
      const { data: scores } = await adminSb.from("lge_scores")
        .select("raw_lead_id, total_score").in("raw_lead_id", ids);
      const scoreMap = new Map((scores ?? []).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

      // Determine original decision from status
      const decisionFromStatus = (status: string) =>
        status === "pushed" ? "auto_push"
        : status === "review_queue" ? "review_queue"
        : status === "discarded" ? "discard"
        : status === "scored" ? "shadow_only"
        : "unknown";

      const autoT   = Number(auto_push_threshold);
      const reviewT = Number(review_threshold);

      const newDecisionFn = (score: number) =>
        score >= autoT ? "auto_push" : score >= reviewT ? "review_queue" : "discard";

      // Build results
      const results = (leads as any[]).map((l: any) => {
        const origScore = scoreMap.get(l.id) ?? null;
        const newScore  = origScore;  // score doesn't change, only routing thresholds
        const origDec   = decisionFromStatus(l.status);
        const newDec    = origScore !== null ? newDecisionFn(origScore) : "unknown";
        const changed   = origDec !== newDec;
        const pushChg   = (origDec === "auto_push") !== (newDec === "auto_push");
        return {
          replay_id: null as string | null,  // will be filled after insert
          lead_id: l.id,
          original_total_score: origScore,
          new_total_score: newScore,
          score_delta: 0,
          original_decision: origDec,
          new_decision: newDec,
          decision_changed: changed,
          push_changed: pushChg,
        };
      });

      const changedCount = results.filter((r: any) => r.decision_changed).length;
      const pushDelta    = results.filter((r: any) => r.new_decision === "auto_push").length
                         - results.filter((r: any) => r.original_decision === "auto_push").length;

      // Create replay record
      const { data: replay, error: repErr } = await adminSb.from("lge_replays").insert({
        org_id: orgId,
        campaign_id,
        name,
        policy_snapshot_json: { auto_push_threshold: autoT, review_threshold: reviewT, source_adj_overrides: source_adj_overrides ?? null,
                                 compared_against: { auto_push_threshold: camp.auto_push_threshold, review_threshold: camp.review_threshold } },
        scope_filter_json: { date_from: date_from ?? null, date_to: date_to ?? null },
        status: "completed",
        total_leads: results.length,
        changed_count: changedCount,
        push_delta: pushDelta,
        created_by: actorId,
        completed_at: new Date().toISOString(),
      }).select("id").single();

      if (repErr || !replay) return err(repErr?.message ?? "Replay create failed", 500);

      // Insert per-lead results in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < results.length; i += CHUNK) {
        const chunk = results.slice(i, i + CHUNK).map((r: any) => ({ ...r, replay_id: replay.id }));
        await adminSb.from("lge_replay_results").insert(chunk).then(undefined, (e: any) => console.warn("[replay] insert chunk err:", e.message));
      }

      // Increment usage
      await adminSb.rpc("lge_increment_usage", { p_org_id: orgId, p_field: "replay_runs" }).then(undefined, () => {});

      return ok({ replay_id: replay.id, total_leads: results.length, changed_count: changedCount, push_delta: pushDelta }, 201);
    }

    case "list_replays": {
      const { campaign_id, limit: lim = 20 } = body;
      let q = adminSb.from("lge_replays").select("id, name, campaign_id, status, total_leads, changed_count, push_delta, created_by, created_at, completed_at, policy_snapshot_json")
        .eq("org_id", orgId).order("created_at", { ascending: false }).limit(Math.min(lim, 100));
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ replays: data ?? [] });
    }

    case "get_replay": {
      const { replay_id } = body;
      if (!replay_id) return err("replay_id required", 400);
      const { data: replay, error: re } = await adminSb.from("lge_replays")
        .select("*").eq("id", replay_id).eq("org_id", orgId).maybeSingle();
      if (re || !replay) return err("Replay not found", 404);
      return ok({ replay });
    }

    case "get_replay_results": {
      const { replay_id, changed_only = false, limit: lim = 100, offset: off = 0 } = body;
      if (!replay_id) return err("replay_id required", 400);

      // Verify replay belongs to org
      const { data: rep } = await adminSb.from("lge_replays").select("id").eq("id", replay_id).eq("org_id", orgId).maybeSingle();
      if (!rep) return err("Replay not found", 404);

      let q = adminSb.from("lge_replay_results").select("*")
        .eq("replay_id", replay_id)
        .order("decision_changed", { ascending: false })
        .range(Number(off), Number(off) + Math.min(Number(lim), 500) - 1);
      if (changed_only) q = q.eq("decision_changed", true);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ results: data ?? [] });
    }

    // ── Phase 16: Simulation Profiles ─────────────────────────────────────────
    case "list_simulation_profiles": {
      const { data, error: qe } = await adminSb.from("lge_simulation_profiles")
        .select("*")
        .or(`is_global.eq.true,org_id.eq.${orgId}`)
        .order("name");
      if (qe) return err(qe.message, 500);
      return ok({ profiles: data ?? [] });
    }

    case "create_simulation_profile": {
      if (role === "viewer") return err("Forbidden", 403);
      const { name, vertical, score_band_probabilities_json } = body;
      if (!name || !score_band_probabilities_json) return err("name and score_band_probabilities_json required", 400);
      const { data, error: ie } = await adminSb.from("lge_simulation_profiles").insert({
        org_id: orgId, name, vertical: vertical ?? null,
        score_band_probabilities_json, is_global: false, created_by: actorId,
      }).select().single();
      if (ie) return err(ie.message, 500);
      return ok({ profile: data }, 201);
    }

    // ── Phase 16: Operator Stats ───────────────────────────────────────────────
    case "track_operator_action": {
      const { action: opAction, lead_id, original_decision, override_decision, campaign_id, score_band } = body;
      if (!opAction || !lead_id) return err("action and lead_id required", 400);
      const { error: ie } = await adminSb.from("lge_operator_stats").insert({
        org_id: orgId, campaign_id: campaign_id ?? null, user_id: actorId,
        action: opAction, lead_id, original_decision: original_decision ?? null,
        override_decision: override_decision ?? null, score_band: score_band ?? null,
      });
      if (ie) return err(ie.message, 500);
      return ok({ ok: true });
    }

    case "get_operator_stats": {
      const { campaign_id, days = 30 } = body;
      const since = new Date(Date.now() - Math.min(days, 365) * 24 * 60 * 60 * 1000).toISOString();
      let q = adminSb.from("lge_operator_stats").select("action, score_band, original_decision, override_decision, outcome_within_14d, created_at")
        .eq("org_id", orgId).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);

      // Aggregate: count by action type
      const agg: Record<string, number> = {};
      for (const r of data ?? []) {
        agg[(r as any).action] = (agg[(r as any).action] ?? 0) + 1;
      }
      return ok({ stats: data ?? [], summary: agg });
    }

    // ── Phase 17: Worker Health & SLA ─────────────────────────────────────────
    case "get_worker_health": {
      const { data, error: qe } = await adminSb.from("lge_worker_health")
        .select("*").order("last_seen", { ascending: false }).limit(20);
      if (qe) return err(qe.message, 500);
      return ok({ workers: data ?? [] });
    }

    case "get_sla_metrics": {
      const { campaign_id, days = 7 } = body;
      const since = new Date(Date.now() - Math.min(days, 90) * 24 * 60 * 60 * 1000).toISOString();
      let q = adminSb.from("lge_sla_metrics")
        .select("enrichment_ms, total_pipeline_ms, created_at")
        .eq("org_id", orgId).gte("created_at", since).limit(5000);
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);

      const rows = data ?? [];
      const enrichMs    = (rows as any[]).map((r: any) => r.enrichment_ms).filter(Boolean);
      const pipelineMs  = (rows as any[]).map((r: any) => r.total_pipeline_ms).filter(Boolean);
      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      const p95 = (arr: number[]) => {
        if (!arr.length) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)];
      };

      return ok({
        sample_size: rows.length,
        enrichment:  { avg_ms: avg(enrichMs),   p95_ms: p95(enrichMs) },
        pipeline:    { avg_ms: avg(pipelineMs),  p95_ms: p95(pipelineMs) },
      });
    }

    // ── Phase 17: Dead Letter Queue ───────────────────────────────────────────
    case "get_dead_letter": {
      const { status: dlqStatus = "dead", limit: lim = 50, campaign_id } = body;
      let q = adminSb.from("lge_dead_letter").select("*").eq("org_id", orgId)
        .eq("status", dlqStatus).order("created_at", { ascending: false }).limit(Math.min(lim, 200));
      if (campaign_id) q = q.eq("campaign_id", campaign_id);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ items: data ?? [] });
    }

    case "retry_dead_letter": {
      if (role === "viewer") return err("Forbidden", 403);
      const { dlq_id } = body;
      if (!dlq_id) return err("dlq_id required", 400);
      const { data: item } = await adminSb.from("lge_dead_letter").select("*").eq("id", dlq_id).eq("org_id", orgId).maybeSingle();
      if (!item) return err("DLQ item not found", 404);
      if ((item as any).retry_count >= (item as any).max_retries) return err("Max retries reached — abandon instead", 409);

      if ((item as any).lead_id) {
        await adminSb.from("lge_raw_leads").update({ status: "pending", attempt: 0, locked_by: null, locked_until: null, last_error: null })
          .eq("id", (item as any).lead_id).eq("status", "failed");
      }
      await adminSb.from("lge_dead_letter").update({ status: "retrying", retry_count: (item as any).retry_count + 1, last_retry_at: new Date().toISOString() }).eq("id", dlq_id);
      return ok({ ok: true });
    }

    case "abandon_dead_letter": {
      if (role !== "admin") return err("admin role required", 403);
      const { dlq_id } = body;
      if (!dlq_id) return err("dlq_id required", 400);
      const { error: ue } = await adminSb.from("lge_dead_letter").update({ status: "abandoned" }).eq("id", dlq_id).eq("org_id", orgId);
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 17: Rate Limits ─────────────────────────────────────────────────
    case "get_rate_limits": {
      const { data, error: qe } = await adminSb.from("lge_rate_limits")
        .select("provider, window_date, calls_made, calls_limit, last_updated_at")
        .eq("org_id", orgId)
        .eq("window_date", new Date().toISOString().slice(0, 10))
        .order("provider");
      if (qe) return err(qe.message, 500);
      return ok({ rate_limits: data ?? [] });
    }

    case "update_rate_limit": {
      if (role !== "admin") return err("admin role required", 403);
      const { provider, calls_limit } = body;
      if (!provider || calls_limit == null) return err("provider and calls_limit required", 400);
      const { error: ue } = await adminSb.from("lge_rate_limits").upsert({
        org_id: orgId, provider, window_date: new Date().toISOString().slice(0, 10),
        calls_limit: Math.max(0, Number(calls_limit)), calls_made: 0,
      }, { onConflict: "org_id,provider,window_date" });
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 18: Usage & Quotas ───────────────────────────────────────────────
    case "get_usage_metrics": {
      const { days = 7 } = body;
      const since = new Date(Date.now() - Math.min(days, 90) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [{ data: usage }, { data: quota }] = await Promise.all([
        adminSb.from("lge_usage_metrics").select("*").eq("org_id", orgId)
          .gte("window_date", since).order("window_date", { ascending: false }),
        adminSb.from("lge_plan_quotas").select("*").eq("org_id", orgId).maybeSingle(),
      ]);
      return ok({ usage: usage ?? [], quotas: quota ?? null });
    }

    case "get_plan_quota": {
      const { data, error: qe } = await adminSb.from("lge_plan_quotas").select("*").eq("org_id", orgId).maybeSingle();
      if (qe) return err(qe.message, 500);
      return ok({ quota: data ?? { org_id: orgId, plan_tier: "standard", max_leads_per_day: 500, max_enrichments_per_day: 1000, max_pushes_per_day: 200, max_campaigns: 10, max_replays_per_day: 5 } });
    }

    case "update_plan_quota": {
      if (role !== "admin") return err("admin role required", 403);
      const fields = ["plan_tier","max_leads_per_day","max_enrichments_per_day","max_pushes_per_day","max_campaigns","max_replays_per_day"];
      const updates: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
      for (const f of fields) { if (body[f] != null) updates[f] = body[f]; }
      const { error: ue } = await adminSb.from("lge_plan_quotas").upsert(updates, { onConflict: "org_id" });
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 18: Retention Policy ────────────────────────────────────────────
    case "get_retention_policy": {
      const { data, error: qe } = await adminSb.from("lge_retention_policies").select("*").eq("org_id", orgId).maybeSingle();
      if (qe) return err(qe.message, 500);
      return ok({ policy: data ?? { org_id: orgId, raw_leads_days: 90, enrichment_days: 90, scores_days: 180, decisions_days: 180, outcomes_days: 365, sla_metrics_days: 30, provider_calls_days: 60 } });
    }

    case "update_retention_policy": {
      if (role !== "admin") return err("admin role required", 403);
      const fields = ["raw_leads_days","enrichment_days","scores_days","decisions_days","outcomes_days","sla_metrics_days","provider_calls_days"];
      const updates: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
      for (const f of fields) { if (body[f] != null) updates[f] = Math.max(7, Math.min(730, Number(body[f]))); }
      const { error: ue } = await adminSb.from("lge_retention_policies").upsert(updates, { onConflict: "org_id" });
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 18: Audit Export ────────────────────────────────────────────────
    case "export_audit": {
      if (role === "viewer") return err("Forbidden", 403);
      const { export_type = "decisions", format = "json", date_from, date_to, campaign_id } = body;
      const validTypes = ["decisions","alerts","outcomes","policies","operator_actions"];
      if (!validTypes.includes(export_type)) return err(`export_type must be one of: ${validTypes.join(", ")}`, 400);

      const since = date_from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const until = date_to   ?? new Date().toISOString();
      let rows: any[] = [];

      if (export_type === "decisions") {
        let q = adminSb.from("lge_decision_logs").select("raw_lead_id, routing_decision, routing_reason, score_outputs_json, created_at")
          .eq("org_id", orgId).gte("created_at", since).lte("created_at", until).limit(10000);
        if (campaign_id) {
          const { data: ids } = await adminSb.from("lge_raw_leads").select("id").eq("campaign_id", campaign_id).eq("org_id", orgId);
          if (ids?.length) q = q.in("raw_lead_id", ids.map((r: any) => r.id));
        }
        const { data } = await q;
        rows = data ?? [];
      } else if (export_type === "alerts") {
        let q = adminSb.from("lge_alerts").select("id, alert_type, severity, status, message, created_at, resolved_at")
          .eq("org_id", orgId).gte("created_at", since).lte("created_at", until).limit(5000);
        if (campaign_id) q = q.eq("campaign_id", campaign_id);
        const { data } = await q;
        rows = data ?? [];
      } else if (export_type === "outcomes") {
        let q = adminSb.from("lge_outcomes").select("id, raw_lead_id, gsc_lead_id, outcome_stage, observed_at, is_manual, manual_reason")
          .eq("org_id", orgId).gte("observed_at", since).lte("observed_at", until).limit(10000);
        const { data } = await q;
        rows = data ?? [];
      } else if (export_type === "operator_actions") {
        let q = adminSb.from("lge_operator_stats").select("*")
          .eq("org_id", orgId).gte("created_at", since).lte("created_at", until).limit(5000);
        if (campaign_id) q = q.eq("campaign_id", campaign_id);
        const { data } = await q;
        rows = data ?? [];
      } else if (export_type === "policies") {
        const [{ data: recs }, { data: exps }] = await Promise.all([
          adminSb.from("lge_policy_recommendations").select("*").eq("org_id", orgId).gte("created_at", since).limit(500),
          adminSb.from("lge_experiments").select("*").eq("org_id", orgId).gte("created_at", since).limit(200),
        ]);
        rows = [...(recs ?? []), ...(exps ?? [])];
      }

      // Log export
      await adminSb.from("lge_audit_exports").insert({
        org_id: orgId, exported_by: actorId, export_type, format,
        date_from: since, date_to: until, row_count: rows.length,
      }).then(undefined, () => {});

      // Increment usage
      await adminSb.rpc("lge_increment_usage", { p_org_id: orgId, p_field: "export_runs" }).then(undefined, () => {});

      if (format === "csv" && rows.length > 0) {
        const keys = Object.keys(rows[0]);
        const csv  = [keys.join(","), ...rows.map(r => keys.map(k => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
        return new Response(csv, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="lge_${export_type}_${new Date().toISOString().slice(0,10)}.csv"` } });
      }

      return ok({ export_type, row_count: rows.length, date_from: since, date_to: until, data: rows });
    }

    case "list_audit_exports": {
      const { limit: lim = 20 } = body;
      const { data, error: qe } = await adminSb.from("lge_audit_exports").select("*").eq("org_id", orgId)
        .order("created_at", { ascending: false }).limit(Math.min(lim, 100));
      if (qe) return err(qe.message, 500);
      return ok({ exports: data ?? [] });
    }

    // ── Phase 19: Public API Keys ─────────────────────────────────────────────
    case "create_api_key": {
      if (role !== "admin") return err("admin role required", 403);
      const { name: keyName, scopes: keyScopes = ["ingest","score","read"], rate_limit_per_min = 60, expires_in_days } = body;
      if (!keyName) return err("name required", 400);

      // Generate raw key: "lge_" + 32 random bytes base64url
      const rawBytes = new Uint8Array(32);
      crypto.getRandomValues(rawBytes);
      const b64 = btoa(String.fromCharCode(...rawBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      const rawKey   = `lge_${b64}`;
      const keyPrefix = rawKey.slice(0, 12);

      // Hash
      const msgBuf   = new TextEncoder().encode(rawKey);
      const hashBuf  = await crypto.subtle.digest("SHA-256", msgBuf);
      const keyHash  = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

      const expiresAt = expires_in_days ? new Date(Date.now() + Number(expires_in_days) * 86400_000).toISOString() : null;

      const { data: apiKey, error: ie } = await adminSb.from("lge_api_keys").insert({
        org_id: orgId, key_hash: keyHash, key_prefix: keyPrefix, name: keyName,
        scopes: keyScopes, rate_limit_per_min: Math.max(1, Math.min(600, Number(rate_limit_per_min))),
        is_active: true, created_by: actorId, expires_at: expiresAt,
      }).select("id, key_prefix, name, scopes, rate_limit_per_min, created_at, expires_at").single();

      if (ie) return err(ie.message, 500);
      // Return raw key ONCE — never stored, never retrievable again
      return ok({ ...apiKey, raw_key: rawKey, warning: "Store this key now — it cannot be retrieved again." }, 201);
    }

    case "list_api_keys": {
      const { data, error: qe } = await adminSb.from("lge_api_keys")
        .select("id, key_prefix, name, scopes, rate_limit_per_min, is_active, last_used_at, created_at, expires_at")
        .eq("org_id", orgId).order("created_at", { ascending: false });
      if (qe) return err(qe.message, 500);
      return ok({ api_keys: data ?? [] });
    }

    case "revoke_api_key": {
      if (role !== "admin") return err("admin role required", 403);
      const { api_key_id } = body;
      if (!api_key_id) return err("api_key_id required", 400);
      const { error: ue } = await adminSb.from("lge_api_keys").update({ is_active: false }).eq("id", api_key_id).eq("org_id", orgId);
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 19: Branding ────────────────────────────────────────────────────
    case "get_org_branding": {
      const { data, error: qe } = await adminSb.from("lge_org_branding").select("*").eq("org_id", orgId).maybeSingle();
      if (qe) return err(qe.message, 500);
      return ok({ branding: data ?? { org_id: orgId, is_white_label: false } });
    }

    case "update_org_branding": {
      if (role !== "admin") return err("admin role required", 403);
      const fields = ["brand_name","logo_url","primary_color","accent_color","custom_domain","email_from_name","email_from_address","is_white_label"];
      const updates: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
      for (const f of fields) { if (body[f] != null) updates[f] = body[f]; }
      const { error: ue } = await adminSb.from("lge_org_branding").upsert(updates, { onConflict: "org_id" });
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 19: Plugins ─────────────────────────────────────────────────────
    case "list_plugins": {
      const { plugin_type } = body;
      let q = adminSb.from("lge_plugins").select("id, name, plugin_type, endpoint_url, config_json, is_active, is_sandboxed, created_at")
        .or(`org_id.eq.${orgId},org_id.is.null`)
        .eq("is_active", true)
        .order("name");
      if (plugin_type) q = q.eq("plugin_type", plugin_type);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ plugins: data ?? [] });
    }

    case "register_plugin": {
      if (role !== "admin") return err("admin role required", 403);
      const { name: pName, plugin_type: pType, endpoint_url, config_json = {} } = body;
      if (!pName || !pType) return err("name and plugin_type required", 400);
      const validTypes = ["enrichment","scoring","routing","notification"];
      if (!validTypes.includes(pType)) return err(`plugin_type must be one of: ${validTypes.join(", ")}`, 400);
      const { data, error: ie } = await adminSb.from("lge_plugins").insert({
        org_id: orgId, name: pName, plugin_type: pType, endpoint_url: endpoint_url ?? null,
        config_json, is_active: true, is_sandboxed: true, created_by: actorId,
      }).select().single();
      if (ie) return err(ie.message, 500);
      return ok({ plugin: data }, 201);
    }

    case "toggle_plugin": {
      if (role !== "admin") return err("admin role required", 403);
      const { plugin_id, is_active } = body;
      if (!plugin_id || is_active == null) return err("plugin_id and is_active required", 400);
      const { error: ue } = await adminSb.from("lge_plugins").update({ is_active: Boolean(is_active) }).eq("id", plugin_id).eq("org_id", orgId);
      if (ue) return err(ue.message, 500);
      return ok({ ok: true });
    }

    // ── Phase 19: Benchmarks ──────────────────────────────────────────────────
    case "get_benchmarks": {
      const { vertical } = body;
      let q = adminSb.from("lge_benchmarks")
        .select("vertical, score_band, sample_count, avg_reply_rate, avg_booked_rate, avg_false_push_rate, computed_at")
        .order("computed_at", { ascending: false })
        .order("vertical")
        .order("score_band")
        .limit(200);
      if (vertical) q = q.eq("vertical", vertical);
      const { data, error: qe } = await q;
      if (qe) return err(qe.message, 500);
      return ok({ benchmarks: data ?? [] });
    }

    // ── Phase 20: Intake Activity ─────────────────────────────────────────────

    case "list_intake_events": {
      const {
        source: filterSource,
        campaign_id: filterCampaign,
        decision: filterDecision,
        date_from,
        date_to,
        search,
        limit: lim = 100,
        offset: off = 0,
      } = body;

      // Human-readable decision labels
      const DECISION_LABELS: Record<string, string> = {
        lge_queued:      "Sent to LGE",
        direct_push:     "Pushed to GSC",
        held:            "Held (fail-closed)",
        shadow:          "Shadow mode (GSC + LGE)",
        fallback_open:   "Fallback → GSC (fail-open)",
        fallback_closed: "Held — LGE unavailable",
        error:           "Error",
      };

      let q = adminSb.from("lge_intake_events")
        .select(`
          id,
          idempotency_key,
          org_id,
          intake_source,
          campaign_id,
          router_decision,
          fallback_reason,
          lge_lead_id,
          gsc_lead_id,
          created_at,
          lge_campaigns ( name )
        `, { count: "exact" })
        .eq("org_id", ctx.orgId)
        .order("created_at", { ascending: false })
        .range(Number(off), Number(off) + Math.min(Number(lim), 500) - 1);

      if (filterSource)   q = q.eq("intake_source", filterSource);
      if (filterCampaign) q = q.eq("campaign_id", filterCampaign);
      if (filterDecision) q = q.eq("router_decision", filterDecision);
      if (date_from)      q = q.gte("created_at", date_from);
      if (date_to)        q = q.lte("created_at", date_to);

      const { data, error: qe, count } = await q;
      if (qe) return err(qe.message, 500);

      const events = (data ?? []).map((row: any) => ({
        id:               row.id,
        created_at:       row.created_at,
        intake_source:    row.intake_source ?? "unknown",
        campaign_name:    row.lge_campaigns?.name ?? null,
        campaign_id:      row.campaign_id,
        router_decision:  row.router_decision,
        decision_label:   DECISION_LABELS[row.router_decision] ?? row.router_decision,
        fallback_reason:  row.fallback_reason,
        lge_lead_id:      row.lge_lead_id,
        gsc_lead_id:      row.gsc_lead_id,
        // Admin-only extras
        ...(ctx.role === "admin" ? {
          idempotency_key: row.idempotency_key,
          event_id:        row.id,
        } : {}),
      }));

      return ok({ events, total: count ?? 0 });
    }

    case "get_intake_event_detail": {
      const { event_id } = body;
      if (!event_id) return err("event_id required", 400);

      const { data, error: qe } = await adminSb.from("lge_intake_events")
        .select("*")
        .eq("id", event_id)
        .eq("org_id", ctx.orgId)
        .maybeSingle();
      if (qe) return err(qe.message, 500);
      if (!data) return err("Event not found", 404);

      // Strip raw_payload for non-admins
      const out: any = { ...data };
      if (ctx.role !== "admin") {
        delete out.raw_payload;
        delete out.idempotency_key;
      }
      return ok({ event: out });
    }

    case "get_intake_policy": {
      const { data } = await adminSb.from("lge_intake_policies")
        .select("failover_policy").eq("org_id", ctx.orgId).maybeSingle();
      return ok({ failover_policy: data?.failover_policy ?? "fail_open" });
    }

    case "update_intake_policy": {
      if (ctx.role === "viewer") return err("Insufficient permissions", 403);
      const { failover_policy } = body;
      if (!["fail_open", "fail_closed", "shadow_only"].includes(failover_policy)) {
        return err("Invalid failover_policy. Use: fail_open, fail_closed, shadow_only", 400);
      }
      await adminSb.from("lge_intake_policies").upsert(
        { org_id: ctx.orgId, failover_policy, updated_at: new Date().toISOString() },
        { onConflict: "org_id" }
      );
      return ok({ ok: true, failover_policy });
    }

    default:
      return err(`Unknown action: ${action}`, 400);
  }
});
