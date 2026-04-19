// lge_recommendation_feedback_worker — Phase 14: Recommendation Effectiveness Evaluator
// Runs daily at 03:30 UTC via pg_cron (--no-verify-jwt).
// Finds accepted recommendations that are ≥14 days old without feedback.
// Fetches before/after metrics and computes an effectiveness_score.
// Stores results in lge_recommendation_feedback and back-fills
// lge_policy_recommendations.effectiveness_score for ranking.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVAL_WINDOW_DAYS = 14;   // evaluate after 14 days
const LAG_MS           = 48 * 60 * 60 * 1000;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb  = getServiceSupabaseClient();
    const now = Date.now();
    const evalCutoff = new Date(now - EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // 1. Find accepted recommendations ≥14 days old, not yet evaluated
    const { data: recs, error: recErr } = await sb
      .from("lge_policy_recommendations")
      .select("id, org_id, campaign_id, recommendation_type, accepted_at, current_policy_json, recommended_policy_json, applied_policy_snapshot_json")
      .eq("status", "accepted")
      .is("evaluated_at", null)
      .not("accepted_at", "is", null)
      .lte("accepted_at", evalCutoff)
      .limit(50);

    if (recErr) throw new Error(recErr.message);
    if (!recs?.length) return ok({ ok: true, evaluated: 0 });

    let evaluated = 0;

    for (const rec of recs as any[]) {
      if (!rec.campaign_id) continue;

      const acceptedAt = new Date(rec.accepted_at);
      const windowStart = new Date(acceptedAt.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const windowEnd   = new Date(acceptedAt.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const lagCutoff   = new Date(now - LAG_MS).toISOString();

      // 2. Before metrics: leads processed in 14 days BEFORE acceptance
      const { data: beforeLeads } = await sb.from("lge_raw_leads")
        .select("id, status")
        .eq("org_id", rec.org_id)
        .eq("campaign_id", rec.campaign_id)
        .gte("created_at", windowStart)
        .lt("created_at", rec.accepted_at)
        .limit(2000);

      // 3. After metrics: leads processed in 14 days AFTER acceptance (outcome-eligible only)
      const { data: afterLeads } = await sb.from("lge_raw_leads")
        .select("id, status")
        .eq("org_id", rec.org_id)
        .eq("campaign_id", rec.campaign_id)
        .gte("created_at", rec.accepted_at)
        .lte("created_at", windowEnd)
        .lt("updated_at", lagCutoff)
        .limit(2000);

      const beforePushed = (beforeLeads ?? []).filter((l: any) => l.status === "pushed");
      const afterPushed  = (afterLeads  ?? []).filter((l: any) => l.status === "pushed");

      // Outcomes for pushed leads in both windows
      const fetchOutcomes = async (ids: string[]) => {
        if (!ids.length) return [];
        const CHUNK = 500;
        let all: any[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data } = await sb.from("lge_outcomes")
            .select("raw_lead_id, outcome_stage")
            .in("raw_lead_id", ids.slice(i, i + CHUNK));
          if (data) all.push(...data);
        }
        return all;
      };

      const beforeIds = beforePushed.map((l: any) => l.id);
      const afterIds  = afterPushed.map((l: any) => l.id);

      const [beforeOutcomes, afterOutcomes] = await Promise.all([
        fetchOutcomes(beforeIds),
        fetchOutcomes(afterIds),
      ]);

      const calcRates = (pushed: any[], outcomes: any[]) => {
        if (!pushed.length) return { total: 0, reply_rate: null, false_push_rate: null };
        const withOutcome = outcomes.length;
        if (withOutcome < 5) return { total: pushed.length, reply_rate: null, false_push_rate: null };
        const replied      = outcomes.filter((o: any) => ["replied","booked","closed"].includes(o.outcome_stage)).length;
        const noReply      = outcomes.filter((o: any) => o.outcome_stage === "no_reply").length;
        return {
          total:           pushed.length,
          reply_rate:      Math.round((replied / withOutcome) * 100 * 10) / 10,
          false_push_rate: Math.round((noReply / withOutcome) * 100 * 10) / 10,
        };
      };

      const beforeMetrics = calcRates(beforePushed, beforeOutcomes);
      const afterMetrics  = calcRates(afterPushed,  afterOutcomes);

      // 4. Compute effectiveness_score (0–100)
      //    Positive = things improved; Negative = things got worse
      //    We compare reply_rate improvement (primary) and false_push_rate reduction (secondary)
      let effectivenessScore: number | null = null;

      if (
        beforeMetrics.reply_rate !== null && afterMetrics.reply_rate !== null &&
        beforeMetrics.false_push_rate !== null && afterMetrics.false_push_rate !== null
      ) {
        const replyDelta   = afterMetrics.reply_rate   - beforeMetrics.reply_rate;   // positive = better
        const falsePushDelta = beforeMetrics.false_push_rate - afterMetrics.false_push_rate; // positive = better (reduced)
        // Weight reply improvement 60%, false-push reduction 40%; scale to 0–100
        const rawScore = 50 + (replyDelta * 0.6 + falsePushDelta * 0.4);
        effectivenessScore = Math.round(Math.max(0, Math.min(100, rawScore)) * 100) / 100;
      }

      // 5. Store feedback record
      const { error: insErr } = await sb.from("lge_recommendation_feedback").upsert(
        {
          recommendation_id:      rec.id,
          org_id:                 rec.org_id,
          evaluation_window_days: EVAL_WINDOW_DAYS,
          before_metrics_json:    { ...beforeMetrics, outcomes: beforeOutcomes.length },
          after_metrics_json:     { ...afterMetrics,  outcomes: afterOutcomes.length },
          effectiveness_score:    effectivenessScore,
          evaluated_at:           new Date().toISOString(),
        },
        { onConflict: "recommendation_id" }
      );
      if (insErr) { console.warn("[rec_feedback] upsert error:", insErr.message); continue; }

      // 6. Back-fill lge_policy_recommendations.effectiveness_score + evaluated_at
      await sb.from("lge_policy_recommendations")
        .update({
          effectiveness_score:              effectivenessScore,
          post_apply_metrics_snapshot_json: afterMetrics,
          evaluated_at:                     new Date().toISOString(),
        })
        .eq("id", rec.id);

      evaluated++;
    }

    // 7. Recompute recommendation_quality_score for all open recommendations
    //    based on effectiveness history + confidence_level weights
    await recomputeRecommendationQuality(sb);

    return ok({ ok: true, evaluated });
  } catch (e: any) {
    console.error("[lge_recommendation_feedback_worker] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

// Recompute recommendation_quality_score for open recommendations
// Quality = weighted average of: type_effectiveness_rate + confidence_level weight
async function recomputeRecommendationQuality(sb: ReturnType<typeof getServiceSupabaseClient>) {
  // Per-type average effectiveness (from historical feedback)
  const { data: feedbackData } = await sb
    .from("lge_recommendation_feedback")
    .select("recommendation_id, effectiveness_score")
    .not("effectiveness_score", "is", null);

  if (!feedbackData?.length) return;

  // Build rec_id → effectiveness_score map
  const effectivenessMap = new Map<string, number>(
    (feedbackData as any[]).map((f: any) => [f.recommendation_id, Number(f.effectiveness_score)])
  );

  // Fetch open recs that have no quality score yet OR were evaluated recently
  const { data: openRecs } = await sb
    .from("lge_policy_recommendations")
    .select("id, recommendation_type, confidence_level")
    .eq("status", "open");

  if (!openRecs?.length) return;

  const confidenceWeights: Record<string, number> = { low: 30, medium: 60, high: 90 };

  for (const rec of openRecs as any[]) {
    const typeEffectiveness = effectivenessMap.get(rec.id) ?? null;
    const confidenceBase    = confidenceWeights[rec.confidence_level] ?? 60;

    // Quality = 50% from confidence_level + 50% from historical effectiveness (if available)
    const qualityScore = typeEffectiveness !== null
      ? Math.round((confidenceBase * 0.5 + typeEffectiveness * 0.5) * 100) / 100
      : null;

    if (qualityScore !== null) {
      await sb.from("lge_policy_recommendations")
        .update({ recommendation_quality_score: qualityScore })
        .eq("id", rec.id);
    }
  }
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
