// intake_router — Phase 20: LGE-first intake orchestration
// This is the new public webhook endpoint for GSC orgs.
// Legacy path: source → hook_inbound (still works, backward compatible)
// New path:    source → intake_router → LGE queue → lge_worker → hook_inbound logic
//
// Auth: X-API-Key header (same api_keys table as hook_inbound)
//
// Per-org intake policies (lge_intake_policies):
//   fail_open   — LGE failure → push directly to GSC (default)
//   fail_closed — LGE failure → hold lead, do NOT push
//   shadow_only — always push to GSC AND evaluate in LGE for analysis
//
// Stamps every decision to lge_intake_events (idempotent).

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-idempotency-key",
};

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Phone normalizer (E.164) ──────────────────────────────────────────────────
function normalizePhone(raw: string): string {
  if (!raw) return "";
  let s = String(raw).trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (hadPlus) s = "+" + s;
  if (!s.startsWith("+")) s = "+1" + s;
  const digits = s.replace("+", "");
  if (!/^\d{8,15}$/.test(digits)) return raw.trim();
  return "+" + digits;
}

// ── Source parsers (mirrors hook_inbound) ────────────────────────────────────

type Parsed = { name: string; phone: string; email: string | null; notes: string | null; company: string | null };

function parseGHL(b: Record<string, unknown>): Parsed {
  const firstName = String(b.first_name ?? b.firstName ?? b.contact_first_name ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? b.contact_last_name  ?? "").trim();
  return {
    name:    [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone:   normalizePhone(String(b.phone ?? b.phone_number ?? b.contact_phone ?? "")),
    email:   String(b.email ?? b.contact_email ?? "").trim().toLowerCase() || null,
    notes:   String(b.message ?? b.notes ?? b.form_submission ?? "").trim() || null,
    company: String(b.company ?? b.company_name ?? "").trim() || null,
  };
}

function parseZapier(b: Record<string, unknown>): Parsed {
  const fullName  = String(b.name ?? b.full_name ?? "").trim();
  const firstName = String(b.first_name ?? b.firstName ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? "").trim();
  return {
    name:    fullName || [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone:   normalizePhone(String(b.phone ?? b.phone_number ?? b.mobile ?? "")),
    email:   String(b.email ?? "").trim().toLowerCase() || null,
    notes:   String(b.notes ?? b.message ?? b.description ?? "").trim() || null,
    company: String(b.company ?? b.company_name ?? "").trim() || null,
  };
}

function parseApollo(b: Record<string, unknown>): Parsed {
  const contact   = (b.contact ?? b) as Record<string, unknown>;
  const firstName = String(contact.first_name ?? "").trim();
  const lastName  = String(contact.last_name  ?? "").trim();
  return {
    name:    [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone:   normalizePhone(String(contact.phone_number ?? contact.phone ?? "")),
    email:   String(contact.email ?? "").trim().toLowerCase() || null,
    notes:   String(contact.headline ?? contact.title ?? "").trim() || null,
    company: String(contact.organization_name ?? "").trim() || null,
  };
}

function parseHubSpot(b: Record<string, unknown>): Parsed {
  const props = (b.properties ?? b) as Record<string, unknown>;
  return {
    name:    `${String(props.firstname ?? "").trim()} ${String(props.lastname ?? "").trim()}`.trim() || "Unknown Lead",
    phone:   normalizePhone(String(props.phone ?? props.mobilephone ?? "")),
    email:   String(props.email ?? "").trim().toLowerCase() || null,
    notes:   String(props.message ?? props.hs_lead_status ?? "").trim() || null,
    company: String(props.company ?? "").trim() || null,
  };
}

function parseGeneric(b: Record<string, unknown>): Parsed {
  const fullName  = String(b.name ?? b.full_name ?? b.contact_name ?? "").trim();
  const firstName = String(b.first_name ?? b.firstName ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? "").trim();
  return {
    name:    fullName || [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone:   normalizePhone(String(b.phone ?? b.phone_number ?? b.mobile ?? b.contact_phone ?? "")),
    email:   String(b.email ?? b.email_address ?? "").trim().toLowerCase() || null,
    notes:   String(b.notes ?? b.message ?? b.comment ?? "").trim() || null,
    company: String(b.company ?? b.company_name ?? b.organization ?? "").trim() || null,
  };
}

function detectSourceAndParse(body: Record<string, unknown>, urlSource: string | null): { source: string; parsed: Parsed } {
  if (urlSource === "ghl" || body.contactId || body.contact_id) {
    return { source: "ghl", parsed: parseGHL(body) };
  }
  if (urlSource === "apollo" || body.contact || (body.people && Array.isArray(body.people))) {
    return { source: "apollo", parsed: parseApollo(body) };
  }
  if (urlSource === "hubspot" || body.properties || body.objectType === "contact") {
    return { source: "hubspot", parsed: parseHubSpot(body) };
  }
  if (urlSource === "zapier" || urlSource === "make") {
    return { source: urlSource, parsed: parseZapier(body) };
  }
  return { source: "intake_router", parsed: parseGeneric(body) };
}

// ── SHA-256 idempotency key ───────────────────────────────────────────────────

async function buildIdempotencyKey(orgId: string, parsed: Parsed, salt: string): Promise<string> {
  const raw = `${orgId}:${parsed.phone}:${parsed.email ?? ""}:${salt}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ── Resolve actor user (same as lge_worker) ───────────────────────────────────

async function resolveActorUserId(
  sb: ReturnType<typeof getServiceSupabaseClient>,
  orgId: string,
): Promise<string | null> {
  const { data: named } = await sb.from("org_members").select("user_id")
    .eq("org_id", orgId).in("role", ["enterprise_admin", "agency_admin", "owner"])
    .limit(1).maybeSingle();
  if (named) return named.user_id;
  const { data: solo } = await sb.from("org_members").select("user_id")
    .eq("org_id", orgId).is("role", null).limit(1).maybeSingle();
  return solo?.user_id ?? null;
}

// ── Direct GSC push (fail_open / shadow_only fallback) ────────────────────────

async function pushToGsc(
  sb: ReturnType<typeof getServiceSupabaseClient>,
  orgId: string,
  parsed: Parsed,
  source: string,
  extraNotes: string | null,
): Promise<string | null> {
  const actorUserId = await resolveActorUserId(sb, orgId);
  if (!actorUserId) return null;

  // Phone dedupe guard
  if (parsed.phone) {
    const { data: existing } = await sb.from("leads").select("id")
      .eq("org_id", orgId).eq("phone", parsed.phone).maybeSingle();
    if (existing) return existing.id as string;
  }

  const notes = [parsed.notes, extraNotes].filter(Boolean).join(" | ");

  const { data: gscLead, error: leadErr } = await sb.from("leads").insert({
    org_id:     orgId,
    profile_id: actorUserId,
    name:       parsed.name,
    phone:      parsed.phone || null,
    email:      parsed.email ?? null,
    notes:      notes || null,
    status:     "new",
    source:     source,
  }).select("id").single();

  if (leadErr || !gscLead) {
    console.error("[intake_router] lead insert failed:", leadErr?.message);
    return null;
  }

  const { data: plan } = await sb.from("decision_plans").insert({
    lead_id: gscLead.id,
    org_id:  orgId,
    trigger: "webhook_inbound",
    plan:    { channel: "sms", source_event: "intake_router", source },
  }).select("id").single();

  if (plan) {
    await sb.from("execution_tasks").insert({
      plan_id:       plan.id,
      lead_id:       gscLead.id,
      org_id:        orgId,
      channel:       "sms",
      max_attempts:  3,
      scheduled_for: new Date().toISOString(),
      status:        "pending",
      actor_user_id: actorUserId,
      metadata: { source, source_event: "intake_router", trigger: "introductory_sms" },
    });
  }

  return gscLead.id as string;
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = getServiceSupabaseClient();

  // ── Auth: resolve org from API key ────────────────────────────────────────
  const rawKey = req.headers.get("x-api-key") ?? req.headers.get("X-API-Key") ?? "";
  if (!rawKey) return err("Missing X-API-Key header", 401);

  const { data: keyRow, error: keyErr } = await sb.from("api_keys")
    .select("org_id")
    .eq("api_key", rawKey)
    .maybeSingle();

  if (keyErr || !keyRow) return err("Invalid API key", 401);
  const orgId = keyRow.org_id as string;

  // Update last_used_at (fire-and-forget)
  sb.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("api_key", rawKey)
    .then(undefined, () => {});

  // ── Parse webhook body ────────────────────────────────────────────────────
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* tolerate empty bodies */ }

  const url       = new URL(req.url);
  const urlSource = url.searchParams.get("source");
  const { source, parsed } = detectSourceAndParse(body, urlSource);

  // Require at least phone or email
  if (!parsed.phone && !parsed.email) {
    return err("Lead must include at least one of: phone, email", 422);
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  const clientKey = req.headers.get("x-idempotency-key");
  const today     = new Date().toISOString().slice(0, 10);
  const idemKey   = clientKey ?? await buildIdempotencyKey(orgId, parsed, today);

  const { data: priorEvent } = await sb.from("lge_intake_events")
    .select("id, router_decision, lge_lead_id, gsc_lead_id")
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  if (priorEvent) {
    return ok({
      idempotent: true,
      router_decision: priorEvent.router_decision,
      lge_lead_id: priorEvent.lge_lead_id ?? null,
      gsc_lead_id: priorEvent.gsc_lead_id ?? null,
    });
  }

  // ── Resolve campaign_id ───────────────────────────────────────────────────
  const requestedCampaignId = (body.campaign_id as string) ?? null;
  let campaignId: string | null = null;

  if (requestedCampaignId) {
    const { data: camp } = await sb.from("lge_campaigns")
      .select("id, status, mode").eq("id", requestedCampaignId).eq("org_id", orgId).maybeSingle();
    if (camp && camp.status === "active") campaignId = camp.id as string;
  } else {
    const { data: camps } = await sb.from("lge_campaigns")
      .select("id").eq("org_id", orgId).eq("status", "active")
      .order("created_at", { ascending: true }).limit(1);
    if (camps && camps.length > 0) campaignId = (camps[0] as any).id as string;
  }

  // ── Check LGE entitlement ─────────────────────────────────────────────────
  const { data: svc } = await sb.from("org_services")
    .select("status").eq("org_id", orgId).eq("service_key", "lead_gen").maybeSingle();
  const lgeActive = svc?.status === "active" && campaignId !== null;

  // ── Load per-org intake policy ────────────────────────────────────────────
  const { data: policy } = await sb.from("lge_intake_policies")
    .select("failover_policy").eq("org_id", orgId).maybeSingle();
  const failoverPolicy: "fail_open" | "fail_closed" | "shadow_only" =
    (policy?.failover_policy as any) ?? "fail_open";

  // ── Stamp helper ──────────────────────────────────────────────────────────
  async function stampEvent(decision: string, opts: {
    fallbackReason?: string;
    lgeLeadId?: string | null;
    gscLeadId?: string | null;
  } = {}) {
    await sb.from("lge_intake_events").insert({
      idempotency_key: idemKey,
      org_id:          orgId,
      intake_source:   source,
      campaign_id:     campaignId,
      router_decision: decision,
      fallback_reason: opts.fallbackReason ?? null,
      lge_lead_id:     opts.lgeLeadId ?? null,
      gsc_lead_id:     opts.gscLeadId ?? null,
      raw_payload:     body,
    }).then(undefined, () => {});
  }

  // ── shadow_only: push to GSC AND queue in LGE ────────────────────────────
  if (failoverPolicy === "shadow_only") {
    let gscLeadId: string | null = null;
    let lgeLeadId: string | null = null;

    // Always push to GSC
    try {
      gscLeadId = await pushToGsc(sb, orgId, parsed, source, "[shadow mode — LGE analysis in parallel]");
    } catch (e: any) {
      console.warn("[intake_router] shadow GSC push failed:", e.message);
    }

    // Also queue in LGE if active (for analysis only — campaign mode is shadow)
    if (lgeActive) {
      try {
        const { data: lead } = await sb.from("lge_raw_leads").insert({
          org_id:      orgId,
          campaign_id: campaignId,
          name:        parsed.name,
          email:       parsed.email ?? null,
          phone:       parsed.phone || null,
          company:     parsed.company ?? null,
          source:      source,
          raw_data:    body,
          status:      "pending",
          attempt:     0,
          max_attempts: 3,
        }).select("id").single();
        if (lead) lgeLeadId = lead.id as string;
      } catch (e: any) {
        console.warn("[intake_router] shadow LGE insert failed:", e.message);
      }
    }

    await stampEvent("shadow", { lgeLeadId, gscLeadId });
    return ok({ router_decision: "shadow", lge_lead_id: lgeLeadId, gsc_lead_id: gscLeadId });
  }

  // ── LGE-first path ────────────────────────────────────────────────────────
  if (lgeActive) {
    try {
      const { data: lead, error: insertErr } = await sb.from("lge_raw_leads").insert({
        org_id:      orgId,
        campaign_id: campaignId,
        name:        parsed.name,
        email:       parsed.email ?? null,
        phone:       parsed.phone || null,
        company:     parsed.company ?? null,
        source:      source,
        raw_data:    body,
        status:      "pending",
        attempt:     0,
        max_attempts: 3,
      }).select("id").single();

      if (insertErr) throw new Error(insertErr.message);

      const lgeLeadId = lead.id as string;

      // Increment usage
      sb.rpc("lge_increment_usage", { p_org_id: orgId, p_field: "leads_ingested" })
        .then(undefined, () => {});

      await stampEvent("lge_queued", { lgeLeadId });
      return ok({ router_decision: "lge_queued", lge_lead_id: lgeLeadId }, 201);

    } catch (lgeErr: any) {
      console.warn("[intake_router] LGE insert failed:", lgeErr.message);
      // Fall through to failover handling below
    }
  }

  // ── LGE unavailable or failed — apply failover policy ────────────────────
  const lgeFailReason = lgeActive ? "lge_insert_failed" : (svc?.status !== "active" ? "lge_not_active" : "no_active_campaign");

  if (failoverPolicy === "fail_open") {
    let gscLeadId: string | null = null;
    try {
      gscLeadId = await pushToGsc(sb, orgId, parsed, source, `[LGE fallback: ${lgeFailReason}]`);
    } catch (gscErr: any) {
      console.error("[intake_router] GSC fallback push failed:", gscErr.message);
      await stampEvent("error", { fallbackReason: gscErr.message });
      return err("Failed to process lead", 500);
    }

    await stampEvent("fallback_open", { fallbackReason: lgeFailReason, gscLeadId });
    return ok({ router_decision: "fallback_open", reason: lgeFailReason, gsc_lead_id: gscLeadId });
  }

  if (failoverPolicy === "fail_closed") {
    // Hold the lead — do not push to GSC
    await stampEvent("fallback_closed", { fallbackReason: lgeFailReason });
    return ok({ router_decision: "fallback_closed", reason: lgeFailReason, held: true });
  }

  // Should not reach here
  await stampEvent("error", { fallbackReason: "unknown_policy" });
  return err("Unknown intake policy", 500);
});
