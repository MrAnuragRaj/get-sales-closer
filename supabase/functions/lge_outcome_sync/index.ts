// lge_outcome_sync — LGE Outcome Feedback Loop
// Invoked by pg_cron daily (--no-verify-jwt).
// Reads GSC leads/interactions/appointments for all pushed LGE leads and
// writes the best observed outcome to lge_outcomes.
// Outcome precedence (low → high): no_reply → replied → booked → closed/won/lost

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Stage ordering — higher index = better outcome for the feedback loop
const STAGE_RANK: Record<string, number> = {
  no_reply: 0,
  replied:  1,
  booked:   2,
  qualified: 3,
  closed:   4,
  won:      5,
  lost:     4, // lost ranks same as closed for loop purposes
};

function bestStage(a: string, b: string): string {
  return (STAGE_RANK[a] ?? 0) >= (STAGE_RANK[b] ?? 0) ? a : b;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = getServiceSupabaseClient();

    // 1. Fetch all pushed LGE leads with a gsc_lead_id (batch cap 2000 per run)
    const { data: lgeLeads, error: lgeErr } = await sb
      .from("lge_raw_leads")
      .select("id, gsc_lead_id, org_id")
      .eq("status", "pushed")
      .not("gsc_lead_id", "is", null)
      .limit(2000);

    if (lgeErr) throw lgeErr;
    if (!lgeLeads?.length) {
      return new Response(JSON.stringify({ ok: true, synced: 0 }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const gscIds = lgeLeads.map((l) => l.gsc_lead_id as string);
    const lgeByGscId = new Map(lgeLeads.map((l) => [l.gsc_lead_id as string, l.id as string]));

    // 2. Fetch GSC lead statuses (closed_won / closed_lost)
    const { data: gscLeads } = await sb
      .from("leads")
      .select("id, status")
      .in("id", gscIds);

    const leadStatusMap = new Map<string, string>(
      (gscLeads ?? []).map((l) => [l.id, l.status]),
    );

    // 3. Fetch inbound interactions (any = replied)
    const { data: interactions } = await sb
      .from("interactions")
      .select("lead_id")
      .in("lead_id", gscIds)
      .eq("direction", "inbound");

    const repliedSet = new Set<string>((interactions ?? []).map((i) => i.lead_id));

    // 4. Fetch appointments (any = booked)
    const { data: appts } = await sb
      .from("appointments")
      .select("lead_id")
      .in("lead_id", gscIds);

    const bookedSet = new Set<string>((appts ?? []).map((a) => a.lead_id));

    // 5. Fetch existing manual outcomes to preserve them
    const lgeLeadIds = [...lgeByGscId.values()];
    const { data: existingOutcomes } = await sb
      .from("lge_outcomes")
      .select("raw_lead_id, outcome_stage, is_manual")
      .in("raw_lead_id", lgeLeadIds);

    const existingManualMap = new Map<string, string>(); // raw_lead_id → current outcome_stage (manual only)
    for (const row of existingOutcomes ?? []) {
      if (row.is_manual) existingManualMap.set(row.raw_lead_id, row.outcome_stage);
    }

    // 5. Compute outcome per LGE lead
    const toUpsert: Array<{
      raw_lead_id: string;
      gsc_lead_id: string;
      outcome_stage: string;
      outcome_source: string;
      observed_at: string;
      last_synced_at: string;
    }> = [];

    const now = new Date().toISOString();

    for (const [gscLeadId, lgeLeadId] of lgeByGscId) {
      const gscStatus = leadStatusMap.get(gscLeadId) ?? "";
      const hasInbound = repliedSet.has(gscLeadId);
      const hasAppt    = bookedSet.has(gscLeadId);

      let stage = "no_reply";

      if (gscStatus === "closed_won")  stage = bestStage(stage, "won");
      else if (gscStatus === "closed_lost") stage = bestStage(stage, "lost");
      else if (gscStatus === "closed") stage = bestStage(stage, "closed");

      if (hasAppt)    stage = bestStage(stage, "booked");
      if (hasInbound) stage = bestStage(stage, "replied");

      // Phase 10: if a manual outcome exists, only allow sync to overwrite
      // if the synced stage rank is strictly higher than the manual stage rank.
      const existingManualStage = existingManualMap.get(lgeLeadId);
      if (existingManualStage !== undefined) {
        const manualRank = STAGE_RANK[existingManualStage] ?? 0;
        const syncedRank = STAGE_RANK[stage] ?? 0;
        if (syncedRank <= manualRank) {
          // Sync result not better — preserve manual outcome, just update last_synced_at
          toUpsert.push({
            raw_lead_id:    lgeLeadId,
            gsc_lead_id:    gscLeadId,
            outcome_stage:  existingManualStage, // keep manual stage
            outcome_source: "manual",            // preserve source
            observed_at:    now,
            last_synced_at: now,
          });
          continue;
        }
        // Sync is better — allow overwrite (clear manual flag via source_priority=0)
      }

      toUpsert.push({
        raw_lead_id:    lgeLeadId,
        gsc_lead_id:    gscLeadId,
        outcome_stage:  stage,
        outcome_source: "sync",
        observed_at:    now,
        last_synced_at: now,
      });
    }

    // 6. Upsert in batches of 500
    let synced = 0;
    const CHUNK = 500;
    for (let i = 0; i < toUpsert.length; i += CHUNK) {
      const chunk = toUpsert.slice(i, i + CHUNK);
      const { error: upsertErr } = await sb
        .from("lge_outcomes")
        .upsert(chunk, { onConflict: "raw_lead_id" });

      if (upsertErr) {
        console.error("[lge_outcome_sync] upsert error:", upsertErr.message);
      } else {
        synced += chunk.length;
      }
    }

    return new Response(JSON.stringify({ ok: true, synced, total: lgeLeads.length }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[lge_outcome_sync] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
