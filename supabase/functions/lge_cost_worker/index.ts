// lge_cost_worker — Phase 15: Cost Intelligence Layer
// Runs daily at 04:30 UTC via pg_cron (--no-verify-jwt).
// Computes cost-per-lead metrics per org and campaign for today's date.
// Uses provider call counts as proxy for API cost (actual $ rates configurable).
// Stores in lge_cost_metrics (upsert per org/campaign/date).

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Approximate API cost per call (USD) — conservative estimates
const PROVIDER_COSTS: Record<string, number> = {
  apollo:         0.02,   // Apollo: ~$0.02/match
  hunter:         0.01,   // Hunter: ~$0.01/verify
  hunter_domain:  0.01,
  abstract_phone: 0.005,
};
const LAG_MS = 48 * 60 * 60 * 1000;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb  = getServiceSupabaseClient();
    const now = Date.now();
    const today       = new Date().toISOString().slice(0, 10);
    const windowStart = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // last 24h
    const lagCutoff   = new Date(now - LAG_MS).toISOString();

    const { data: entitled } = await sb.from("org_services")
      .select("org_id").eq("service_key", "lead_gen").eq("status", "active");
    if (!entitled?.length) return ok({ ok: true, processed_orgs: 0 });

    const orgIds = entitled.map((r: any) => r.org_id as string);
    let rowsUpserted = 0;

    for (const orgId of orgIds) {
      // 1. Active campaigns
      const { data: campaigns } = await sb.from("lge_campaigns")
        .select("id").eq("org_id", orgId).neq("status", "archived");
      if (!campaigns?.length) continue;
      const campIds = (campaigns as any[]).map((c: any) => c.id);

      // 2. Leads stats (last 24h for ingested; all-time for pushed/booked)
      const [
        { data: ingestedToday },
        { data: enrichedLeads },
        { data: pushedLeads },
      ] = await Promise.all([
        sb.from("lge_raw_leads")
          .select("campaign_id")
          .eq("org_id", orgId)
          .in("campaign_id", campIds)
          .gte("created_at", windowStart),
        sb.from("lge_raw_leads")
          .select("campaign_id")
          .eq("org_id", orgId)
          .in("campaign_id", campIds)
          .neq("status", "pending"),
        sb.from("lge_raw_leads")
          .select("id, campaign_id")
          .eq("org_id", orgId)
          .in("campaign_id", campIds)
          .eq("status", "pushed")
          .lt("updated_at", lagCutoff),
      ]);

      const pushedIds = (pushedLeads ?? []).map((l: any) => l.id);

      // 3. Outcomes for pushed leads (booked/closed count)
      const CHUNK = 500;
      let outcomes: any[] = [];
      for (let i = 0; i < pushedIds.length; i += CHUNK) {
        const { data } = await sb.from("lge_outcomes")
          .select("raw_lead_id, outcome_stage, campaign_id: raw_lead_id")
          .in("raw_lead_id", pushedIds.slice(i, i + CHUNK));
        if (data) outcomes.push(...data);
      }
      const bookedIds = new Set(
        outcomes.filter((o: any) => ["booked","closed"].includes(o.outcome_stage)).map((o: any) => o.raw_lead_id)
      );

      // 4. Provider calls (last 24h, all providers)
      const allLeadIdsToday = (ingestedToday ?? []).map((l: any) => l.id).filter(Boolean);
      let providerCalls: any[] = [];
      if (allLeadIdsToday.length) {
        for (let i = 0; i < allLeadIdsToday.length; i += CHUNK) {
          const { data } = await sb.from("lge_provider_calls")
            .select("raw_lead_id, provider, status")
            .in("raw_lead_id", allLeadIdsToday.slice(i, i + CHUNK))
            .eq("status", "success");
          if (data) providerCalls.push(...data);
        }
      }

      // 5. Per-campaign rollup
      for (const camp of campaigns as any[]) {
        const campId = camp.id;

        const campIngested  = (ingestedToday ?? []).filter((l: any) => l.campaign_id === campId).length;
        const campEnriched  = (enrichedLeads ?? []).filter((l: any) => l.campaign_id === campId).length;
        const campPushed    = (pushedLeads ?? []).filter((l: any) => l.campaign_id === campId).length;
        const campBooked    = (pushedLeads ?? []).filter((l: any) => l.campaign_id === campId && bookedIds.has(l.id)).length;
        const campCallsTotal = providerCalls.filter((c: any) => allLeadIdsToday.includes(c.raw_lead_id)).length;

        // Estimated provider cost
        let estimatedCost = 0;
        for (const call of providerCalls) {
          estimatedCost += PROVIDER_COSTS[call.provider] ?? 0;
        }
        estimatedCost = Math.round(estimatedCost * 10000) / 10000;

        const costPerEnriched = campEnriched > 0 ? Math.round((estimatedCost / campEnriched) * 10000) / 10000 : null;
        const costPerPushed   = campPushed   > 0 ? Math.round((estimatedCost / campPushed)   * 10000) / 10000 : null;
        const costPerBooked   = campBooked   > 0 ? Math.round((estimatedCost / campBooked)   * 10000) / 10000 : null;

        await sb.from("lge_cost_metrics").upsert(
          {
            org_id:                   orgId,
            campaign_id:              campId,
            period_date:              today,
            leads_ingested:           campIngested,
            leads_enriched:           campEnriched,
            leads_pushed:             campPushed,
            leads_booked:             campBooked,
            provider_calls_total:     campCallsTotal,
            estimated_provider_cost:  estimatedCost,
            cost_per_enriched_lead:   costPerEnriched,
            cost_per_pushed_lead:     costPerPushed,
            cost_per_booked_lead:     costPerBooked,
            metrics_json: {
              breakdown_by_provider: Object.entries(PROVIDER_COSTS).reduce((acc, [p, rate]) => {
                const count = providerCalls.filter((c: any) => c.provider === p).length;
                if (count > 0) (acc as any)[p] = { calls: count, cost: Math.round(count * rate * 10000) / 10000 };
                return acc;
              }, {}),
            },
            computed_at: new Date().toISOString(),
          },
          { onConflict: "org_id,campaign_id,period_date" }
        );
        rowsUpserted++;
      }

      // 6. Org-level aggregate row (campaign_id = NULL)
      const totalIngested      = (ingestedToday ?? []).length;
      const totalEnriched      = (enrichedLeads ?? []).length;
      const totalPushed        = (pushedLeads ?? []).length;
      const totalBooked        = (pushedLeads ?? []).filter((l: any) => bookedIds.has(l.id)).length;
      const totalProviderCalls = providerCalls.length;
      const totalCost          = providerCalls.reduce((sum: number, c: any) => sum + (PROVIDER_COSTS[c.provider] ?? 0), 0);

      await sb.from("lge_cost_metrics").upsert(
        {
          org_id:                  orgId,
          campaign_id:             null,
          period_date:             today,
          leads_ingested:          totalIngested,
          leads_enriched:          totalEnriched,
          leads_pushed:            totalPushed,
          leads_booked:            totalBooked,
          provider_calls_total:    totalProviderCalls,
          estimated_provider_cost: Math.round(totalCost * 10000) / 10000,
          cost_per_enriched_lead:  totalEnriched > 0 ? Math.round((totalCost / totalEnriched) * 10000) / 10000 : null,
          cost_per_pushed_lead:    totalPushed   > 0 ? Math.round((totalCost / totalPushed)   * 10000) / 10000 : null,
          cost_per_booked_lead:    totalBooked   > 0 ? Math.round((totalCost / totalBooked)   * 10000) / 10000 : null,
          metrics_json:            { scope: "org_aggregate" },
          computed_at:             new Date().toISOString(),
        },
        { onConflict: "org_id,campaign_id,period_date" }
      );
      rowsUpserted++;
    }

    return ok({ ok: true, processed_orgs: orgIds.length, rows_upserted: rowsUpserted });
  } catch (e: any) {
    console.error("[lge_cost_worker] error:", e.message);
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
