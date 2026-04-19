// lge_dlq_worker — Phase 17: Dead Letter Queue Retry Worker
// Runs every 30 min via pg_cron (--no-verify-jwt).
// Finds DLQ items eligible for retry (status=dead, retry_count < max_retries).
// Resets the corresponding lead to pending so lge_worker picks it up next cycle.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_LIMIT = 50;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = getServiceSupabaseClient();

    // Find retryable DLQ items
    const { data: items, error: fetchErr } = await sb
      .from("lge_dead_letter")
      .select("id, lead_id, retry_count, max_retries")
      .eq("status", "dead")
      .lt("retry_count", sb.rpc as any)  // workaround: use filter below
      .limit(BATCH_LIMIT);

    // Redo query without the bad workaround
    const { data: dlqItems, error: dlqErr } = await sb
      .from("lge_dead_letter")
      .select("id, lead_id, org_id, campaign_id, retry_count, max_retries, payload")
      .eq("status", "dead")
      .limit(BATCH_LIMIT);

    if (dlqErr) throw new Error(dlqErr.message);

    const eligible = (dlqItems ?? []).filter((d: any) => d.retry_count < d.max_retries);

    if (eligible.length === 0) {
      return new Response(JSON.stringify({ ok: true, retried: 0 }), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    let retried = 0;
    let abandoned = 0;

    for (const item of eligible as any[]) {
      // Reset lead to pending so lge_worker picks it up
      if (item.lead_id) {
        const { error: resetErr } = await sb
          .from("lge_raw_leads")
          .update({
            status: "pending",
            attempt: 0,
            locked_by: null,
            locked_until: null,
            last_error: null,
          })
          .eq("id", item.lead_id)
          .in("status", ["failed"]);  // only reset if actually failed (not already re-processed)

        if (!resetErr) {
          // Mark DLQ item as retrying
          await sb.from("lge_dead_letter").update({
            status: "retrying",
            retry_count: item.retry_count + 1,
            last_retry_at: new Date().toISOString(),
          }).eq("id", item.id);
          retried++;
        }
      } else {
        // No lead_id — abandon
        await sb.from("lge_dead_letter").update({ status: "abandoned" }).eq("id", item.id);
        abandoned++;
      }
    }

    return new Response(JSON.stringify({ ok: true, retried, abandoned, total_eligible: eligible.length }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[lge_dlq_worker] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
