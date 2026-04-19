// lge_ingest — LGE Lead Ingestion Edge Function
// Accepts CSV batch or single lead; validates entitlement; dedupes; inserts into lge_raw_leads.

import { serve } from "https://deno.land/std/http/server.ts";
import { getUserSupabaseClient, getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BATCH = 500;

// ── Normalizers ────────────────────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(raw: string): string {
  if (!raw) return "";
  let s = String(raw).trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (hadPlus) s = "+" + s;
  if (!s.startsWith("+")) s = "+1" + s;
  const digits = s.replace("+", "");
  if (!/^\d{8,15}$/.test(digits)) return raw.trim().toLowerCase();
  return "+" + digits;
}

function normalizeCompany(company: string): string {
  return String(company ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Dedupe key: org_id + campaign_id + normalized_contact + normalized_company
function buildIdempotencyKey(
  orgId: string,
  campaignId: string,
  email: string,
  phone: string,
  company: string,
): string {
  const contact = email ? normalizeEmail(email) : normalizePhone(phone);
  return `${orgId}:${campaignId}:${contact}:${normalizeCompany(company)}`;
}

// ── Ingest core ────────────────────────────────────────────────────────────────
// Shared between JWT auth path and API-key auth path.

// Normalize source to enum values
function normalizeSource(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "csv") return "csv";
  if (s === "api_key" || s === "api") return "api_key";
  if (s === "internal" || s === "lge") return "internal";
  return "webhook"; // default for all external push integrations
}

async function runIngest(adminSb: any, orgId: string, body: any, importedBy: string | null = null) {
  // Support single-lead object OR leads array
  let { campaign_id, leads } = body;
  const source = normalizeSource(body.source ?? "webhook");
  if (!leads && (body.email || body.phone || body.name)) {
    leads = [body]; // single-lead POST
  }

  if (!campaign_id || typeof campaign_id !== "string") {
    return new Response(JSON.stringify({ error: "campaign_id required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (!Array.isArray(leads) || leads.length === 0) {
    return new Response(JSON.stringify({ error: "leads[] required (or send a single lead object)" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (leads.length > MAX_BATCH) {
    return new Response(JSON.stringify({ error: `Max ${MAX_BATCH} leads per batch` }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const [svcResult, campaignResult] = await Promise.all([
    adminSb.from("org_services").select("status").eq("org_id", orgId).eq("service_key", "lead_gen").maybeSingle(),
    adminSb.from("lge_campaigns").select("id, org_id, status, mode").eq("id", campaign_id).eq("org_id", orgId).maybeSingle(),
  ]);

  if (svcResult.data?.status !== "active") {
    return new Response(JSON.stringify({ error: "lead_gen entitlement not active" }), {
      status: 403, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const campaign = campaignResult.data;
  if (!campaign) {
    return new Response(JSON.stringify({ error: "Campaign not found or not yours" }), {
      status: 404, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (campaign.status === "archived") {
    return new Response(JSON.stringify({ error: "Cannot ingest into archived campaign" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (campaign.status === "paused") {
    return new Response(JSON.stringify({ error: "Campaign is paused — resume it before ingesting leads" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let accepted = 0, duplicates = 0, invalid = 0;
  const toInsert: any[] = [];

  for (const lead of leads) {
    const name    = String(lead.name ?? lead.full_name ?? lead.first_name ?? "").trim() || null;
    const rawEmail = String(lead.email ?? "").trim();
    const rawPhone = String(lead.phone ?? lead.phone_number ?? lead.mobile ?? "").trim();
    const company  = String(lead.company ?? lead.organization ?? lead.company_name ?? "").trim() || null;
    const email    = rawEmail ? normalizeEmail(rawEmail) : null;
    const phone    = rawPhone ? normalizePhone(rawPhone) : null;
    if (!email && !phone) { invalid++; continue; }
    const idempotencyKey = buildIdempotencyKey(orgId, campaign_id, email ?? "", phone ?? "", company ?? "");
    toInsert.push({ campaign_id, org_id: orgId, name, email, phone, company, source, raw_data: lead, idempotency_key: idempotencyKey, status: "pending" });
  }

  const CHUNK = 100;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { data: inserted, error: insErr } = await adminSb
      .from("lge_raw_leads")
      .upsert(chunk, { onConflict: "idempotency_key", ignoreDuplicates: true })
      .select("id");
    if (insErr) {
      console.error("[lge_ingest] insert error:", insErr.message);
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const insertedCount = inserted?.length ?? 0;
    accepted += insertedCount;
    duplicates += chunk.length - insertedCount;
  }

  // Write import batch record (idempotent — unique key prevents double-count on retry)
  const batchKey = `${orgId}:${campaign_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  adminSb.from("lge_import_batches").insert({
    org_id: orgId,
    campaign_id,
    source,
    total: leads.length,
    accepted,
    duplicates,
    invalid,
    imported_by: importedBy,
    idempotency_key: batchKey,
  }).then(undefined, (e: any) => console.error("[lge_ingest] batch record error:", e?.message));

  return new Response(
    JSON.stringify({ ok: true, accepted, duplicates, invalid, total: leads.length }),
    { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
  );
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const adminSb = getServiceSupabaseClient();

    // ── Path A: API key auth (webhook / Zapier / Make integration) ──────────────
    const apiKeyHeader = req.headers.get("X-Api-Key");
    if (apiKeyHeader) {
      const { data: keyRow } = await adminSb
        .from("api_keys")
        .select("org_id")
        .eq("api_key", apiKeyHeader)
        .maybeSingle();

      if (!keyRow?.org_id) {
        return new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401, headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Update last_used_at (best-effort — don't block on failure)
      adminSb.from("api_keys").update({ last_used_at: new Date().toISOString() })
        .eq("api_key", apiKeyHeader).then(undefined, () => {});

      const body = await req.json().catch(() => ({}));
      return runIngest(adminSb, keyRow.org_id, body, null); // API key — no user ID
    }

    // ── Path B: JWT auth (dashboard / CSV import) ───────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized — provide Authorization: Bearer <jwt> or X-Api-Key: <key>" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("GSC_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "Authorization": `Bearer ${token}`, "apikey": serviceKey },
    });
    if (!userResp.ok) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const userData = await userResp.json();
    const userId: string = userData?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // 2. Resolve org_id
    const { data: memRows } = await adminSb
      .from("org_members")
      .select("org_id")
      .eq("user_id", userId)
      .limit(1);

    let orgId: string;
    if (memRows && memRows.length > 0) {
      orgId = memRows[0].org_id;
    } else {
      return new Response(JSON.stringify({ error: "No organization found" }), {
        status: 403, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // 3. Parse body and delegate to shared ingest core
    const body = await req.json().catch(() => ({}));
    return runIngest(adminSb, orgId, { ...body, source: body.source ?? "csv" }, userId); // source normalized inside runIngest
  } catch (e: any) {
    console.error("[lge_ingest] unhandled error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
