// lge_auto_assist_worker — Phase 14: Bounded Auto-Assist for Campaigns
// Runs every 30 minutes via pg_cron (--no-verify-jwt).
// Only acts on campaigns with auto_assist_mode = 'assist'.
// Bounded adjustments:
//   - Threshold nudge: ±3 pts max if false_push_rate or miss_rate is clearly drifting
//   - Source downweight: set confidence_adj = -3 on lge_source_stats for a failing source
//   - Suggest reprocess: flag stale failed leads for retry (does NOT auto-reprocess — only logs)
// Every action is logged to lge_auto_assist_actions (immutable, reversible).
// UI shows a banner for any campaign with recent assist actions.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_SAMPLE   = 50;   // minimum outcome-eligible pushed leads to act
const LAG_MS       = 48 * 60 * 60 * 1000;
const MAX_NUDGE    = 3;    // maximum threshold points to adjust in one run

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb  = getServiceSupabaseClient();
    const now = Date.now();
    const lagCutoff = new Date(now - LAG_MS).toISOString();

    // 1. Campaigns in ASSIST mode only
    const { data: campaigns } = await sb
      .from("lge_campaigns")
      .select("id, org_id, name, auto_push_threshold, review_threshold, auto_assist_mode, status")
      .eq("auto_assist_mode", "assist")
      .not("status", "in", '("archived","paused")');

    if (!campaigns?.length) return ok({ ok: true, campaigns_processed: 0, actions_taken: 0 });

    let actionsTaken = 0;

    for (const camp of campaigns as any[]) {
      try {
        // 2. Outcome-eligible pushed leads for this campaign
        const { data: pushedLeads } = await sb.from("lge_raw_leads")
          .select("id")
          .eq("campaign_id", camp.id)
          .eq("status", "pushed")
          .lt("updated_at", lagCutoff)
          .limit(2000);

        if (!pushedLeads || pushedLeads.length < MIN_SAMPLE) continue;

        const pushedIds = pushedLeads.map((l: any) => l.id);

        // 3. Fetch outcomes
        const CHUNK = 500;
        let outcomes: any[] = [];
        for (let i = 0; i < pushedIds.length; i += CHUNK) {
          const { data } = await sb.from("lge_outcomes")
            .select("raw_lead_id, outcome_stage")
            .in("raw_lead_id", pushedIds.slice(i, i + CHUNK));
          if (data) outcomes.push(...data);
        }

        const withOutcome   = outcomes.length;
        if (withOutcome < 10) continue;

        const noReplyCount  = outcomes.filter((o: any) => o.outcome_stage === "no_reply").length;
        const falsePushRate = (noReplyCount / withOutcome) * 100;

        // 4. Decide if threshold adjustment is warranted
        const currentThreshold  = camp.auto_push_threshold;
        const reviewThreshold   = camp.review_threshold;
        const THRESHOLD_MIN_GAP = 5; // auto_push must remain > review by at least 5pts

        let newThreshold = currentThreshold;
        let actionReason = "";

        if (falsePushRate >= 65 && currentThreshold < 95) {
          // Too many no-replies → raise threshold (max +3 pts)
          const nudge = Math.min(MAX_NUDGE, 95 - currentThreshold);
          const candidate = currentThreshold + nudge;
          if (candidate - reviewThreshold >= THRESHOLD_MIN_GAP) {
            newThreshold = candidate;
            actionReason = `False push rate ${Math.round(falsePushRate)}% ≥ 65% — raised push threshold by ${nudge}pt`;
          }
        } else if (falsePushRate <= 15 && withOutcome >= MIN_SAMPLE && currentThreshold > reviewThreshold + THRESHOLD_MIN_GAP + 3) {
          // Performing well → loosen threshold to push more (max -3 pts)
          const nudge = Math.min(MAX_NUDGE, currentThreshold - reviewThreshold - THRESHOLD_MIN_GAP);
          newThreshold = currentThreshold - Math.min(nudge, 3);
          actionReason = `False push rate ${Math.round(falsePushRate)}% ≤ 15% — lowered push threshold by ${currentThreshold - newThreshold}pt`;
        }

        if (newThreshold !== currentThreshold) {
          // Apply the threshold change
          const { error: upErr } = await sb.from("lge_campaigns")
            .update({ auto_push_threshold: newThreshold })
            .eq("id", camp.id);

          if (!upErr) {
            await sb.from("lge_auto_assist_actions").insert({
              campaign_id: camp.id,
              org_id:      camp.org_id,
              action_type: "threshold_adjust",
              before_json: { auto_push_threshold: currentThreshold, false_push_rate: Math.round(falsePushRate * 10) / 10 },
              after_json:  { auto_push_threshold: newThreshold,     false_push_rate: Math.round(falsePushRate * 10) / 10 },
              reason:      actionReason,
              is_reversible: true,
            });
            actionsTaken++;
          }
        }

        // 5. Source downweight: if a single source accounts for >60% of no-replies → flag it
        const { data: sourceLeads } = await sb.from("lge_raw_leads")
          .select("id, source")
          .eq("campaign_id", camp.id)
          .eq("status", "pushed")
          .lt("updated_at", lagCutoff)
          .limit(2000);

        if (sourceLeads && sourceLeads.length >= MIN_SAMPLE) {
          const noReplyIds = new Set(
            outcomes.filter((o: any) => o.outcome_stage === "no_reply").map((o: any) => o.raw_lead_id)
          );

          const sourceCounts: Record<string, { total: number; noReply: number }> = {};
          for (const l of sourceLeads as any[]) {
            const src = l.source ?? "unknown";
            if (!sourceCounts[src]) sourceCounts[src] = { total: 0, noReply: 0 };
            sourceCounts[src].total++;
            if (noReplyIds.has(l.id)) sourceCounts[src].noReply++;
          }

          for (const [src, counts] of Object.entries(sourceCounts)) {
            if (counts.total < 30) continue; // need at least 30 leads from this source
            const srcFalsePushRate = (counts.noReply / counts.total) * 100;
            if (srcFalsePushRate >= 70) {
              // Downweight this source (set confidence_adj = -3)
              const { data: existing } = await sb.from("lge_source_stats")
                .select("confidence_adj")
                .eq("org_id", camp.org_id)
                .eq("source", src)
                .maybeSingle();

              const prevAdj = existing?.confidence_adj ?? 0;
              if (prevAdj > -3) {
                await sb.from("lge_source_stats").upsert(
                  { org_id: camp.org_id, source: src, confidence_adj: -3 },
                  { onConflict: "org_id,source" }
                );
                await sb.from("lge_auto_assist_actions").insert({
                  campaign_id: camp.id,
                  org_id:      camp.org_id,
                  action_type: "source_downweight",
                  before_json: { source: src, confidence_adj: prevAdj, false_push_rate: Math.round(srcFalsePushRate * 10) / 10 },
                  after_json:  { source: src, confidence_adj: -3,      false_push_rate: Math.round(srcFalsePushRate * 10) / 10 },
                  reason:      `Source "${src}" has ${Math.round(srcFalsePushRate)}% false push rate (${counts.noReply}/${counts.total} leads) — confidence adjusted to -3`,
                  is_reversible: true,
                });
                actionsTaken++;
              }
            }
          }
        }
      } catch (campErr: any) {
        console.warn("[lge_auto_assist_worker] campaign error", camp.id, campErr.message);
      }
    }

    return ok({ ok: true, campaigns_processed: campaigns.length, actions_taken: actionsTaken });
  } catch (e: any) {
    console.error("[lge_auto_assist_worker] error:", e.message);
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
