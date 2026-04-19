// lge_global_pattern_worker — Phase 15: Cross-Campaign Pattern Aggregator
// Runs daily at 04:00 UTC via pg_cron (--no-verify-jwt).
// Discovers and stores top-performing ICP patterns, score bands, and source
// effectiveness across all campaigns for an org, stored in lge_global_patterns.
// These patterns are surfaced in the Source Intelligence Panel and feed
// the recommendation ranking system.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_SAMPLE    = 20;
const WINDOW_DAYS   = 30;
const LAG_MS        = 48 * 60 * 60 * 1000;

const SCORE_BANDS = [
  { key: "band_60_70", min: 60, max: 70 },
  { key: "band_70_80", min: 70, max: 80 },
  { key: "band_80_90", min: 80, max: 90 },
  { key: "band_90_100", min: 90, max: 101 },
];

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb  = getServiceSupabaseClient();
    const now = Date.now();
    const windowStart = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const lagCutoff   = new Date(now - LAG_MS).toISOString();
    const computedAt  = new Date().toISOString();

    const { data: entitled } = await sb.from("org_services")
      .select("org_id").eq("service_key", "lead_gen").eq("status", "active");
    if (!entitled?.length) return ok({ ok: true, processed_orgs: 0 });

    const orgIds = entitled.map((r: any) => r.org_id as string);
    let patternsUpserted = 0;

    for (const orgId of orgIds) {
      // 1. All outcome-eligible pushed leads in the window
      const { data: leads } = await sb.from("lge_raw_leads")
        .select("id, source")
        .eq("org_id", orgId)
        .eq("status", "pushed")
        .gte("created_at", windowStart)
        .lt("updated_at", lagCutoff)
        .limit(10000);

      if (!leads?.length) continue;
      const ids = (leads as any[]).map((l: any) => l.id);

      // 2. Scores for these leads
      const { data: scores } = await sb.from("lge_scores")
        .select("raw_lead_id, total_score")
        .in("raw_lead_id", ids);
      const scoreMap = new Map<string, number>((scores ?? []).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

      // 3. Outcomes
      const CHUNK = 500;
      let outcomes: any[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data } = await sb.from("lge_outcomes")
          .select("raw_lead_id, outcome_stage")
          .in("raw_lead_id", ids.slice(i, i + CHUNK));
        if (data) outcomes.push(...data);
      }
      const outcomeMap = new Map<string, string>((outcomes as any[]).map((o: any) => [o.raw_lead_id, o.outcome_stage]));

      // 4. Enrichment for ICP segment analysis
      const { data: enrichments } = await sb.from("lge_enrichment")
        .select("raw_lead_id, industry, company_size")
        .in("raw_lead_id", ids);
      const enrichMap = new Map<string, any>((enrichments ?? []).map((e: any) => [e.raw_lead_id, e]));

      // 5. Score band patterns
      for (const band of SCORE_BANDS) {
        const bandLeads = (leads as any[]).filter((l: any) => {
          const score = scoreMap.get(l.id) ?? 0;
          return score >= band.min && score < band.max;
        });
        if (bandLeads.length < MIN_SAMPLE) continue;

        const bandIds    = bandLeads.map((l: any) => l.id);
        const withOutcome = bandIds.filter((id: string) => outcomeMap.has(id));
        if (withOutcome.length < 5) continue;

        const replied  = withOutcome.filter((id: string) => ["replied","booked","closed"].includes(outcomeMap.get(id)!)).length;
        const booked   = withOutcome.filter((id: string) => ["booked","closed"].includes(outcomeMap.get(id)!)).length;
        const noReply  = withOutcome.filter((id: string) => outcomeMap.get(id) === "no_reply").length;

        await sb.from("lge_global_patterns").upsert(
          {
            org_id:       orgId,
            pattern_type: "score_band",
            pattern_key:  band.key,
            sample_size:  bandLeads.length,
            metrics_json: {
              total:            bandLeads.length,
              with_outcome:     withOutcome.length,
              reply_rate:       Math.round((replied / withOutcome.length) * 100 * 10) / 10,
              booked_rate:      Math.round((booked  / withOutcome.length) * 100 * 10) / 10,
              false_push_rate:  Math.round((noReply / withOutcome.length) * 100 * 10) / 10,
              score_range:      { min: band.min, max: band.max },
            },
            computed_at: computedAt,
          },
          { onConflict: "org_id,pattern_type,pattern_key" }
        );
        patternsUpserted++;
      }

      // 6. Source effectiveness patterns
      const sourceGroups: Record<string, string[]> = {};
      for (const l of leads as any[]) {
        const src = l.source ?? "unknown";
        if (!sourceGroups[src]) sourceGroups[src] = [];
        sourceGroups[src].push(l.id);
      }

      for (const [src, srcIds] of Object.entries(sourceGroups)) {
        if (srcIds.length < MIN_SAMPLE) continue;
        const withOutcome = srcIds.filter((id: string) => outcomeMap.has(id));
        if (withOutcome.length < 5) continue;

        const replied  = withOutcome.filter((id: string) => ["replied","booked","closed"].includes(outcomeMap.get(id)!)).length;
        const booked   = withOutcome.filter((id: string) => ["booked","closed"].includes(outcomeMap.get(id)!)).length;
        const noReply  = withOutcome.filter((id: string) => outcomeMap.get(id) === "no_reply").length;

        const avgScore = srcIds.reduce((sum: number, id: string) => sum + (scoreMap.get(id) ?? 0), 0) / srcIds.length;

        await sb.from("lge_global_patterns").upsert(
          {
            org_id:       orgId,
            pattern_type: "source_effectiveness",
            pattern_key:  `source_${src}`,
            sample_size:  srcIds.length,
            metrics_json: {
              source:           src,
              total:            srcIds.length,
              with_outcome:     withOutcome.length,
              avg_score:        Math.round(avgScore * 10) / 10,
              reply_rate:       Math.round((replied / withOutcome.length) * 100 * 10) / 10,
              booked_rate:      Math.round((booked  / withOutcome.length) * 100 * 10) / 10,
              false_push_rate:  Math.round((noReply / withOutcome.length) * 100 * 10) / 10,
            },
            computed_at: computedAt,
          },
          { onConflict: "org_id,pattern_type,pattern_key" }
        );
        patternsUpserted++;
      }

      // 7. ICP segment patterns (industry × company_size combos)
      const icpGroups: Record<string, string[]> = {};
      for (const l of leads as any[]) {
        const e = enrichMap.get(l.id);
        if (!e?.industry || !e?.company_size) continue;
        const key = `${e.industry.toLowerCase().replace(/\s+/g,'_')}__${e.company_size}`;
        if (!icpGroups[key]) icpGroups[key] = [];
        icpGroups[key].push(l.id);
      }

      for (const [segKey, segIds] of Object.entries(icpGroups)) {
        if (segIds.length < MIN_SAMPLE) continue;
        const withOutcome = segIds.filter((id: string) => outcomeMap.has(id));
        if (withOutcome.length < 5) continue;

        const replied = withOutcome.filter((id: string) => ["replied","booked","closed"].includes(outcomeMap.get(id)!)).length;
        const booked  = withOutcome.filter((id: string) => ["booked","closed"].includes(outcomeMap.get(id)!)).length;

        await sb.from("lge_global_patterns").upsert(
          {
            org_id:       orgId,
            pattern_type: "icp_segment",
            pattern_key:  segKey,
            sample_size:  segIds.length,
            metrics_json: {
              segment:      segKey,
              total:        segIds.length,
              with_outcome: withOutcome.length,
              reply_rate:   Math.round((replied / withOutcome.length) * 100 * 10) / 10,
              booked_rate:  Math.round((booked  / withOutcome.length) * 100 * 10) / 10,
            },
            computed_at: computedAt,
          },
          { onConflict: "org_id,pattern_type,pattern_key" }
        );
        patternsUpserted++;
      }
    }

    return ok({ ok: true, processed_orgs: orgIds.length, patterns_upserted: patternsUpserted });
  } catch (e: any) {
    console.error("[lge_global_pattern_worker] error:", e.message);
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
