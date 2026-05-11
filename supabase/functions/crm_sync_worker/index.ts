// crm_sync_worker — Async CRM event queue processor.
// Invoked by pg_cron every 5 minutes (--no-verify-jwt).
// Claims pending crm_sync_events, routes to the correct CRM adapter,
// records mappings and logs, handles retries with backoff.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import {
  routeToAdapter,
  type CrmDestination,
  type CrmSyncEvent,
  type AdapterResult,
} from "../_shared/crm_adapters.ts";

const BATCH_SIZE = 20;

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function insertLog(
  sb: ReturnType<typeof getServiceSupabaseClient>,
  eventId: string,
  orgId: string,
  destinationId: string | null,
  action: string,
  status: string,
  requestSummary: Record<string, unknown> | null,
  responseSummary: Record<string, unknown> | null,
  errorMessage: string | null,
): Promise<void> {
  await sb.from("crm_sync_logs").insert({
    event_id:         eventId,
    org_id:           orgId,
    destination_id:   destinationId,
    action,
    status,
    request_summary:  requestSummary,
    response_summary: responseSummary,
    error_message:    errorMessage,
  }).then(undefined, () => {});
}

serve(async (_req) => {
  const sb = getServiceSupabaseClient();

  // ── 1. Claim a batch of pending events atomically ───────────────────────────
  const { data: events, error: claimErr } = await sb.rpc("claim_crm_sync_events", {
    p_batch_size: BATCH_SIZE,
  });

  if (claimErr) {
    console.error("[crm_sync_worker] claim failed:", claimErr.message);
    return ok({ processed: 0, error: claimErr.message });
  }

  if (!events?.length) {
    return ok({ processed: 0, synced: 0, skipped: 0, failed: 0 });
  }

  // ── 2. Load active destinations for all orgs in this batch ─────────────────
  const orgIds = [...new Set(events.map((e: CrmSyncEvent) => e.org_id))];

  const { data: destinations } = await sb
    .from("crm_destinations")
    .select("id, org_id, crm_type, config_json, auth_json_encrypted, health_status")
    .in("org_id", orgIds)
    .eq("is_active", true)
    .order("priority", { ascending: true });

  // Map org_id → lowest-priority (first) active destination
  const destByOrg = new Map<string, CrmDestination>();
  for (const dest of (destinations ?? []) as CrmDestination[]) {
    if (!destByOrg.has(dest.org_id)) destByOrg.set(dest.org_id, dest);
  }

  let processed = 0, synced = 0, skipped = 0, failed = 0;

  for (const event of events as CrmSyncEvent[]) {
    const dest = destByOrg.get(event.org_id) ?? null;

    // ── No CRM configured → skip (retain event for future when user connects) ─
    if (!dest) {
      await sb.from("crm_sync_events").update({
        status:       "skipped",
        processed_at: new Date().toISOString(),
        last_error:   "no_crm_destination_configured",
      }).eq("id", event.id);

      await insertLog(sb, event.id, event.org_id, null, "route", "skipped", null, null, "no_crm_destination_configured");
      skipped++;
      processed++;
      continue;
    }

    // ── Route to adapter (never throws — all errors returned in result) ────────
    const result: AdapterResult = await routeToAdapter(dest, event, sb);

    // ── authFailed: mark destination immediately, fail without burning retries ─
    if (result.authFailed) {
      await sb.from("crm_destinations").update({
        health_status: "auth_failed",
        updated_at:    new Date().toISOString(),
      }).eq("id", dest.id).then(undefined, () => {});

      await sb.from("crm_sync_events").update({
        status:         "failed",
        processed_at:   new Date().toISOString(),
        destination_id: dest.id,
        attempts:       event.attempts + 1,
        last_error:     result.error ?? "auth_failed",
      }).eq("id", event.id);

      await insertLog(sb, event.id, event.org_id, dest.id, "sync", "auth_failed",
        { event_type: event.event_type }, null, result.error ?? "auth_failed");
      failed++;
      processed++;
      continue;
    }

    // ── rate_limited: re-queue as pending (attempt++ counts but not exhausted) ─
    if (result.error === "rate_limited_429") {
      const newAttempts = event.attempts + 1;
      const isFinal     = newAttempts >= event.max_attempts;
      await sb.from("crm_sync_events").update({
        status:         isFinal ? "failed" : "pending",
        attempts:       newAttempts,
        destination_id: dest.id,
        last_error:     "rate_limited_429",
        ...(isFinal ? { processed_at: new Date().toISOString() } : {}),
      }).eq("id", event.id);

      await insertLog(sb, event.id, event.org_id, dest.id, "sync",
        isFinal ? "failed" : "rate_limited",
        { event_type: event.event_type, attempt: newAttempts }, null, "rate_limited_429");
      isFinal ? failed++ : skipped++;
      processed++;
      continue;
    }

    // ── Skip (adapter stub / unbuilt CRM type) ─────────────────────────────────
    if (result.skip) {
      await sb.from("crm_sync_events").update({
        status:         "skipped",
        processed_at:   new Date().toISOString(),
        destination_id: dest.id,
        last_error:     result.error ?? null,
      }).eq("id", event.id);

      await insertLog(sb, event.id, event.org_id, dest.id, "sync", "skipped", null, null, result.error ?? null);
      skipped++;

    // ── Success ────────────────────────────────────────────────────────────────
    } else if (result.success) {
      await sb.from("crm_sync_events").update({
        status:         "synced",
        processed_at:   new Date().toISOString(),
        destination_id: dest.id,
        attempts:       event.attempts + 1,
        last_error:     null,
      }).eq("id", event.id);

      // Note: mapping upsert is handled inside each adapter (before-create check).
      // Worker only updates destination health and logs.
      await sb.from("crm_destinations").update({
        last_sync_at:  new Date().toISOString(),
        health_status: "healthy",
        updated_at:    new Date().toISOString(),
      }).eq("id", dest.id).then(undefined, () => {});

      await insertLog(sb, event.id, event.org_id, dest.id, "sync", "success",
        { event_type: event.event_type, entity_id: event.entity_id },
        { external_id: result.externalId ?? null }, null);
      synced++;

    // ── Failure — retry with natural backoff (5-min cron interval) ────────────
    } else {
      const newAttempts = event.attempts + 1;
      const isFinal     = newAttempts >= event.max_attempts;

      await sb.from("crm_sync_events").update({
        status:         isFinal ? "failed" : "pending",
        attempts:       newAttempts,
        destination_id: dest.id,
        last_error:     result.error ?? "unknown_error",
        ...(isFinal ? { processed_at: new Date().toISOString() } : {}),
      }).eq("id", event.id);

      await insertLog(sb, event.id, event.org_id, dest.id, "sync",
        isFinal ? "failed" : "retrying",
        { event_type: event.event_type, attempt: newAttempts },
        null, result.error ?? "unknown_error");
      failed++;
    }

    processed++;
  }

  console.log(`[crm_sync_worker] processed=${processed} synced=${synced} skipped=${skipped} failed=${failed}`);
  return ok({ processed, synced, skipped, failed });
});
