// lge_campaign_manage — LGE Campaign CRUD + Provider Key Management
// Actions: create, update, list, get, set_provider_key, delete_provider_key, get_provider_status

import { serve } from "https://deno.land/std/http/server.ts";
import { getUserSupabaseClient, getServiceSupabaseClient } from "../_shared/db.ts";
import {
  computeFitScore,
  computeConfidenceScore,
  computeTotalScore,
  computeSignalAdjustments,
  routeByScore,
  type IcpConfig,
  type EnrichmentData,
  type LeadData,
} from "../_shared/lge_scorer.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Encryption (AES-GCM) ──────────────────────────────────────────────────────
// Key is derived from LGE_ENCRYPTION_KEY env var (required in Supabase secrets).
// If not set, falls back to deriving from service role key (weaker but functional).

async function getEncryptionKey(): Promise<CryptoKey> {
  const rawKey = Deno.env.get("LGE_ENCRYPTION_KEY") ??
    Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "fallback-insecure-key-set-LGE_ENCRYPTION_KEY";

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(rawKey),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("lge-provider-api-keys-v1"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptKey(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  // Pack as base64(iv):base64(ciphertext)
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  return `${ivB64}:${ctB64}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveOrgId(userSb: any, userId: string): Promise<string | null> {
  const { data: memRows } = await userSb
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1);

  if (memRows && memRows.length > 0) return memRows[0].org_id;

  const { data: orgRow } = await userSb
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();

  return orgRow?.id ?? null;
}

async function checkEntitlement(userSb: any, orgId: string): Promise<boolean> {
  const { data: svc } = await userSb
    .from("org_services")
    .select("status")
    .eq("org_id", orgId)
    .eq("service_key", "lead_gen")
    .maybeSingle();
  return svc?.status === "active";
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function decryptKey(encrypted: string): Promise<string> {
  const key = await getEncryptionKey();
  const [ivB64, ctB64] = encrypted.split(":");
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// ── Action handlers ───────────────────────────────────────────────────────────

const CAMPAIGN_COLS = "id, name, status, mode, pre_pause_mode, icp_config, max_leads_per_day, auto_push_threshold, review_threshold, review_ttl_days, outreach_template, created_at, updated_at";

async function handleList(userSb: any, orgId: string) {
  const { data, error } = await userSb
    .from("lge_campaigns")
    .select(CAMPAIGN_COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) return err(error.message, 500);
  return ok({ campaigns: data ?? [] });
}

async function handleGet(userSb: any, orgId: string, campaignId: string) {
  const { data, error } = await userSb
    .from("lge_campaigns")
    .select(CAMPAIGN_COLS)
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error) return err(error.message, 500);
  if (!data) return err("Campaign not found", 404);
  return ok({ campaign: data });
}

async function handleCreate(userSb: any, adminSb: any, orgId: string, userId: string, body: any) {
  const {
    name, mode = "off", icp_config = {}, max_leads_per_day = 100,
    auto_push_threshold = 80, review_threshold = 60, outreach_template,
    review_ttl_days = 10,
  } = body;

  if (!name || typeof name !== "string" || !name.trim()) return err("name required");
  if (!["off", "shadow", "active"].includes(mode)) return err("mode must be off|shadow|active");

  const apt = Number(auto_push_threshold);
  const rt  = Number(review_threshold);
  if (apt <= rt || apt < 51 || apt > 100 || rt < 0 || rt > 99) {
    return err("auto_push_threshold must be 51–100 and strictly above review_threshold (0–99)");
  }

  const { data, error } = await adminSb
    .from("lge_campaigns")
    .insert({
      org_id: orgId,
      name: name.trim(),
      mode,
      icp_config,
      max_leads_per_day: Number(max_leads_per_day) || 100,
      auto_push_threshold: apt,
      review_threshold:    rt,
      review_ttl_days:     Math.max(1, Math.min(90, Number(review_ttl_days) || 10)),
      outreach_template:   outreach_template ? String(outreach_template).slice(0, 2000) : null,
      created_by: userId,
    })
    .select(CAMPAIGN_COLS)
    .single();

  if (error) return err(error.message, 500);
  return ok({ campaign: data }, 201);
}

async function handleUpdate(userSb: any, adminSb: any, orgId: string, campaignId: string, body: any) {
  // Block editing paused or archived campaigns
  const { data: campCheck } = await adminSb.from("lge_campaigns").select("status").eq("id", campaignId).eq("org_id", orgId).maybeSingle();
  if (!campCheck) return err("Campaign not found", 404);
  if (campCheck.status === "archived") return err("Archived campaigns cannot be edited", 400);
  if (campCheck.status === "paused") return err("Resume the campaign before editing", 400);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.mode !== undefined) {
    if (!["off", "shadow", "active"].includes(body.mode)) return err("mode must be off|shadow|active");
    updates.mode = body.mode;
  }
  if (body.status !== undefined) {
    if (!["active", "paused", "archived"].includes(body.status)) return err("status must be active|paused|archived");
    updates.status = body.status;
  }
  if (body.icp_config !== undefined) updates.icp_config = body.icp_config;
  if (body.max_leads_per_day !== undefined) updates.max_leads_per_day = Number(body.max_leads_per_day) || 100;
  let thresholdChanged = false;
  let oldApt: number | undefined, oldRt: number | undefined;
  if (body.auto_push_threshold !== undefined || body.review_threshold !== undefined) {
    const { data: cur } = await adminSb
      .from("lge_campaigns").select("auto_push_threshold, review_threshold").eq("id", campaignId).maybeSingle();
    const apt = Number(body.auto_push_threshold ?? cur?.auto_push_threshold ?? 80);
    const rt  = Number(body.review_threshold    ?? cur?.review_threshold    ?? 60);
    if (apt <= rt || apt < 51 || apt > 100 || rt < 0 || rt > 99) {
      return err("auto_push_threshold must be 51–100 and strictly above review_threshold (0–99)");
    }
    oldApt = cur?.auto_push_threshold; oldRt = cur?.review_threshold;
    thresholdChanged = (apt !== oldApt || rt !== oldRt);
    updates.auto_push_threshold = apt;
    updates.review_threshold    = rt;
  }
  if (body.review_ttl_days !== undefined) {
    updates.review_ttl_days = Math.max(1, Math.min(90, Number(body.review_ttl_days) || 10));
  }
  if (body.outreach_template !== undefined) {
    updates.outreach_template = body.outreach_template
      ? String(body.outreach_template).slice(0, 2000)
      : null;
  }

  if (Object.keys(updates).length === 0) return err("No valid fields to update");

  const { data, error } = await adminSb
    .from("lge_campaigns")
    .update(updates)
    .eq("id", campaignId)
    .eq("org_id", orgId)
    .select(CAMPAIGN_COLS)
    .maybeSingle();

  if (error) return err(error.message, 500);
  if (!data) return err("Campaign not found", 404);

  // Write threshold history entry if thresholds changed (best-effort)
  if (thresholdChanged) {
    await adminSb.from("lge_threshold_history").insert({
      campaign_id:   campaignId,
      org_id:        orgId,
      changed_by:    userId,
      old_auto_push: oldApt ?? null,
      new_auto_push: Number(updates.auto_push_threshold),
      old_review:    oldRt ?? null,
      new_review:    Number(updates.review_threshold),
      reason: body.threshold_change_reason ? String(body.threshold_change_reason).slice(0, 500) : null,
    }).then(undefined, (e: any) => console.warn("[lge_campaign_manage] threshold history write failed:", e.message));
  }

  return ok({ campaign: data });
}

async function handleSetProviderKey(
  userSb: any,
  adminSb: any,
  orgId: string,
  userId: string,
  body: any,
) {
  const { provider, api_key } = body;

  if (!["apollo", "hunter", "abstract_phone"].includes(provider)) {
    return err("provider must be apollo|hunter|abstract_phone");
  }
  if (!api_key || typeof api_key !== "string" || api_key.trim().length < 8) {
    return err("api_key required (min 8 chars)");
  }

  const encrypted = await encryptKey(api_key.trim());

  const { error } = await adminSb
    .from("lge_provider_config")
    .upsert(
      {
        org_id: orgId,
        provider,
        api_key_encrypted: encrypted,
        is_active: true,
        updated_by: userId,
      },
      { onConflict: "org_id,provider" },
    );

  if (error) return err(error.message, 500);

  // Return confirmation only — never return the key
  return ok({ ok: true, provider, masked: `...${api_key.slice(-4)}` });
}

async function handleDeleteProviderKey(
  userSb: any,
  adminSb: any,
  orgId: string,
  userId: string,
  body: any,
) {
  const { provider } = body;
  if (!["apollo", "hunter", "abstract_phone"].includes(provider)) return err("provider must be apollo|hunter|abstract_phone");

  const { error } = await adminSb
    .from("lge_provider_config")
    .update({ is_active: false, updated_by: userId })
    .eq("org_id", orgId)
    .eq("provider", provider);

  if (error) return err(error.message, 500);
  return ok({ ok: true, provider, is_active: false });
}

async function handleGetProviderStatus(userSb: any, orgId: string) {
  const { data, error } = await userSb
    .from("lge_provider_config")
    .select("provider, is_active, updated_at")
    .eq("org_id", orgId);

  if (error) return err(error.message, 500);

  // Return metadata only — no key values
  const providers: Record<string, any> = { apollo: null, hunter: null, abstract_phone: null };
  for (const row of data ?? []) {
    providers[row.provider] = {
      configured: true,
      is_active: row.is_active,
      updated_at: row.updated_at,
    };
  }

  return ok({ providers });
}

async function handleTestProvider(adminSb: any, orgId: string, body: any) {
  const { provider } = body;
  if (!["apollo", "hunter", "abstract_phone"].includes(provider)) return err("provider must be apollo|hunter|abstract_phone");

  const { data: config } = await adminSb
    .from("lge_provider_config")
    .select("api_key_encrypted, is_active")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();

  if (!config?.api_key_encrypted) return err("No API key saved for this provider", 404);
  if (!config.is_active) return err("Provider key is disabled", 400);

  const apiKey = await decryptKey(config.api_key_encrypted);

  if (provider === "apollo") {
    const resp = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ api_key: apiKey, first_name: "test", last_name: "test", organization_name: "test" }),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 401 || resp.status === 403) return err("Apollo key invalid — check your API key in Apollo.io settings", 400);
    return ok({ ok: true, provider: "apollo" });
  }

  if (provider === "hunter") {
    const resp = await fetch(`https://api.hunter.io/v2/account?api_key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 401 || resp.status === 403) return err("Hunter key invalid — check your API key in Hunter.io settings", 400);
    const json = await resp.json().catch(() => ({}));
    return ok({ ok: true, provider: "hunter", account_email: json.data?.email ?? null });
  }

  if (provider === "abstract_phone") {
    // Test with a known-valid US number (Google HQ)
    const resp = await fetch(
      `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&phone=16502530000`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (resp.status === 401 || resp.status === 403) return err("AbstractAPI key invalid — check your API key at abstractapi.com/phone-validation-api", 400);
    if (!resp.ok) return err(`AbstractAPI returned ${resp.status}`, 400);
    const json = await resp.json().catch(() => ({}));
    return ok({ ok: true, provider: "abstract_phone", phone_type: json.type ?? null });
  }

  return err("Unknown provider");
}

async function handleDiscardLead(adminSb: any, orgId: string, body: any) {
  const { lead_id, lead_ids, note } = body;
  const noteVal = note ? String(note).slice(0, 500) : null;

  // Bulk discard (no note support in bulk — keep it simple)
  if (lead_ids && Array.isArray(lead_ids) && lead_ids.length > 0) {
    const { error } = await adminSb
      .from("lge_raw_leads")
      .update({ status: "discarded" })
      .in("id", lead_ids)
      .eq("org_id", orgId)
      .eq("status", "review_queue");
    if (error) return err(error.message, 500);
    return ok({ ok: true, discarded: lead_ids.length });
  }

  if (!lead_id) return err("lead_id or lead_ids required");

  const updates: Record<string, unknown> = { status: "discarded" };
  if (noteVal) updates.operator_note = noteVal;

  const { error } = await adminSb
    .from("lge_raw_leads")
    .update(updates)
    .eq("id", lead_id)
    .eq("org_id", orgId)
    .eq("status", "review_queue");

  if (error) return err(error.message, 500);
  return ok({ ok: true });
}

async function handleRetryLead(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  const { error } = await adminSb
    .from("lge_raw_leads")
    .update({ status: "pending", attempt: 0, locked_by: null, locked_until: null })
    .eq("id", lead_id)
    .eq("org_id", orgId)
    .eq("status", "failed");

  if (error) return err(error.message, 500);
  return ok({ ok: true });
}

async function handleForcePush(adminSb: any, orgId: string, body: any) {
  const { lead_id, note } = body;
  const noteVal = note ? String(note).slice(0, 500) : null;
  if (!lead_id) return err("lead_id required");

  const { data: lead } = await adminSb
    .from("lge_raw_leads")
    .select("*, lge_scores(total_score), lge_context(reason_to_reach_out, recommended_pitch_angle)")
    .eq("id", lead_id)
    .eq("org_id", orgId)
    .eq("status", "review_queue")
    .maybeSingle();

  if (!lead) return err("Lead not found or not in review queue", 404);

  const handoffKey = `lge:${lead_id}`;
  const { data: existing } = await adminSb
    .from("lge_raw_leads").select("id").eq("gsc_handoff_key", handoffKey).maybeSingle();
  if (existing) return err("Lead already pushed to GSC", 409);

  // Resolve actor user
  const { data: members } = await adminSb
    .from("org_members").select("user_id, role").eq("org_id", orgId);

  let actorUserId: string | null = null;
  for (const role of ["enterprise_admin", "agency_admin", "owner"]) {
    const m = members?.find((m: any) => m.role === role);
    if (m) { actorUserId = m.user_id; break; }
  }
  if (!actorUserId && members?.length) {
    actorUserId = members.find((m: any) => !m.role)?.user_id ?? members[0].user_id;
  }
  if (!actorUserId) return err("Could not resolve org owner", 500);

  const score = lead.lge_scores?.total_score ?? lead.lge_scores?.[0]?.total_score ?? 0;
  const reason = lead.lge_context?.reason_to_reach_out ?? lead.lge_context?.[0]?.reason_to_reach_out ?? "";
  const pitch  = lead.lge_context?.recommended_pitch_angle ?? lead.lge_context?.[0]?.recommended_pitch_angle ?? "";
  const notes  = JSON.stringify({ lge: true, score, reason, pitch, company: lead.company || null });

  const { data: gscLead, error: leadErr } = await adminSb
    .from("leads")
    .insert({
      profile_id: actorUserId,
      org_id: orgId,
      assigned_to: actorUserId,
      name: lead.name || "Unknown",
      email: lead.email || null,
      phone: lead.phone || null,
      source: "lge",
      notes,
      status: "new",
    })
    .select("id")
    .single();

  if (leadErr) return err(leadErr.message, 500);

  const { data: plan, error: planErr } = await adminSb
    .from("decision_plans")
    .insert({ org_id: orgId, lead_id: gscLead.id, plan: {}, trigger: "webhook_inbound" })
    .select("id")
    .single();

  if (planErr) return err(planErr.message, 500);

  await adminSb.from("execution_tasks").insert({
    org_id: orgId,
    plan_id: plan.id,
    lead_id: gscLead.id,
    channel: "sms",
    status: "pending",
    scheduled_for: new Date().toISOString(),
    attempt: 0,
    max_attempts: 3,
    metadata: { lge_lead_id: lead_id, lge_score: score },
  });

  const pushUpdate: Record<string, unknown> = { status: "pushed", gsc_lead_id: gscLead.id, gsc_handoff_key: handoffKey };
  if (noteVal) pushUpdate.operator_note = noteVal;
  await adminSb.from("lge_raw_leads").update(pushUpdate).eq("id", lead_id);

  return ok({ ok: true, gsc_lead_id: gscLead.id });
}

async function handleGetProviderTrace(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  const { data: lead } = await adminSb
    .from("lge_raw_leads").select("id").eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);

  const { data, error } = await adminSb
    .from("lge_provider_calls")
    .select("provider, status, called_at")
    .eq("raw_lead_id", lead_id)
    .order("called_at", { ascending: true });

  if (error) return err(error.message, 500);
  return ok({ calls: data ?? [] });
}

async function handleReprocessLead(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  const { data: lead } = await adminSb
    .from("lge_raw_leads").select("id, status").eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);
  if (lead.status === "pending" || lead.status === "enriching") {
    return err("Lead is already being processed");
  }

  // Clear downstream data so worker starts fresh
  await adminSb.from("lge_context").delete().eq("raw_lead_id", lead_id);
  await adminSb.from("lge_scores").delete().eq("raw_lead_id", lead_id);
  await adminSb.from("lge_enrichment").delete().eq("raw_lead_id", lead_id);

  const { error } = await adminSb
    .from("lge_raw_leads")
    .update({ status: "pending", attempt: 0, locked_by: null, locked_until: null, operator_note: null })
    .eq("id", lead_id).eq("org_id", orgId);

  if (error) return err(error.message, 500);
  return ok({ ok: true });
}

async function handleBulkReprocess(adminSb: any, orgId: string, body: any) {
  const { campaign_id } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: camp } = await adminSb
    .from("lge_campaigns").select("id").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  // Fetch all non-pushed, non-currently-enriching leads
  const { data: leads } = await adminSb
    .from("lge_raw_leads")
    .select("id")
    .eq("campaign_id", campaign_id)
    .eq("org_id", orgId)
    .not("status", "in", '("pushed","enriching")');

  if (!leads?.length) return ok({ ok: true, requeued: 0 });
  const ids = leads.map((l: any) => l.id);

  // Clear all downstream data in parallel
  await Promise.all([
    adminSb.from("lge_context").delete().in("raw_lead_id", ids),
    adminSb.from("lge_scores").delete().in("raw_lead_id", ids),
    adminSb.from("lge_enrichment").delete().in("raw_lead_id", ids),
    adminSb.from("lge_provider_calls").delete().in("raw_lead_id", ids),
  ]);

  // Reset leads to pending so the worker re-runs the full pipeline
  const { error } = await adminSb
    .from("lge_raw_leads")
    .update({ status: "pending", attempt: 0, locked_by: null, locked_until: null, operator_note: null })
    .in("id", ids)
    .eq("org_id", orgId);

  if (error) return err(error.message, 500);
  return ok({ ok: true, requeued: ids.length });
}

async function handleSendReport(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id } = body; // optional — null/undefined = all campaigns

  // Resolve org owner email via auth admin API
  const { data: { user }, error: userErr } = await (adminSb as any).auth.admin.getUserById(userId);
  if (userErr || !user?.email) return err("Could not resolve your email address", 500);
  const recipientEmail: string = user.email;

  // Fetch campaigns
  let campQuery = adminSb
    .from("lge_campaigns")
    .select("id, name, mode, auto_push_threshold, review_threshold")
    .eq("org_id", orgId)
    .neq("status", "archived")
    .order("created_at", { ascending: false });
  if (campaign_id) campQuery = campQuery.eq("id", campaign_id);
  const { data: camps } = await campQuery;
  if (!camps?.length) return err("No campaigns found", 404);

  const campIds = camps.map((c: any) => c.id);

  // Fetch lead status counts
  const { data: rawLeads } = await adminSb
    .from("lge_raw_leads")
    .select("campaign_id, status")
    .eq("org_id", orgId)
    .in("campaign_id", campIds);

  // Fetch outcomes (only for pushed leads in these campaigns)
  const { data: pushedLeads } = await adminSb
    .from("lge_raw_leads")
    .select("id, campaign_id")
    .eq("org_id", orgId)
    .eq("status", "pushed")
    .in("campaign_id", campIds);
  const pushedIds = (pushedLeads ?? []).map((l: any) => l.id);
  const pushedByCamp = new Map<string, Set<string>>();
  for (const l of pushedLeads ?? []) {
    if (!pushedByCamp.has(l.campaign_id)) pushedByCamp.set(l.campaign_id, new Set());
    pushedByCamp.get(l.campaign_id)!.add(l.id);
  }

  let outcomes: any[] = [];
  if (pushedIds.length > 0) {
    const { data } = await adminSb
      .from("lge_outcomes")
      .select("raw_lead_id, outcome")
      .in("raw_lead_id", pushedIds);
    outcomes = data ?? [];
  }

  const outcomesByCamp = new Map<string, { replied: number; booked: number; closed: number }>();
  for (const o of outcomes) {
    const campId = [...pushedByCamp.entries()].find(([, ids]) => ids.has(o.raw_lead_id))?.[0];
    if (!campId) continue;
    if (!outcomesByCamp.has(campId)) outcomesByCamp.set(campId, { replied: 0, booked: 0, closed: 0 });
    const cur = outcomesByCamp.get(campId)!;
    if (o.outcome === "replied") cur.replied++;
    else if (o.outcome === "booked") cur.booked++;
    else if (o.outcome === "closed") cur.closed++;
  }

  // Aggregate per campaign
  type CampRow = { total: number; pending: number; review: number; pushed: number; discarded: number; failed: number; replied: number; booked: number; closed: number };
  const statsMap = new Map<string, CampRow>();
  for (const id of campIds) {
    statsMap.set(id, { total: 0, pending: 0, review: 0, pushed: 0, discarded: 0, failed: 0, replied: 0, booked: 0, closed: 0 });
  }
  for (const lead of rawLeads ?? []) {
    const s = statsMap.get(lead.campaign_id);
    if (!s) continue;
    s.total++;
    if (lead.status === "pending" || lead.status === "enriching" || lead.status === "scored") s.pending++;
    else if (lead.status === "review_queue") s.review++;
    else if (lead.status === "pushed") s.pushed++;
    else if (lead.status === "discarded") s.discarded++;
    else if (lead.status === "failed") s.failed++;
  }
  for (const [cid, oc] of outcomesByCamp) {
    const s = statsMap.get(cid);
    if (s) { s.replied += oc.replied; s.booked += oc.booked; s.closed += oc.closed; }
  }

  // Build HTML email
  const dateStr = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const tableRows = camps.map((c: any) => {
    const s = statsMap.get(c.id)!;
    const pushRate = s.total > 0 ? ((s.pushed / s.total) * 100).toFixed(0) : "0";
    return `<tr style="border-bottom:1px solid #1e293b">
      <td style="padding:10px 12px;color:#e2e8f0;font-weight:500">${c.name}</td>
      <td style="padding:10px 12px;text-align:right;color:#94a3b8">${s.total}</td>
      <td style="padding:10px 12px;text-align:right;color:#34d399">${s.pushed} <span style="color:#475569;font-size:11px">(${pushRate}%)</span></td>
      <td style="padding:10px 12px;text-align:right;color:#fbbf24">${s.review}</td>
      <td style="padding:10px 12px;text-align:right;color:#64748b">${s.discarded}</td>
      <td style="padding:10px 12px;text-align:right;color:#60a5fa">${s.replied}</td>
      <td style="padding:10px 12px;text-align:right;color:#a78bfa">${s.booked}</td>
      <td style="padding:10px 12px;text-align:right;color:#f59e0b">${s.closed}</td>
    </tr>`;
  }).join("");

  const totals = [...statsMap.values()].reduce((acc, s) => {
    acc.total += s.total; acc.pushed += s.pushed; acc.review += s.review;
    acc.discarded += s.discarded; acc.replied += s.replied; acc.booked += s.booked; acc.closed += s.closed;
    return acc;
  }, { total: 0, pushed: 0, review: 0, discarded: 0, replied: 0, booked: 0, closed: 0 });

  const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0f172a;font-family:Inter,sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:32px 16px">
    <div style="background:#1e293b;border-radius:12px;overflow:hidden">
      <div style="padding:24px 28px;border-bottom:1px solid #334155">
        <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;font-weight:600">GetSalesCloser · Lead Generation Engine</p>
        <h1 style="margin:0;font-size:20px;color:#f1f5f9;font-weight:700">Campaign Performance Report</h1>
        <p style="margin:6px 0 0;font-size:12px;color:#64748b">${dateStr}</p>
      </div>
      <div style="padding:24px 28px">
        <!-- Totals -->
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px">
          ${[["Total Leads",totals.total,"#94a3b8"],["Pushed to GSC",totals.pushed,"#34d399"],["In Review",totals.review,"#fbbf24"],["Replied",totals.replied,"#60a5fa"],["Booked",totals.booked,"#a78bfa"],["Closed",totals.closed,"#f59e0b"]].map(([k,v,c]) =>
            `<div style="flex:1;min-width:80px;background:#0f172a;border-radius:8px;padding:12px;text-align:center"><p style="margin:0 0 4px;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">${k}</p><p style="margin:0;font-size:22px;font-weight:700;color:${c}">${v}</p></div>`
          ).join("")}
        </div>
        <!-- Table -->
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="border-bottom:2px solid #334155">
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:600">Campaign</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Total</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Pushed</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Review</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Discarded</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Replied</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Booked</th>
            <th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:600">Closed</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="padding:16px 28px;border-top:1px solid #1e293b;text-align:center">
        <p style="margin:0;font-size:11px;color:#475569">Sent from <a href="https://www.getsalescloser.com" style="color:#6366f1;text-decoration:none">GetSalesCloser</a> · Lead Generation Engine</p>
      </div>
    </div>
  </div></body></html>`;

  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return err("RESEND_API_KEY not configured", 500);

  const mailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "support@getsalescloser.com",
      to: [recipientEmail],
      subject: `LGE Campaign Report — ${dateStr}`,
      html: emailHtml,
    }),
  });
  if (!mailRes.ok) {
    const errBody = await mailRes.text().catch(() => "");
    return err(`Email send failed: ${errBody}`, 500);
  }

  return ok({ ok: true, sent_to: recipientEmail });
}

// ── Phase 10 handlers ─────────────────────────────────────────────────────────

// Outcome ladder — forward-only for operators; admin can do full revert
const OUTCOME_LADDER: Record<string, number> = {
  no_reply: 0,
  replied:  1,
  booked:   2,
  closed:   4,
};
const VALID_MANUAL_OUTCOMES = Object.keys(OUTCOME_LADDER);

// Permission resolver: returns "admin" | "operator" | "viewer"
// admin   = agency_admin, enterprise_admin, or sole-owner (null role in solo org)
// operator = enterprise_agent
// viewer  = everyone else (read-only; cannot mark outcomes / reenrich)
async function resolveUserLgeRole(adminSb: any, orgId: string, userId: string): Promise<"admin" | "operator" | "viewer"> {
  const { data: rows } = await adminSb
    .from("org_members")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .limit(1);
  const role = rows?.[0]?.role ?? null;
  if (role === null || role === "agency_admin" || role === "enterprise_admin" || role === "owner") return "admin";
  if (role === "enterprise_agent") return "operator";
  return "viewer";
}

async function handleMarkOutcome(adminSb: any, orgId: string, userId: string, body: any) {
  const { lead_id, outcome, reason } = body;
  if (!lead_id) return err("lead_id required");
  if (!outcome || !VALID_MANUAL_OUTCOMES.includes(outcome)) {
    return err(`outcome must be one of: ${VALID_MANUAL_OUTCOMES.join(", ")}`);
  }
  const reasonStr = reason ? String(reason).trim() : "";
  if (reasonStr.length < 5) return err("reason is required (min 5 characters)");

  // Check role — minimum operator
  const lgeRole = await resolveUserLgeRole(adminSb, orgId, userId);
  if (lgeRole === "viewer") return err("Permission denied — operator role required to mark outcomes", 403);

  // Lead must be pushed
  const { data: lead } = await adminSb
    .from("lge_raw_leads")
    .select("id, status, org_id")
    .eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);
  if (lead.status !== "pushed") return err("Outcomes can only be marked for pushed leads", 400);

  // Fetch current outcome (for ladder check)
  const { data: existing } = await adminSb
    .from("lge_outcomes")
    .select("outcome_stage, is_manual, source_priority")
    .eq("raw_lead_id", lead_id).maybeSingle();

  const newRank     = OUTCOME_LADDER[outcome] ?? 0;
  const currentRank = existing ? (OUTCOME_LADDER[existing.outcome_stage] ?? 0) : -1;

  // Enforce forward-only ladder for operators; admins can move freely
  if (lgeRole !== "admin" && existing && newRank < currentRank) {
    return err(`Backward outcome transition not allowed: ${existing.outcome_stage} → ${outcome}. Contact an admin to revert.`, 400);
  }

  const now = new Date().toISOString();
  const { error: upsertErr } = await adminSb
    .from("lge_outcomes")
    .upsert({
      raw_lead_id:    lead_id,
      outcome_stage:  outcome,
      outcome_source: "manual",
      observed_at:    now,
      is_manual:      true,
      manual_reason:  reasonStr.slice(0, 500),
      manual_by:      userId,
      manual_at:      now,
      source_priority: 10, // manual overrides sync (sync only overwrites if higher rank)
    }, { onConflict: "raw_lead_id" });

  if (upsertErr) return err(upsertErr.message, 500);

  // Audit log
  await adminSb.from("lge_decision_logs").insert({
    raw_lead_id: lead_id, org_id: orgId,
    score_outputs_json: { manual_outcome: outcome, previous_outcome: existing?.outcome_stage ?? null, reason: reasonStr },
    routing_reason: `manual_outcome: ${existing?.outcome_stage ?? "none"} → ${outcome}`,
  }).then(undefined, () => {});

  return ok({ ok: true, lead_id, outcome_stage: outcome, is_manual: true });
}

async function handleReenrichLead(adminSb: any, orgId: string, userId: string, body: any) {
  const { lead_id, reason } = body;
  if (!lead_id) return err("lead_id required");
  const reasonStr = reason ? String(reason).trim() : "";
  if (reasonStr.length < 5) return err("reason is required (min 5 characters)");

  // Check role
  const lgeRole = await resolveUserLgeRole(adminSb, orgId, userId);
  if (lgeRole === "viewer") return err("Permission denied — operator role required to re-enrich leads", 403);

  const { data: lead } = await adminSb
    .from("lge_raw_leads")
    .select("id, status, org_id, processing_version, last_reenrich_at")
    .eq("id", lead_id).eq("org_id", orgId).maybeSingle();

  if (!lead) return err("Lead not found", 404);

  // Only allow safe statuses
  const ALLOWED_STATUSES = ["review_queue", "discarded", "failed"];
  if (!ALLOWED_STATUSES.includes(lead.status)) {
    return err(`Re-enrich only allowed for: ${ALLOWED_STATUSES.join(", ")}. Current: ${lead.status}`, 400);
  }

  // Cooldown: 5 minutes between re-enrich attempts per lead (admin can bypass)
  if (lgeRole !== "admin" && lead.last_reenrich_at) {
    const msSince = Date.now() - new Date(lead.last_reenrich_at).getTime();
    if (msSince < 5 * 60 * 1000) {
      const secsLeft = Math.ceil((5 * 60 * 1000 - msSince) / 1000);
      return err(`Cooldown active — please wait ${secsLeft}s before re-enriching this lead`, 429);
    }
  }

  const now = new Date().toISOString();
  const newVersion = (lead.processing_version ?? 1) + 1;

  // Non-destructive: increment version, reset to pending — old enrichment/scores/context remain in DB
  const { error: updateErr } = await adminSb
    .from("lge_raw_leads")
    .update({
      status:             "pending",
      attempt:            0,
      locked_by:          null,
      locked_until:       null,
      processing_version: newVersion,
      last_reenrich_at:   now,
      reenrich_reason:    reasonStr.slice(0, 500),
    })
    .eq("id", lead_id).eq("org_id", orgId);

  if (updateErr) return err(updateErr.message, 500);

  // Audit log
  await adminSb.from("lge_decision_logs").insert({
    raw_lead_id: lead_id, org_id: orgId,
    score_outputs_json: { reenrich_version: newVersion, reason: reasonStr, initiated_by: userId },
    routing_reason: `reenrich: version ${newVersion}`,
  }).then(undefined, () => {});

  return ok({ ok: true, lead_id, processing_version: newVersion, status: "pending" });
}

async function handleGetCampaignAudit(adminSb: any, orgId: string, body: any) {
  const { campaign_id, filter = "all", limit: lim = 50, offset: off = 0 } = body;
  if (!campaign_id) return err("campaign_id required");

  // Verify ownership
  const { data: camp } = await adminSb.from("lge_campaigns").select("id, name").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  const events: Array<{
    id: string; timestamp: string; actor: string | null; event_type: string;
    before: string | null; after: string | null; reason: string | null; source: string;
  }> = [];

  // Fetch threshold changes
  if (filter === "all" || filter === "threshold") {
    const { data: thRows } = await adminSb
      .from("lge_threshold_history")
      .select("id, old_auto_push, new_auto_push, old_review, new_review, reason, created_at, changed_by")
      .eq("campaign_id", campaign_id)
      .order("created_at", { ascending: false })
      .limit(100);

    for (const row of thRows ?? []) {
      const beforeParts = [];
      const afterParts  = [];
      if (row.old_auto_push !== null) beforeParts.push(`Auto-push: ${row.old_auto_push}`);
      if (row.new_auto_push !== null) afterParts.push(`Auto-push: ${row.new_auto_push}`);
      if (row.old_review !== null) beforeParts.push(`Review: ${row.old_review}`);
      if (row.new_review !== null) afterParts.push(`Review: ${row.new_review}`);
      events.push({
        id: row.id, timestamp: row.created_at, actor: row.changed_by,
        event_type: "threshold_change",
        before: beforeParts.join(", ") || null,
        after:  afterParts.join(", ")  || null,
        reason: row.reason, source: "lge_threshold_history",
      });
    }
  }

  // Fetch campaign lifecycle changes
  if (filter === "all" || filter === "lifecycle") {
    const { data: lcRows } = await adminSb
      .from("lge_campaign_state_logs")
      .select("id, action, performed_by, note, created_at")
      .eq("campaign_id", campaign_id)
      .order("created_at", { ascending: false })
      .limit(100);

    for (const row of lcRows ?? []) {
      const actionLabels: Record<string, string> = { pause: "Campaign paused", resume: "Campaign resumed", archive: "Campaign archived" };
      events.push({
        id: row.id, timestamp: row.created_at, actor: row.performed_by,
        event_type: "lifecycle_change",
        before: null,
        after: actionLabels[row.action] ?? row.action,
        reason: row.note, source: "lge_campaign_state_logs",
      });
    }
  }

  // Sort by timestamp desc
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Resolve actor names
  const actorIds = [...new Set(events.map((e) => e.actor).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  if (actorIds.length) {
    const { data: profiles } = await adminSb.from("profiles").select("id, full_name, email").in("id", actorIds);
    for (const p of profiles ?? []) nameMap[p.id] = p.full_name || p.email || "Unknown";
  }

  const result = events.slice(off, off + lim).map((e) => ({
    ...e,
    actor_name: e.actor ? (nameMap[e.actor] ?? e.actor) : "System",
  }));

  return ok({ events: result, total: events.length, campaign_id, campaign_name: camp.name });
}

async function handleGetLeadTimeline(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  const { data: lead } = await adminSb
    .from("lge_raw_leads")
    .select("id, org_id, campaign_id, created_at, status, gsc_lead_id, processing_version")
    .eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);

  const timeline: Array<{
    timestamp: string; event: string; detail: string | null; source: string;
  }> = [];

  // Ingested
  timeline.push({ timestamp: lead.created_at, event: "ingested", detail: null, source: "lge_raw_leads" });

  // Enrichment
  const { data: enr } = await adminSb
    .from("lge_enrichment").select("enriched_at, industry, company_size, email_verified").eq("raw_lead_id", lead_id).maybeSingle();
  if (enr?.enriched_at) {
    const parts = [];
    if (enr.industry)      parts.push(`industry: ${enr.industry}`);
    if (enr.company_size)  parts.push(`size: ${enr.company_size}`);
    if (enr.email_verified !== null) parts.push(`email_verified: ${enr.email_verified}`);
    timeline.push({ timestamp: enr.enriched_at, event: "enriched", detail: parts.join(", ") || null, source: "lge_enrichment" });
  }

  // Scored
  const { data: sc } = await adminSb
    .from("lge_scores").select("scored_at, total_score, is_manual_override, override_at").eq("raw_lead_id", lead_id).maybeSingle();
  if (sc?.scored_at) {
    timeline.push({ timestamp: sc.scored_at, event: "scored", detail: `total: ${sc.total_score}`, source: "lge_scores" });
  }
  if (sc?.is_manual_override && sc?.override_at) {
    timeline.push({ timestamp: sc.override_at, event: "score_overridden", detail: `manual score: ${sc.total_score}`, source: "lge_scores" });
  }

  // Decision logs (routing, re-enrich, manual outcome, override)
  const { data: dlogs } = await adminSb
    .from("lge_decision_logs")
    .select("id, routing_reason, created_at, score_outputs_json")
    .eq("raw_lead_id", lead_id)
    .order("created_at", { ascending: true });

  for (const d of dlogs ?? []) {
    const reason: string = d.routing_reason ?? "";
    if (reason.startsWith("reenrich:")) {
      timeline.push({ timestamp: d.created_at, event: "re_enriched", detail: reason.replace("reenrich:", "").trim(), source: "lge_decision_logs" });
    } else if (reason.startsWith("manual_outcome:")) {
      timeline.push({ timestamp: d.created_at, event: "outcome_marked", detail: reason.replace("manual_outcome:", "").trim(), source: "lge_decision_logs" });
    } else if (reason.startsWith("operator_override:")) {
      // Already captured from lge_scores; skip duplicate
    } else if (reason.startsWith("operator_override_reverted:")) {
      timeline.push({ timestamp: d.created_at, event: "override_reverted", detail: reason.replace("operator_override_reverted:", "").trim(), source: "lge_decision_logs" });
    } else if (reason.includes("auto_push") || reason.includes("routed")) {
      timeline.push({ timestamp: d.created_at, event: "routed", detail: reason, source: "lge_decision_logs" });
    }
  }

  // Provider calls
  const { data: calls } = await adminSb
    .from("lge_provider_calls")
    .select("provider, status, called_at")
    .eq("raw_lead_id", lead_id)
    .order("called_at", { ascending: true });
  for (const c of calls ?? []) {
    timeline.push({ timestamp: c.called_at, event: `provider_called`, detail: `${c.provider}: ${c.status}`, source: "lge_provider_calls" });
  }

  // Pushed
  if (lead.status === "pushed" && lead.gsc_lead_id) {
    // Get push timestamp from GSC leads table
    const { data: gscLead } = await adminSb.from("leads").select("created_at").eq("id", lead.gsc_lead_id).maybeSingle();
    if (gscLead?.created_at) {
      timeline.push({ timestamp: gscLead.created_at, event: "pushed", detail: `GSC lead: ${lead.gsc_lead_id}`, source: "lge_raw_leads" });
    }
  }

  // Outcome
  const { data: outcome } = await adminSb
    .from("lge_outcomes")
    .select("outcome_stage, outcome_source, observed_at, is_manual, manual_reason, manual_at")
    .eq("raw_lead_id", lead_id).maybeSingle();
  if (outcome?.observed_at) {
    const who = outcome.is_manual ? "manual" : "sync";
    const detail = outcome.is_manual
      ? `${outcome.outcome_stage} (manual${outcome.manual_reason ? `: ${outcome.manual_reason}` : ""})`
      : outcome.outcome_stage;
    timeline.push({ timestamp: outcome.manual_at ?? outcome.observed_at, event: "outcome_updated", detail, source: "lge_outcomes" });
  }

  // Sort by timestamp ascending
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return ok({ timeline, lead_id, processing_version: lead.processing_version ?? 1 });
}

// ── Phase 9 handlers ──────────────────────────────────────────────────────────

const OVERRIDE_MAX_DELTA = 30; // max ±points an operator can shift a score

async function handleOverrideScore(adminSb: any, orgId: string, userId: string, body: any) {
  const { lead_id, score, reason } = body;
  if (!lead_id) return err("lead_id required");
  if (score === undefined || score === null) return err("score required");
  const newScore = Math.max(0, Math.min(100, Math.round(Number(score))));
  if (isNaN(newScore)) return err("score must be a number 0–100");
  if (!reason || !String(reason).trim()) return err("reason is required for score override");

  // Only allow for review_queue or discarded leads
  const { data: lead } = await adminSb
    .from("lge_raw_leads")
    .select("id, status, campaign_id, name, email, phone, company")
    .eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);
  if (!["review_queue", "discarded"].includes(lead.status)) {
    return err(`Cannot override score for lead in status: ${lead.status}. Only review_queue and discarded leads can be overridden.`, 400);
  }

  // Fetch campaign thresholds
  const { data: camp } = await adminSb
    .from("lge_campaigns")
    .select("auto_push_threshold, review_threshold, mode, outreach_template, status")
    .eq("id", lead.campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);
  if (camp.status === "archived") return err("Cannot override score in archived campaign", 400);

  // Fetch current system score (for delta check + snapshot)
  const { data: existing } = await adminSb
    .from("lge_scores")
    .select("fit_score, confidence_score, total_score, is_manual_override, system_total_score")
    .eq("raw_lead_id", lead_id).maybeSingle();

  // Delta ceiling check: compare against the authoritative system score
  const systemTotal = existing?.system_total_score ?? existing?.total_score ?? null;
  if (systemTotal !== null) {
    const delta = Math.abs(newScore - systemTotal);
    if (delta > OVERRIDE_MAX_DELTA) {
      return err(`Override exceeds maximum allowed change of ±${OVERRIDE_MAX_DELTA} points (system score: ${systemTotal}, proposed: ${newScore}, delta: ${delta}).`, 400);
    }
  }

  // Determine new routing
  const newStatus = camp.mode === "shadow" ? "scored"
    : newScore >= camp.auto_push_threshold ? "pushed"
    : newScore >= camp.review_threshold ? "review_queue"
    : "discarded";

  // Resolve actor for GSC push
  let actorUserId: string | null = null;
  if (newStatus === "pushed") {
    const { data: namedMember } = await adminSb.from("org_members").select("user_id")
      .eq("org_id", orgId).in("role", ["enterprise_admin","agency_admin","owner"]).limit(1).maybeSingle();
    if (namedMember) actorUserId = namedMember.user_id;
    else {
      const { data: nullMember } = await adminSb.from("org_members").select("user_id").eq("org_id", orgId).is("role", null).limit(1).maybeSingle();
      actorUserId = nullMember?.user_id ?? null;
    }
  }

  // Upsert score with override metadata
  const scoreUpsert: any = {
    raw_lead_id: lead_id,
    total_score: newScore,
    is_manual_override: true,
    override_reason: String(reason).trim().slice(0, 500),
    override_by: userId,
    override_at: new Date().toISOString(),
  };
  // Snapshot the system score on first override (preserve original for revert)
  if (!existing?.is_manual_override) {
    scoreUpsert.system_fit_score = existing?.fit_score ?? null;
    scoreUpsert.system_confidence_score = existing?.confidence_score ?? null;
    scoreUpsert.system_total_score = existing?.total_score ?? null;
  }
  await adminSb.from("lge_scores").upsert(scoreUpsert, { onConflict: "raw_lead_id" });

  // Log to decision log
  await adminSb.from("lge_decision_logs").insert({
    raw_lead_id: lead_id, org_id: orgId, campaign_id: lead.campaign_id,
    score_outputs_json: { total_score: newScore, is_manual_override: true, override_reason: reason, override_by: userId },
    routing_reason: `operator_override: score set to ${newScore}`,
  }).catch(() => {});

  // If routing to pushed — push to GSC
  let gscLeadId: string | null = null;
  if (newStatus === "pushed" && actorUserId) {
    const handoffKey = `lge:${lead_id}`;
    const { data: existingRaw } = await adminSb.from("lge_raw_leads").select("gsc_handoff_key").eq("id", lead_id).maybeSingle();
    if (!existingRaw?.gsc_handoff_key) {
      let skipPhone = false;
      if (lead.phone) {
        const { data: dup } = await adminSb.from("leads").select("id").eq("org_id", orgId).eq("phone", lead.phone).maybeSingle();
        if (dup) skipPhone = true;
      }
      if (!skipPhone) {
        const notes = JSON.stringify({ source: "lge", lge_lead_id: lead_id, score: newScore, override: true, override_reason: reason });
        const { data: gscLead } = await adminSb.from("leads").insert({
          org_id: orgId, profile_id: actorUserId, name: lead.name, phone: lead.phone ?? null, email: lead.email ?? null, notes, status: "new", source: "lge",
        }).select("id").single().catch(() => ({ data: null }));
        if (gscLead?.id) {
          gscLeadId = gscLead.id;
          const { data: plan } = await adminSb.from("decision_plans").insert({
            lead_id: gscLead.id, org_id, trigger: "webhook_inbound", plan: { source: "lge", source_event: "operator_override" },
          }).select("id").single().catch(() => ({ data: null }));
          if (plan?.id) {
            await adminSb.from("execution_tasks").insert({
              plan_id: plan.id, lead_id: gscLead.id, org_id, channel: "sms", max_attempts: 3,
              scheduled_for: new Date().toISOString(), status: "pending", actor_user_id: actorUserId,
              metadata: { source: "lge", lge_lead_id: lead_id, lge_score: newScore, is_manual_override: true, ...(camp.outreach_template ? { force_content: camp.outreach_template } : {}) },
            }).catch(() => {});
          }
          await adminSb.from("lge_raw_leads").update({ gsc_lead_id: gscLead.id, gsc_handoff_key: handoffKey }).eq("id", lead_id);
        }
      }
    }
  }

  // Update lead status
  await adminSb.from("lge_raw_leads").update({ status: newStatus }).eq("id", lead_id);

  return ok({ ok: true, lead_id, new_score: newScore, new_status: newStatus, gsc_lead_id: gscLeadId });
}

async function handleRevertScore(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  const { data: lead } = await adminSb
    .from("lge_raw_leads").select("id, status, campaign_id").eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);
  if (!["review_queue", "discarded", "pushed"].includes(lead.status)) {
    return err("Can only revert override for review_queue, discarded, or pushed leads", 400);
  }

  const { data: score } = await adminSb
    .from("lge_scores").select("*").eq("raw_lead_id", lead_id).maybeSingle();
  if (!score?.is_manual_override) return err("This lead has no manual override to revert", 400);
  if (score.system_total_score === null) return err("System score snapshot not available — cannot revert", 400);

  const { data: camp } = await adminSb
    .from("lge_campaigns").select("auto_push_threshold, review_threshold, mode").eq("id", lead.campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  // Restore system score, clear override flags
  await adminSb.from("lge_scores").update({
    fit_score: score.system_fit_score,
    confidence_score: score.system_confidence_score,
    total_score: score.system_total_score,
    is_manual_override: false,
    override_reason: null,
    override_by: null,
    override_at: null,
    system_fit_score: null,
    system_confidence_score: null,
    system_total_score: null,
  }).eq("raw_lead_id", lead_id);

  // Re-route based on system score
  const routing = camp.mode === "shadow" ? "scored" : (() => {
    if (score.system_total_score >= camp.auto_push_threshold) return "pushed";
    if (score.system_total_score >= camp.review_threshold) return "review_queue";
    return "discarded";
  })();

  // Only update status if not already pushed (don't undo a push)
  if (lead.status !== "pushed") {
    await adminSb.from("lge_raw_leads").update({ status: routing }).eq("id", lead_id);
  }

  await adminSb.from("lge_decision_logs").insert({
    raw_lead_id: lead_id, org_id, campaign_id: lead.campaign_id,
    score_outputs_json: { total_score: score.system_total_score, reverted: true },
    routing_reason: `operator_override_reverted: system score ${score.system_total_score} restored`,
  }).catch(() => {});

  return ok({ ok: true, lead_id, reverted_to_score: score.system_total_score, status: lead.status !== "pushed" ? routing : lead.status });
}

async function handlePauseCampaign(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id, note } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: camp } = await adminSb
    .from("lge_campaigns").select("id, status, mode").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);
  if (camp.status === "archived") return err("Archived campaigns cannot be paused", 400);
  if (camp.status === "paused") return err("Campaign is already paused", 400);

  await adminSb.from("lge_campaigns").update({
    status: "paused",
    mode: "off",
    pre_pause_mode: camp.mode,
  }).eq("id", campaign_id);

  await adminSb.from("lge_campaign_state_logs").insert({
    campaign_id, org_id: orgId, action: "pause", performed_by: userId,
    note: note ? String(note).trim().slice(0, 500) : null,
  });

  return ok({ ok: true, campaign_id, status: "paused" });
}

async function handleResumeCampaign(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id, note } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: camp } = await adminSb
    .from("lge_campaigns").select("id, status, pre_pause_mode").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);
  if (camp.status !== "paused") return err("Campaign is not paused", 400);

  const restoreMode = camp.pre_pause_mode ?? "off";
  await adminSb.from("lge_campaigns").update({
    status: "active",
    mode: restoreMode,
    pre_pause_mode: null,
  }).eq("id", campaign_id);

  await adminSb.from("lge_campaign_state_logs").insert({
    campaign_id, org_id: orgId, action: "resume", performed_by: userId,
    note: note ? String(note).trim().slice(0, 500) : null,
  });

  return ok({ ok: true, campaign_id, status: "active", mode: restoreMode });
}

async function handleArchiveCampaign(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id, note } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: camp } = await adminSb
    .from("lge_campaigns").select("id, status, mode").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);
  if (camp.status === "archived") return err("Campaign is already archived", 400);
  if (camp.status !== "paused") return err("Campaign must be paused before archiving", 400);

  await adminSb.from("lge_campaigns").update({
    status: "archived",
    mode: "off",
    pre_pause_mode: null,
  }).eq("id", campaign_id);

  await adminSb.from("lge_campaign_state_logs").insert({
    campaign_id, org_id: orgId, action: "archive", performed_by: userId,
    note: note ? String(note).trim().slice(0, 500) : null,
  });

  return ok({ ok: true, campaign_id, status: "archived" });
}

// ── Phase 8 handlers ──────────────────────────────────────────────────────────

async function handleListImports(adminSb: any, orgId: string, body: any) {
  const { campaign_id, limit: lim = 50, offset: off = 0 } = body;

  let q = adminSb
    .from("lge_import_batches")
    .select("id, campaign_id, source, total, accepted, duplicates, invalid, imported_by, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range(off, off + lim - 1);

  if (campaign_id) q = q.eq("campaign_id", campaign_id);

  const { data, error, count } = await q;
  if (error) return err(error.message, 500);

  // Attach campaign names
  const campIds = [...new Set((data ?? []).map((r: any) => r.campaign_id))];
  let campNames: Record<string, string> = {};
  if (campIds.length) {
    const { data: camps } = await adminSb.from("lge_campaigns").select("id, name").in("id", campIds);
    for (const c of camps ?? []) campNames[c.id] = c.name;
  }

  const rows = (data ?? []).map((r: any) => ({ ...r, campaign_name: campNames[r.campaign_id] ?? null }));
  return ok({ imports: rows, total: count ?? rows.length });
}

async function handleListNotes(adminSb: any, orgId: string, body: any) {
  const { lead_id } = body;
  if (!lead_id) return err("lead_id required");

  // Verify lead belongs to org
  const { data: lead } = await adminSb.from("lge_raw_leads").select("id").eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);

  const { data, error } = await adminSb
    .from("lge_lead_notes")
    .select("id, note, created_by, created_at")
    .eq("raw_lead_id", lead_id)
    .order("created_at", { ascending: true });

  if (error) return err(error.message, 500);

  // Attach author display names
  const userIds = [...new Set((data ?? []).map((n: any) => n.created_by).filter(Boolean))];
  let nameMap: Record<string, string> = {};
  if (userIds.length) {
    const { data: profiles } = await adminSb.from("profiles").select("id, full_name, email").in("id", userIds);
    for (const p of profiles ?? []) nameMap[p.id] = p.full_name || p.email || "Unknown";
  }

  const notes = (data ?? []).map((n: any) => ({
    ...n,
    author: n.created_by ? (nameMap[n.created_by] ?? "Unknown") : "API / Webhook",
  }));

  return ok({ notes });
}

async function handleAddNote(adminSb: any, orgId: string, userId: string, body: any) {
  const { lead_id, note } = body;
  if (!lead_id) return err("lead_id required");
  if (!note || !String(note).trim()) return err("note required");
  if (String(note).trim().length > 2000) return err("Note exceeds 2000 characters");

  // Verify lead belongs to org
  const { data: lead } = await adminSb.from("lge_raw_leads").select("id").eq("id", lead_id).eq("org_id", orgId).maybeSingle();
  if (!lead) return err("Lead not found", 404);

  const { data, error } = await adminSb
    .from("lge_lead_notes")
    .insert({ org_id: orgId, raw_lead_id: lead_id, note: String(note).trim(), created_by: userId })
    .select("id, note, created_by, created_at")
    .single();

  if (error) return err(error.message, 500);

  // Fetch author name
  const { data: profile } = await adminSb.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
  const author = profile?.full_name || profile?.email || "Unknown";

  return ok({ note: { ...data, author } }, 201);
}

// ── Phase 7 handlers ──────────────────────────────────────────────────────────

async function handleClone(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: src } = await adminSb
    .from("lge_campaigns").select(CAMPAIGN_COLS).eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!src) return err("Campaign not found", 404);

  const { data, error } = await adminSb
    .from("lge_campaigns")
    .insert({
      org_id:              orgId,
      name:                `${src.name} (copy)`,
      mode:                "off", // start off — don't accidentally push
      status:              "active",
      icp_config:          src.icp_config,
      max_leads_per_day:   src.max_leads_per_day,
      auto_push_threshold: src.auto_push_threshold,
      review_threshold:    src.review_threshold,
      review_ttl_days:     src.review_ttl_days,
      outreach_template:   src.outreach_template,
      created_by:          userId,
    })
    .select(CAMPAIGN_COLS)
    .single();

  if (error) return err(error.message, 500);
  return ok({ campaign: data }, 201);
}

async function handleGetScorecard(adminSb: any, orgId: string) {
  // 1. Campaigns
  const { data: camps } = await adminSb
    .from("lge_campaigns")
    .select("id, name, mode, auto_push_threshold, review_threshold, review_ttl_days")
    .eq("org_id", orgId).neq("status", "archived").order("created_at", { ascending: false });
  if (!camps?.length) return ok({ scorecard: [] });
  const campIds = (camps as any[]).map((c: any) => c.id);

  // 2. Lead status + updated_at
  const { data: rawLeads } = await adminSb
    .from("lge_raw_leads").select("id, campaign_id, status, updated_at").eq("org_id", orgId).in("campaign_id", campIds);

  // 3. Scores for scored/review/discarded/pushed leads
  const scorableIds = ((rawLeads ?? []) as any[])
    .filter((l: any) => !["pending", "enriching"].includes(l.status)).map((l: any) => l.id);
  let scores: any[] = [];
  if (scorableIds.length) {
    const { data } = await adminSb.from("lge_scores").select("raw_lead_id, total_score").in("raw_lead_id", scorableIds);
    scores = data ?? [];
  }
  const scoreMap = new Map<string, number>((scores as any[]).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

  // 4. Outcomes for pushed leads
  const pushedLeads = ((rawLeads ?? []) as any[]).filter((l: any) => l.status === "pushed");
  const pushedIds = pushedLeads.map((l: any) => l.id);
  const pushedCampMap = new Map<string, string>(pushedLeads.map((l: any) => [l.id, l.campaign_id]));
  let outcomes: any[] = [];
  if (pushedIds.length) {
    const { data } = await adminSb.from("lge_outcomes").select("raw_lead_id, outcome").in("raw_lead_id", pushedIds);
    outcomes = data ?? [];
  }

  // 5. Build per-campaign scorecard
  const scorecard = (camps as any[]).map((c: any) => {
    const campLeads = ((rawLeads ?? []) as any[]).filter((l: any) => l.campaign_id === c.id);
    const total        = campLeads.length;
    const enriched     = campLeads.filter((l: any) => !["pending","enriching"].includes(l.status)).length;
    const pushed       = campLeads.filter((l: any) => l.status === "pushed").length;
    const review       = campLeads.filter((l: any) => l.status === "review_queue").length;
    const discarded    = campLeads.filter((l: any) => l.status === "discarded").length;
    const failed       = campLeads.filter((l: any) => l.status === "failed").length;

    // Backlog age
    const reviewLeads  = campLeads.filter((l: any) => l.status === "review_queue");
    const reviewAgesD  = reviewLeads.map((l: any) => (Date.now() - new Date(l.updated_at).getTime()) / 86_400_000);
    const oldestDays   = reviewAgesD.length ? Math.max(...reviewAgesD) : 0;

    // Near-threshold band (review leads within 10pts below auto_push_threshold)
    const nearThreshold = campLeads
      .filter((l: any) => l.status === "review_queue")
      .filter((l: any) => {
        const sc = scoreMap.get(l.id) ?? -1;
        return sc >= c.auto_push_threshold - 10 && sc < c.auto_push_threshold;
      }).length;

    // Outcomes
    const campOutcomes = (outcomes as any[]).filter((o: any) => pushedCampMap.get(o.raw_lead_id) === c.id);
    const replied      = campOutcomes.filter((o: any) => ["replied","booked","closed"].includes(o.outcome)).length;
    const booked       = campOutcomes.filter((o: any) => ["booked","closed"].includes(o.outcome)).length;

    const pushRate  = enriched > 0  ? pushed  / enriched  : 0;
    const replyRate = pushed   > 0  ? replied / pushed    : 0;
    const bookRate  = pushed   > 0  ? booked  / pushed    : 0;
    const enrichRate = total   > 0  ? enriched / total    : 0;

    // Suggestions
    const suggestions: string[] = [];
    if (review > 5 && nearThreshold > 3 && replyRate >= 0.10) {
      suggestions.push(
        `Push threshold may be too high — ${nearThreshold} review leads scored within 10 pts of ${c.auto_push_threshold}. Reply rate on pushed leads is ${(replyRate*100).toFixed(0)}%. Consider lowering to ${c.auto_push_threshold - 5}.`
      );
    }
    if (pushRate > 0.70 && replyRate < 0.05 && pushed > 10) {
      suggestions.push(
        `Push threshold may be too low — ${(pushRate*100).toFixed(0)}% of scored leads auto-push but reply rate is only ${(replyRate*100).toFixed(0)}%. Consider raising to ${Math.min(100, c.auto_push_threshold + 5)}.`
      );
    }
    if (oldestDays > c.review_ttl_days * 0.70 && review > 0) {
      suggestions.push(
        `Review queue has leads ${oldestDays.toFixed(0)} days old — approaching the ${c.review_ttl_days}-day auto-discard TTL. Review them soon or increase the TTL.`
      );
    }
    if (enrichRate < 0.30 && total > 10) {
      suggestions.push(
        `Only ${(enrichRate*100).toFixed(0)}% of leads have enrichment data. Add Apollo or Hunter API keys to improve scoring accuracy.`
      );
    }
    if (pushed > 5 && replied === 0) {
      suggestions.push(
        `${pushed} leads have been pushed to GSC but no outcomes are recorded yet. Check that AI outreach is firing and the outcome sync cron is running.`
      );
    }

    return {
      campaign_id:         c.id,
      name:                c.name,
      mode:                c.mode,
      auto_push_threshold: c.auto_push_threshold,
      review_threshold:    c.review_threshold,
      review_ttl_days:     c.review_ttl_days,
      total, enriched, pushed, review, discarded, failed,
      replied, booked,
      push_rate:           Math.round(pushRate  * 100),
      reply_rate:          Math.round(replyRate * 100),
      book_rate:           Math.round(bookRate  * 100),
      oldest_review_days:  Math.round(oldestDays * 10) / 10,
      near_threshold_count: nearThreshold,
      suggestions,
    };
  });

  return ok({ scorecard });
}

async function handlePreviewThresholdChange(adminSb: any, orgId: string, body: any) {
  const { campaign_id, auto_push_threshold, review_threshold } = body;
  if (!campaign_id) return err("campaign_id required");
  const apt = Number(auto_push_threshold);
  const rt  = Number(review_threshold);
  if (isNaN(apt) || isNaN(rt)) return err("auto_push_threshold and review_threshold required");

  // Fetch current thresholds
  const { data: camp } = await adminSb
    .from("lge_campaigns").select("auto_push_threshold, review_threshold").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  // All non-pushed scored leads in this campaign
  const { data: leads } = await adminSb
    .from("lge_raw_leads").select("id, status")
    .eq("campaign_id", campaign_id).eq("org_id", orgId)
    .in("status", ["scored","review_queue","discarded"]);

  const ids = (leads ?? []).map((l: any) => l.id);
  let scores: any[] = [];
  if (ids.length) {
    const { data } = await adminSb.from("lge_scores").select("raw_lead_id, total_score").in("raw_lead_id", ids);
    scores = data ?? [];
  }
  const scoreMap = new Map<string, number>((scores as any[]).map((s: any) => [s.raw_lead_id, Number(s.total_score)]));

  let currentPush = 0, currentReview = 0, currentDiscard = 0;
  let newPush = 0, newReview = 0, newDiscard = 0;

  for (const lead of (leads ?? []) as any[]) {
    const score = scoreMap.get(lead.id) ?? 0;
    // Current routing
    if (score >= camp.auto_push_threshold)    currentPush++;
    else if (score >= camp.review_threshold)  currentReview++;
    else                                       currentDiscard++;
    // New routing
    if (score >= apt)      newPush++;
    else if (score >= rt)  newReview++;
    else                   newDiscard++;
  }

  // Count pushed leads (unaffected)
  const { count: alreadyPushed } = await adminSb
    .from("lge_raw_leads").select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign_id).eq("org_id", orgId).eq("status", "pushed");

  return ok({
    evaluated: ids.length,
    already_pushed: alreadyPushed ?? 0,
    current:  { push: currentPush,  review: currentReview,  discard: currentDiscard },
    proposed: { push: newPush,       review: newReview,       discard: newDiscard },
    delta:    {
      push_change:    newPush    - currentPush,
      review_change:  newReview  - currentReview,
      discard_change: newDiscard - currentDiscard,
    },
  });
}

async function handlePreviewReprocess(adminSb: any, orgId: string, body: any) {
  const { campaign_id, mode = "score_only" } = body;
  if (!campaign_id) return err("campaign_id required");

  const { data: leads } = await adminSb
    .from("lge_raw_leads").select("id, status")
    .eq("campaign_id", campaign_id).eq("org_id", orgId)
    .not("status", "in", '("pushed","enriching")');

  const targetIds = (leads ?? []).map((l: any) => l.id);
  const total = targetIds.length;

  // How many have enrichment data
  let enrichedCount = 0;
  if (targetIds.length) {
    const { count } = await adminSb.from("lge_enrichment").select("raw_lead_id", { count: "exact", head: true }).in("raw_lead_id", targetIds);
    enrichedCount = count ?? 0;
  }

  // How many would need full enrichment (no existing enrichment)
  const needsEnrich = total - enrichedCount;

  return ok({
    mode,
    total_targeted: total,
    has_enrichment: enrichedCount,
    needs_enrichment: needsEnrich,
    api_calls_estimated: mode === "full" ? total : 0, // full mode re-runs all enrichment
    note: mode === "score_only"
      ? `Re-scores ${enrichedCount} leads using existing enrichment data. No provider API calls.`
      : `Clears all enrichment and re-runs the full pipeline for ${total} leads (~${total} Apollo + ${total} Hunter calls). Leads without provider keys will score on contact data only.`,
  });
}

async function handleStartReprocess(adminSb: any, orgId: string, userId: string, body: any) {
  const { campaign_id, mode = "score_only", reason } = body;
  if (!campaign_id) return err("campaign_id required");
  if (!["score_only", "full"].includes(mode)) return err("mode must be score_only|full");

  // Verify campaign ownership
  const { data: camp } = await adminSb
    .from("lge_campaigns")
    .select("id, icp_config, auto_push_threshold, review_threshold, mode, outreach_template")
    .eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  // Target: all non-pushed, non-currently-enriching leads
  const { data: leads } = await adminSb
    .from("lge_raw_leads").select("id, status")
    .eq("campaign_id", campaign_id).eq("org_id", orgId)
    .not("status", "in", '("pushed","enriching")');
  if (!leads?.length) return ok({ ok: true, job_id: null, requeued: 0, message: "No leads to re-process" });

  const leadIds = (leads as any[]).map((l: any) => l.id);

  // Create job record (idempotency — audit trail)
  const { data: job, error: jobErr } = await adminSb
    .from("lge_reprocess_jobs")
    .insert({ org_id: orgId, campaign_id, mode, lead_ids: leadIds, lead_count: leadIds.length, status: "running", initiated_by: userId, reason: reason ? String(reason).slice(0, 500) : null })
    .select("id").single();
  if (jobErr) return err(jobErr.message, 500);
  const jobId: string = job.id;

  if (mode === "full") {
    // Clear downstream data, reset to pending — worker re-enriches
    await Promise.all([
      adminSb.from("lge_context").delete().in("raw_lead_id", leadIds),
      adminSb.from("lge_scores").delete().in("raw_lead_id", leadIds),
      adminSb.from("lge_enrichment").delete().in("raw_lead_id", leadIds),
      adminSb.from("lge_provider_calls").delete().in("raw_lead_id", leadIds),
    ]);
    await adminSb.from("lge_raw_leads")
      .update({ status: "pending", attempt: 0, locked_by: null, locked_until: null })
      .in("id", leadIds).eq("org_id", orgId);
    // Job stays "running" — worker processes leads, we can't detect completion here
    return ok({ ok: true, job_id: jobId, mode, requeued: leadIds.length });
  }

  // ── score_only: inline re-score using existing enrichment ────────────────────
  // Historical lge_decision_logs are preserved (we only clear lge_scores + lge_context)
  await Promise.all([
    adminSb.from("lge_scores").delete().in("raw_lead_id", leadIds),
    adminSb.from("lge_context").delete().in("raw_lead_id", leadIds),
  ]);

  // Fetch enrichment for all targeted leads
  const { data: enrichRows } = await adminSb
    .from("lge_enrichment").select("raw_lead_id, industry, company_size, designation, email_verified, phone_line_type, phone_valid, website_reachable").in("raw_lead_id", leadIds);
  const enrichMap = new Map<string, any>((enrichRows ?? []).map((e: any) => [e.raw_lead_id, e]));

  // Fetch lead contact data
  const { data: leadRows } = await adminSb
    .from("lge_raw_leads").select("id, name, email, phone, company, source, raw_data").in("id", leadIds).eq("org_id", orgId);
  const leadMap = new Map<string, any>((leadRows ?? []).map((l: any) => [l.id, l]));

  // Source adj from lge_source_stats
  const { data: sourceStats } = await adminSb.from("lge_source_stats").select("source, confidence_adj, recency_adj").eq("org_id", orgId);
  const srcAdjMap = new Map<string, { confidence_adj: number; recency_adj: number }>(
    (sourceStats ?? []).map((s: any) => [s.source, { confidence_adj: Number(s.confidence_adj) || 0, recency_adj: Number(s.recency_adj) || 0 }])
  );

  const icp: IcpConfig = camp.icp_config ?? {};
  const apt = camp.auto_push_threshold ?? 80;
  const rt  = camp.review_threshold    ?? 60;

  let processed = 0, autoPushed = 0;
  const scoreUpserts: any[] = [];
  const statusUpdates: Array<{ ids: string[]; status: string; gscLeadId?: string; handoffKey?: string }> = [];

  // Resolve actor user for GSC push (needed for auto_push routing)
  let actorUserId: string | null = null;
  const { data: namedMember } = await adminSb.from("org_members").select("user_id")
    .eq("org_id", orgId).in("role", ["enterprise_admin","agency_admin","owner"]).limit(1).maybeSingle();
  if (namedMember) { actorUserId = namedMember.user_id; }
  else {
    const { data: nullMember } = await adminSb.from("org_members").select("user_id").eq("org_id", orgId).is("role", null).limit(1).maybeSingle();
    actorUserId = nullMember?.user_id ?? null;
  }

  for (const id of leadIds) {
    const lead = leadMap.get(id);
    if (!lead) continue;
    const enr = enrichMap.get(id);

    const rawDesig = String(lead.raw_data?.designation ?? lead.raw_data?.title ?? lead.raw_data?.job_title ?? "").trim() || null;
    const leadForScore: LeadData = {
      name: lead.name, email: lead.email, phone: lead.phone, company: lead.company,
      designation: enr?.designation ?? rawDesig,
    };
    const enrichData: EnrichmentData = {
      industry: enr?.industry ?? null,
      company_size: enr?.company_size ?? null,
      designation: enr?.designation ?? null,
      email_verified: enr?.email_verified ?? null,
      phone_line_type: enr?.phone_line_type ?? null,
      phone_valid: enr?.phone_valid ?? null,
      website_reachable: enr?.website_reachable ?? null,
    };

    const srcEntry = srcAdjMap.get(lead.source ?? "unknown");
    const signals  = computeSignalAdjustments(leadForScore, srcEntry?.confidence_adj ?? 0, srcEntry?.recency_adj ?? 0, false);
    const fitScore  = computeFitScore(enrichData, icp);
    const confScore = computeConfidenceScore(leadForScore, enrichData, signals.total);
    const fitW  = typeof icp.fit_weight === "number" ? icp.fit_weight : 0.6;
    const confW = typeof icp.confidence_weight === "number" ? icp.confidence_weight : 0.4;
    const total = computeTotalScore(fitScore, confScore, fitW, confW);
    scoreUpserts.push({ raw_lead_id: id, fit_score: fitScore, confidence_score: confScore, total_score: total });

    const routing = camp.mode === "shadow" ? "shadow_only" : routeByScore(total, apt, rt);
    const newStatus = routing === "auto_push" ? "pushed" : routing === "review_queue" ? "review_queue" : routing === "shadow_only" ? "scored" : "discarded";

    if (routing === "auto_push" && actorUserId) {
      // Idempotency: skip if already pushed via handoff key
      const handoffKey = `lge:${id}`;
      const { data: existing } = await adminSb.from("lge_raw_leads").select("gsc_handoff_key").eq("id", id).maybeSingle();
      if (!existing?.gsc_handoff_key) {
        // Phone dedupe
        let skip = false;
        if (lead.phone) {
          const { data: dup } = await adminSb.from("leads").select("id").eq("org_id", orgId).eq("phone", lead.phone).maybeSingle();
          if (dup) skip = true;
        }
        if (!skip) {
          const notes = JSON.stringify({ source: "lge", lge_lead_id: id, score: total, reprocess_job: jobId });
          const { data: gscLead } = await adminSb.from("leads").insert({
            org_id: orgId, profile_id: actorUserId, name: lead.name, phone: lead.phone ?? null, email: lead.email ?? null, notes, status: "new", source: "lge",
          }).select("id").single().catch(() => ({ data: null }));
          if (gscLead?.id) {
            const { data: plan } = await adminSb.from("decision_plans").insert({
              lead_id: gscLead.id, org_id, trigger: "webhook_inbound", plan: { source: "lge", source_event: "lge_reprocess" },
            }).select("id").single().catch(() => ({ data: null }));
            if (plan?.id) {
              await adminSb.from("execution_tasks").insert({
                plan_id: plan.id, lead_id: gscLead.id, org_id, channel: "sms", max_attempts: 3,
                scheduled_for: new Date().toISOString(), status: "pending", actor_user_id: actorUserId,
                metadata: { source: "lge", lge_lead_id: id, lge_score: total, lge_job_id: jobId, ...(camp.outreach_template ? { force_content: camp.outreach_template } : {}) },
              }).catch(() => {});
            }
            await adminSb.from("lge_raw_leads").update({ status: "pushed", gsc_lead_id: gscLead.id, gsc_handoff_key: handoffKey }).eq("id", id);
            autoPushed++;
            processed++;
            continue;
          }
        }
      }
    }

    await adminSb.from("lge_raw_leads").update({ status: newStatus }).eq("id", id);
    processed++;
  }

  // Batch upsert scores
  if (scoreUpserts.length) {
    for (let i = 0; i < scoreUpserts.length; i += 100) {
      await adminSb.from("lge_scores").upsert(scoreUpserts.slice(i, i + 100), { onConflict: "raw_lead_id" }).catch(() => {});
    }
  }

  // Complete job
  await adminSb.from("lge_reprocess_jobs").update({ status: "done", processed_count: processed, pushed_count: autoPushed, completed_at: new Date().toISOString() }).eq("id", jobId);

  return ok({ ok: true, job_id: jobId, mode, processed, pushed: autoPushed });
}

async function handleGetThresholdHistory(adminSb: any, orgId: string, body: any) {
  const { campaign_id } = body;
  if (!campaign_id) return err("campaign_id required");

  // Verify ownership
  const { data: camp } = await adminSb.from("lge_campaigns").select("id").eq("id", campaign_id).eq("org_id", orgId).maybeSingle();
  if (!camp) return err("Campaign not found", 404);

  const { data, error } = await adminSb
    .from("lge_threshold_history")
    .select("id, old_auto_push, new_auto_push, old_review, new_review, reason, created_at")
    .eq("campaign_id", campaign_id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return err(error.message, 500);
  return ok({ history: data ?? [] });
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // 1. Auth — plain fetch to /auth/v1/user, bypasses SDK ES256 local-parse entirely
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("GSC_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "Authorization": `Bearer ${token}`, "apikey": serviceKey },
    });
    if (!userResp.ok) return err("Unauthorized", 401);
    const userData = await userResp.json();
    const userId: string = userData?.id;
    if (!userId) return err("Unauthorized", 401);

    // Use service-role client for all DB ops (queries explicitly scoped by org_id/user_id)
    const adminSb = getServiceSupabaseClient();

    // 2. Org
    const orgId = await resolveOrgId(adminSb, userId);
    if (!orgId) return err("No organization found", 403);

    // 3. Entitlement
    const entitled = await checkEntitlement(adminSb, orgId);
    if (!entitled) return err("lead_gen entitlement not active", 403);

    // 4. Parse
    const body = req.method === "GET" ? {} : await req.json();
    const { action } = body;

    if (!action) return err("action required");

    switch (action) {
      case "list":
        return handleList(adminSb, orgId);

      case "get":
        if (!body.campaign_id) return err("campaign_id required");
        return handleGet(adminSb, orgId, body.campaign_id);

      case "create":
        return handleCreate(adminSb, adminSb, orgId, userId, body);

      case "update":
        if (!body.campaign_id) return err("campaign_id required");
        return handleUpdate(adminSb, adminSb, orgId, body.campaign_id, body);

      case "set_provider_key":
        return handleSetProviderKey(adminSb, adminSb, orgId, userId, body);

      case "delete_provider_key":
        return handleDeleteProviderKey(adminSb, adminSb, orgId, userId, body);

      case "get_provider_status":
        return handleGetProviderStatus(adminSb, orgId);

      case "test_provider":
        return handleTestProvider(adminSb, orgId, body);

      case "discard_lead":
        return handleDiscardLead(adminSb, orgId, body);

      case "retry_lead":
        return handleRetryLead(adminSb, orgId, body);

      case "force_push":
        return handleForcePush(adminSb, orgId, body);

      case "get_provider_trace":
        return handleGetProviderTrace(adminSb, orgId, body);

      case "reprocess_lead":
        return handleReprocessLead(adminSb, orgId, body);

      case "refresh_source_stats": {
        const { data: count, error: rssErr } = await adminSb.rpc("compute_lge_source_stats", { p_org_id: orgId });
        if (rssErr) return err(rssErr.message, 500);
        return ok({ ok: true, rows_updated: count });
      }

      case "bulk_reprocess":
        return handleBulkReprocess(adminSb, orgId, body);

      case "send_report":
        return handleSendReport(adminSb, orgId, userId, body);

      // ── Phase 10 ──────────────────────────────────────────────────────────────
      case "mark_outcome":
        return handleMarkOutcome(adminSb, orgId, userId, body);

      case "reenrich_lead":
        return handleReenrichLead(adminSb, orgId, userId, body);

      case "get_campaign_audit":
        return handleGetCampaignAudit(adminSb, orgId, body);

      case "get_lead_timeline":
        return handleGetLeadTimeline(adminSb, orgId, body);

      // ── Phase 9 ───────────────────────────────────────────────────────────────
      case "override_score":
        return handleOverrideScore(adminSb, orgId, userId, body);

      case "revert_score":
        return handleRevertScore(adminSb, orgId, body);

      case "pause_campaign":
        return handlePauseCampaign(adminSb, orgId, userId, body);

      case "resume_campaign":
        return handleResumeCampaign(adminSb, orgId, userId, body);

      case "archive_campaign":
        return handleArchiveCampaign(adminSb, orgId, userId, body);

      // ── Phase 8 ───────────────────────────────────────────────────────────────
      case "list_imports":
        return handleListImports(adminSb, orgId, body);

      case "list_notes":
        return handleListNotes(adminSb, orgId, body);

      case "add_note":
        return handleAddNote(adminSb, orgId, userId, body);

      // ── Phase 7 ───────────────────────────────────────────────────────────────
      case "clone":
        return handleClone(adminSb, orgId, userId, body);

      case "get_scorecard":
        return handleGetScorecard(adminSb, orgId);

      case "preview_threshold_change":
        return handlePreviewThresholdChange(adminSb, orgId, body);

      case "preview_reprocess":
        return handlePreviewReprocess(adminSb, orgId, body);

      case "start_reprocess":
        return handleStartReprocess(adminSb, orgId, userId, body);

      case "get_threshold_history":
        return handleGetThresholdHistory(adminSb, orgId, body);

      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (e: any) {
    console.error("[lge_campaign_manage] unhandled error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
