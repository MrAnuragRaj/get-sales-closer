import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeHmacSha256Hex(secret: string, body: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return hex(sigBytes);
}

function normalizeCalSignatureHeader(sig: string) {
  // Cal commonly sends: "sha256=<hex>"
  const s = sig.trim();
  if (s.toLowerCase().startsWith("sha256=")) return s.slice("sha256=".length).trim();
  return s;
}

function extractCancelledCount(cancelRes: any): number {
  // Support multiple RPC shapes (Supabase can return array rows, or object)
  const v =
    cancelRes?.cancelled_count ??
    cancelRes?.[0]?.cancelled_count ??
    cancelRes?.cancel_pending_tasks_for_lead_v1?.cancelled_count ??
    cancelRes?.[0]?.cancel_pending_tasks_for_lead_v1?.cancelled_count ??
    0;

  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  // 1) Only POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 2) Org scope
  const url = new URL(req.url);
  const orgId = url.searchParams.get("org_id");

  if (!orgId) {
    return new Response("Missing org_id parameter", { status: 400 });
  }

  // 3) Signature verification (recommended in prod)
  const rawBody = await req.text(); // Read once
  const signatureHeader = req.headers.get("X-Cal-Signature-256");
  const CAL_WEBHOOK_SECRET = Deno.env.get("CAL_WEBHOOK_SECRET") ?? "";

  if (CAL_WEBHOOK_SECRET) {
    if (!signatureHeader) return new Response("Missing signature", { status: 401 });

    const expectedHex = await computeHmacSha256Hex(CAL_WEBHOOK_SECRET, rawBody);
    const gotHex = normalizeCalSignatureHeader(signatureHeader);

    if (expectedHex !== gotHex) {
      console.error("invalid_cal_signature");
      return new Response("Invalid signature", { status: 401 });
    }
  }

  // Parse JSON after verification
  let payload: any = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const triggerEvent = payload?.triggerEvent ?? null;

  // 4) Filter
  if (triggerEvent !== "BOOKING_CREATED") {
    return new Response("Ignored event type", { status: 200 });
  }

  const attendees = payload?.payload?.attendees ?? [];
  const leadEmail = attendees?.[0]?.email ?? null;
  const bookingUid = payload?.payload?.uid ?? null;

  if (!leadEmail || !bookingUid) {
    return new Response("Missing booking email/uid", { status: 200 });
  }

  // 5) Idempotency: have we already recorded this booking?
  const { data: existing } = await supabase
    .from("lead_timeline_events")
    .select("id")
    .eq("org_id", orgId)
    .eq("event_type", "meeting_booked")
    .contains("payload", { event_id: bookingUid })
    .maybeSingle();

  if (existing) {
    return new Response("Event already processed", { status: 200 });
  }

  // 6) Scoped match: find lead in the org
  const { data: lead } = await supabase
    .from("leads")
    .select("id, org_id")
    .eq("email", leadEmail)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!lead) {
    return new Response("Lead not matched", { status: 200 });
  }

  // 7) Cancel pending tasks for this lead (audited + deterministic count)
  let cancelledCount = 0;

  const { data: cancelRes, error: cancelRpcErr } = await supabase.rpc(
    "cancel_pending_tasks_for_lead_v1",
    { p_org_id: orgId, p_lead_id: lead.id },
  );

  if (cancelRpcErr) {
    console.error("cancel_pending_tasks_for_lead_v1_failed", cancelRpcErr.message);
  } else {
    cancelledCount = extractCancelledCount(cancelRes);
  }

  // 7b) sanity: any pending tasks still remain?
  const { data: remainingPending } = await supabase
    .from("execution_tasks")
    .select("id")
    .eq("org_id", orgId)
    .eq("lead_id", lead.id)
    .eq("status", "pending");

  // 8) Update lead status
  await supabase
    .from("leads")
    .update({ status: "booked" })
    .eq("org_id", orgId)
    .eq("id", lead.id);

  // 9) Logging
  await supabase.from("interactions").insert({
    lead_id: lead.id,
    org_id: orgId,
    type: "calendar",
    direction: "inbound",
    content: `Meeting booked via Cal.com (Event ID: ${bookingUid})`,
    metadata: { source: "cal.com", event_id: bookingUid, tasks_cancelled: cancelledCount },
  });

  await supabase.from("lead_timeline_events").insert({
    lead_id: lead.id,
    org_id: orgId,
    event_type: "meeting_booked",
    actor_type: "system",
    payload: {
      source: "cal.com",
      event_id: bookingUid,
      tasks_cancelled: cancelledCount,
      note: remainingPending?.length
        ? "Some pending tasks remain (investigate)"
        : "No pending tasks remain",
    },
  });

  return new Response(
    JSON.stringify({ success: true, org_id: orgId, lead_id: lead.id, tasks_cancelled: cancelledCount }),
    { status: 200 },
  );
});