// lge_reliability_worker — Phase 14: Source Reliability Scorer
// Runs every 6h via pg_cron (--no-verify-jwt).
// Computes reliability_score per source per org from outcome data:
//   reliability = 100 - false_push_rate_pct  (capped 0–100, min 100 leads, 30-day window)
// High reliability (>70) → +3 to +5 modifier applied in lge_worker
// Low reliability (<30)  → -3 to -5 modifier applied in lge_worker

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_SAMPLE   = 100;  // minimum leads to compute a meaningful reliability score
const WINDOW_DAYS  = 30;   // look-back window
const LAG_HOURS    = 48;   // outcome lag before counting

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = getServiceSupabaseClient();
    const now = new Date();
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lagCutoff   = new Date(now.getTime() - LAG_HOURS * 60 * 60 * 1000).toISOString();
    const computedAt  = now.toISOString();

    // 1. All LGE-entitled orgs
    const { data: entitled } = await sb.from("org_services")
      .select("org_id")
      .eq("service_key", "lead_gen")
      .eq("status", "active");
    if (!entitled?.length) return ok({ ok: true, processed_orgs: 0 });

    const orgIds = entitled.map((r: any) => r.org_id as string);
    let updatedStats = 0;

    for (const orgId of orgIds) {
      // 2. Leads per source (outcome-eligible: pushed + >48h old, within 30-day window)
      const { data: leads } = await sb.from("lge_raw_leads")
        .select("id, source")
        .eq("org_id", orgId)
        .eq("status", "pushed")
        .gte("created_at", windowStart)
        .lt("updated_at", lagCutoff)
        .limit(5000);

      if (!leads?.length) continue;

      // 3. Group by source
      const bySource = new Map<string, string[]>();
      for (const l of leads as any[]) {
        const src = (l.source ?? "unknown") as string;
        if (!bySource.has(src)) bySource.set(src, []);
        bySource.get(src)!.push(l.id);
      }

      for (const [source, ids] of bySource.entries()) {
        if (ids.length < MIN_SAMPLE) continue;

        // 4. Fetch outcomes for these leads (chunked)
        const CHUNK = 500;
        let outcomes: any[] = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data } = await sb.from("lge_outcomes")
            .select("raw_lead_id, outcome_stage")
            .in("raw_lead_id", ids.slice(i, i + CHUNK));
          if (data) outcomes.push(...data);
        }

        const total         = ids.length;
        const withOutcome   = outcomes.length;
        const noReplyCount  = outcomes.filter((o: any) => o.outcome_stage === "no_reply").length;
        const repliedCount  = outcomes.filter((o: any) => ["replied", "booked", "closed"].includes(o.outcome_stage)).length;
        const bookedCount   = outcomes.filter((o: any) => ["booked", "closed"].includes(o.outcome_stage)).length;

        // Only compute if we have meaningful outcome coverage (≥ 50% of leads have outcomes)
        if (withOutcome < Math.max(10, total * 0.5)) continue;

        const falsePushRate = (noReplyCount / withOutcome) * 100;
        const replyRate     = (repliedCount / withOutcome) * 100;
        const bookedRate    = (bookedCount  / withOutcome) * 100;

        // reliability_score = 100 - false_push_rate  (so high false-push → low reliability)
        // Clamp [0, 100]
        const reliabilityScore = Math.max(0, Math.min(100, Math.round(100 - falsePushRate)));

        // Compute confidence_adj modifier: ±5 based on reliability vs neutral (50)
        // reliability 70–100 → +1 to +5, reliability 0–30 → -1 to -5
        let confidenceAdj = 0;
        if (total >= MIN_SAMPLE) {
          if (reliabilityScore >= 70) {
            confidenceAdj = Math.round(((reliabilityScore - 70) / 30) * 5);   // 0..+5
          } else if (reliabilityScore < 30) {
            confidenceAdj = Math.round(((reliabilityScore - 30) / 30) * 5);   // -5..0
          }
        }

        // Upsert lge_source_stats
        const { error } = await sb.from("lge_source_stats").upsert(
          {
            org_id:            orgId,
            source:            source,
            reliability_score: reliabilityScore,
            reliability_v:     1,
            false_push_rate:   Math.round(falsePushRate * 100) / 100,
            booked_rate:       Math.round(bookedRate * 100) / 100,
            sample_size:       total,
            confidence_adj:    confidenceAdj,
            computed_at:       computedAt,
          },
          { onConflict: "org_id,source" }
        );

        if (!error) updatedStats++;
        else console.warn("[lge_reliability_worker] upsert error:", error.message, { orgId, source });
      }
    }

    return ok({ ok: true, processed_orgs: orgIds.length, updated_stats: updatedStats });
  } catch (e: any) {
    console.error("[lge_reliability_worker] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
