import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

// ─── Phone normalizer (E.164) ─────────────────────────────────────────────────
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

// ─── Source parsers ───────────────────────────────────────────────────────────

type Normalized = { name: string; phone: string; email: string | null; notes: string | null };

/** GoHighLevel contact / form-submitted webhook */
function parseGHL(b: Record<string, unknown>): Normalized {
  const firstName = String(b.first_name ?? b.firstName ?? b.contact_first_name ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? b.contact_last_name  ?? "").trim();
  return {
    name:  [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(String(b.phone ?? b.phone_number ?? b.contact_phone ?? "")),
    email: String(b.email ?? b.contact_email ?? "").trim().toLowerCase() || null,
    notes: String(b.message ?? b.notes ?? b.form_submission ?? "").trim() || null,
  };
}

/** Zapier / Make.com — standardized flat schema we document for users */
function parseZapier(b: Record<string, unknown>): Normalized {
  const firstName = String(b.first_name ?? b.firstName ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? "").trim();
  const fullName  = String(b.name ?? b.full_name ?? "").trim();
  return {
    name:  fullName || [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(String(b.phone ?? b.phone_number ?? b.mobile ?? "")),
    email: String(b.email ?? "").trim().toLowerCase() || null,
    notes: String(b.notes ?? b.message ?? b.description ?? "").trim() || null,
  };
}

/** Apollo.io contact export / enrichment webhook */
function parseApollo(b: Record<string, unknown>): Normalized {
  const contact = (b.contact ?? b) as Record<string, unknown>;
  const firstName = String(contact.first_name ?? "").trim();
  const lastName  = String(contact.last_name  ?? "").trim();
  return {
    name:  [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(String(contact.phone_number ?? contact.phone ?? contact.mobile_phone ?? "")),
    email: String(contact.email ?? "").trim().toLowerCase() || null,
    notes: String(contact.headline ?? contact.title ?? contact.organization_name ?? "").trim() || null,
  };
}

/** HubSpot contact created/updated webhook */
function parseHubSpot(b: Record<string, unknown>): Normalized {
  // HubSpot sends either a properties map or a flat object
  const props = (b.properties ?? b) as Record<string, unknown>;
  // HubSpot properties are often objects with a 'value' key
  const get = (key: string): string => {
    const v = props[key];
    if (v && typeof v === "object" && "value" in (v as object)) return String((v as Record<string,unknown>).value ?? "");
    return String(v ?? "");
  };
  const firstName = get("firstname").trim();
  const lastName  = get("lastname").trim();
  return {
    name:  [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(get("phone") || get("mobilephone")),
    email: (get("email") || "").trim().toLowerCase() || null,
    notes: (get("message") || get("notes") || get("hs_lead_status") || "").trim() || null,
  };
}

/** Facebook Lead Ads — field_data array format */
function parseFacebook(b: Record<string, unknown>): Normalized {
  // Payload may be nested: b.entry[0].changes[0].value.leads[0].field_data
  // OR already unwrapped to the lead object directly
  let fieldData = (b.field_data ?? []) as Array<{ name: string; values: string[] }>;

  if (fieldData.length === 0) {
    // Try to drill into FB's nested delivery format
    try {
      const entry   = (b.entry   as unknown[])?.[0] as Record<string,unknown>;
      const changes = (entry?.changes as unknown[])?.[0] as Record<string,unknown>;
      const lead    = (changes?.value as Record<string,unknown>)?.leads as unknown[];
      fieldData     = (lead?.[0] as Record<string,unknown>)?.field_data as typeof fieldData ?? [];
    } catch { /* ignore */ }
  }

  const fm: Record<string, string> = {};
  for (const f of fieldData) fm[f.name] = f.values?.[0] ?? "";

  return {
    name:  fm.full_name || [fm.first_name, fm.last_name].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(fm.phone_number ?? fm.phone ?? ""),
    email: (fm.email ?? "").trim().toLowerCase() || null,
    notes: (fm.message ?? "").trim() || null,
  };
}

/** Generic / unknown source — best-effort field sniffing */
function parseGeneric(b: Record<string, unknown>): Normalized {
  const firstName = String(b.first_name ?? b.firstName ?? "").trim();
  const lastName  = String(b.last_name  ?? b.lastName  ?? "").trim();
  const fullName  = String(b.name ?? b.full_name ?? b.fullName ?? "").trim();
  return {
    name:  fullName || [firstName, lastName].filter(Boolean).join(" ") || "Unknown Lead",
    phone: normalizePhone(String(b.phone ?? b.phone_number ?? b.mobile ?? b.cell ?? "")),
    email: String(b.email ?? b.email_address ?? "").trim().toLowerCase() || null,
    notes: String(b.notes ?? b.message ?? b.description ?? b.comment ?? "").trim() || null,
  };
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS: HeadersInit = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Content-Type": "application/json",
};

// ─── Main handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });

  const url    = new URL(req.url);
  const source = (url.searchParams.get("source") ?? "generic").toLowerCase();

  // ── Extract API key (Bearer header takes priority; ?api_key= fallback for platforms
  //    like standard GHL that don't support custom request headers easily) ──────
  const authHeader = req.headers.get("Authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : (url.searchParams.get("api_key") ?? "").trim();

  if (!rawKey) {
    return new Response(JSON.stringify({ error: "Missing API key" }), { status: 401, headers: CORS });
  }

  const supabase = getServiceSupabaseClient();

  // ── Validate key and resolve org_id ────────────────────────────────────────
  const { data: keyRow, error: keyErr } = await supabase
    .from("api_keys")
    .select("id, org_id")
    .eq("api_key", rawKey)
    .maybeSingle();

  if (keyErr || !keyRow) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401, headers: CORS });
  }

  const { id: keyId, org_id } = keyRow;

  // Fire-and-forget: update last_used_at (non-blocking)
  supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyId).then(() => {});

  // Payload size guard
  const contentLen = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLen > 65536) { // 64 KB
    return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413, headers: CORS });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: CORS });
  }

  // ── Normalize lead data ─────────────────────────────────────────────────────
  let normalized: Normalized;
  switch (source) {
    case "ghl":      normalized = parseGHL(body);      break;
    case "zapier":   normalized = parseZapier(body);   break;
    case "make":     normalized = parseZapier(body);   break; // Make uses same flat schema as Zapier
    case "apollo":   normalized = parseApollo(body);   break;
    case "hubspot":  normalized = parseHubSpot(body);  break;
    case "facebook": normalized = parseFacebook(body); break;
    default:         normalized = parseGeneric(body);  break;
  }

  // Must have at least phone or email to be actionable
  if (!normalized.phone && !normalized.email) {
    return new Response(
      JSON.stringify({ error: "Lead must have a phone number or email address" }),
      { status: 422, headers: CORS }
    );
  }

  // ── Duplicate check: idempotency guard on phone per org ────────────────────
  if (normalized.phone) {
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("org_id", org_id)
      .eq("phone", normalized.phone)
      .maybeSingle();

    if (existing) {
      return new Response(
        JSON.stringify({ status: "duplicate", lead_id: existing.id, message: "Lead with this phone already exists" }),
        { status: 200, headers: CORS }
      );
    }
  }

  // ── Resolve org owner / admin user_id ──────────────────────────────────────
  // Needed for leads.profile_id (NOT NULL) and execution_tasks.actor_user_id
  // Resolve an actor user: prefer admin/owner roles, fall back to null-role solo member
  const { data: namedRoleRow } = await supabase
    .from("org_members")
    .select("user_id")
    .eq("org_id", org_id)
    .in("role", ["enterprise_admin", "agency_admin", "owner"])
    .limit(1)
    .maybeSingle();

  const { data: nullRoleRow } = namedRoleRow ? { data: null } : await supabase
    .from("org_members")
    .select("user_id")
    .eq("org_id", org_id)
    .is("role", null)
    .limit(1)
    .maybeSingle();

  const actorUserId = (namedRoleRow ?? nullRoleRow)?.user_id ?? null;
  if (!actorUserId) {
    return new Response(JSON.stringify({ error: "No org member found to own this lead" }), { status: 500, headers: CORS });
  }

  // ── Insert lead ─────────────────────────────────────────────────────────────
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .insert({
      org_id,
      profile_id: actorUserId,
      name:   normalized.name,
      phone:  normalized.phone  || null,
      email:  normalized.email  || null,
      notes:  normalized.notes  || null,
      status: "new",
      source: source === "generic" ? "webhook" : source,
    })
    .select("id")
    .single();

  if (leadErr || !lead) {
    return new Response(
      JSON.stringify({ error: "Failed to create lead", detail: leadErr?.message }),
      { status: 500, headers: CORS }
    );
  }

  // ── Create decision_plan (execution_tasks.plan_id is NOT NULL) ──────────────
  const { data: plan, error: planErr } = await supabase
    .from("decision_plans")
    .insert({
      lead_id: lead.id,
      org_id,
      trigger: "webhook_inbound",
      plan:    { channel: "sms", source_event: "webhook_inbound", source },
    })
    .select("id")
    .single();

  if (planErr || !plan) {
    return new Response(
      JSON.stringify({ error: "Failed to create decision plan", detail: planErr?.message }),
      { status: 500, headers: CORS }
    );
  }

  // ── Insert execution_task → AI outreach queued ──────────────────────────────
  const { data: task, error: taskErr } = await supabase
    .from("execution_tasks")
    .insert({
      plan_id:       plan.id,
      lead_id:       lead.id,
      org_id,
      channel:       "sms",
      max_attempts:  3,
      scheduled_for: new Date().toISOString(),
      status:        "pending",
      actor_user_id: actorUserId,
      metadata: {
        source:         "hook_inbound",
        source_event:   "webhook_inbound",
        webhook_source: source,
        trigger:        "introductory_sms",
      },
    })
    .select("id")
    .single();

  if (taskErr) {
    return new Response(
      JSON.stringify({ error: "Failed to queue execution task", detail: taskErr?.message }),
      { status: 500, headers: CORS }
    );
  }

  return new Response(
    JSON.stringify({
      status:   "ok",
      lead_id:  lead.id,
      task_id:  task?.id,
      message:  "Lead ingested and AI outreach queued",
    }),
    { status: 201, headers: CORS }
  );
});
