// crm_adapters.ts — CRM adapter router + HubSpot + Pipedrive implementations.
// Phase 1: native placeholder. Phase 2: HubSpot + Pipedrive. Phase 3: Salesforce + Zoho.
//
// Hardening guarantees:
//  - Mapping checked before every create (no duplicate contacts on retry)
//  - 401 → immediate auth_failed (no retry burn)
//  - 429 → rate_limited, worker retries via natural backoff
//  - Raw tokens never returned, always encrypted at rest
//  - One org's auth failure is fully isolated

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptCrmAuth, encryptCrmAuth } from "./crm_token_crypto.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdapterResult {
  success:     boolean;
  externalId?: string;
  error?:      string;
  skip?:       boolean; // mark as skipped — do not burn retry budget
  authFailed?: boolean; // mark destination unhealthy immediately
}

export interface CrmDestination {
  id:                  string;
  org_id:              string;
  crm_type:            string;
  config_json:         Record<string, unknown>;
  auth_json_encrypted: string | null;
  health_status:       string;
}

export interface CrmSyncEvent {
  id:           string;
  org_id:       string;
  event_type:   string;
  entity_type:  string;
  entity_id:    string;
  payload_json: Record<string, unknown>;
  attempts:     number;
  max_attempts: number;
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function routeToAdapter(
  dest:  CrmDestination,
  event: CrmSyncEvent,
  sb:    SupabaseClient,
): Promise<AdapterResult> {
  switch (dest.crm_type) {
    case "native":     return syncViaNativeAdapter();
    case "hubspot":    return syncViaHubSpot(dest, event, sb);
    case "pipedrive":  return syncViaPipedrive(dest, event, sb);
    case "salesforce": return { success: false, skip: true, error: "salesforce_adapter_phase3" };
    case "zoho":       return { success: false, skip: true, error: "zoho_adapter_phase3" };
    default:
      return { success: false, skip: true, error: `unknown_crm_type:${dest.crm_type}` };
  }
}

// ── Native CRM placeholder ────────────────────────────────────────────────────

function syncViaNativeAdapter(): AdapterResult {
  return { success: false, skip: true, error: "native_crm_not_built_yet" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUBSPOT ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════

const HUBSPOT_API = "https://api.hubapi.com";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

interface HubSpotAuth {
  access_token:  string;
  refresh_token: string;
  expires_at:    number; // unix ms
  hub_id?:       string;
}

function hubspotFieldMap(dest: CrmDestination): Record<string, string> {
  const custom = (dest.config_json?.field_mappings as Record<string, string>) ?? {};
  return {
    firstname:       custom.name       ?? "name",
    email:           custom.email      ?? "email",
    phone:           custom.phone      ?? "phone",
    company:         custom.company    ?? "company",
    hs_lead_status:  custom.source     ?? "source",
    lifecyclestage:  custom.lifecycle_stage ?? "lifecycle_stage",
    ...custom,
  };
}

async function refreshHubSpotToken(auth: HubSpotAuth, dest: CrmDestination, sb: SupabaseClient): Promise<HubSpotAuth | null> {
  const clientId     = Deno.env.get("HUBSPOT_CLIENT_ID");
  const clientSecret = Deno.env.get("HUBSPOT_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: auth.refresh_token,
      }).toString(),
    });
    if (!res.ok) return null;
    const json = await res.json();

    const newAuth: HubSpotAuth = {
      access_token:  json.access_token,
      refresh_token: json.refresh_token ?? auth.refresh_token,
      expires_at:    Date.now() + (json.expires_in ?? 1800) * 1000,
      hub_id:        auth.hub_id,
    };

    // Persist refreshed token (encrypted)
    await sb.from("crm_destinations").update({
      auth_json_encrypted: await encryptCrmAuth(newAuth as unknown as Record<string, unknown>),
      health_status: "healthy",
      updated_at:    new Date().toISOString(),
    }).eq("id", dest.id);

    return newAuth;
  } catch {
    return null;
  }
}

async function hubspotRequest(
  method: string,
  path:   string,
  body:   unknown,
  auth:   HubSpotAuth,
  dest:   CrmDestination,
  sb:     SupabaseClient,
): Promise<{ ok: boolean; status: number; data: unknown; authFailed: boolean; rateLimited: boolean }> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  const doRequest = async (token: string) => {
    const res = await fetch(`${HUBSPOT_API}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let data: unknown;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  };

  try {
    let result = await doRequest(auth.access_token);

    // 401: try one token refresh then retry once
    if (result.status === 401) {
      const refreshed = await refreshHubSpotToken(auth, dest, sb);
      if (!refreshed) return { ...result, authFailed: true, rateLimited: false };
      result = await doRequest(refreshed.access_token);
      if (result.status === 401) return { ...result, authFailed: true, rateLimited: false };
    }

    return {
      ...result,
      authFailed:  result.status === 401,
      rateLimited: result.status === 429,
    };
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, authFailed: false, rateLimited: false };
  }
}

async function getHubSpotContactId(
  email:    string | null,
  dest:     CrmDestination,
  entityId: string,
  auth:     HubSpotAuth,
  sb:       SupabaseClient,
): Promise<string | null> {
  // 1. Check our mapping first
  const { data: mapping } = await sb.from("crm_sync_mappings")
    .select("external_entity_id")
    .eq("destination_id", dest.id)
    .eq("internal_entity_type", "lead")
    .eq("internal_entity_id", entityId)
    .eq("external_entity_type", "contact")
    .maybeSingle();
  if (mapping?.external_entity_id) return mapping.external_entity_id;

  // 2. Search HubSpot by email to detect pre-existing contacts
  if (email) {
    const result = await hubspotRequest("POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      limit: 1,
    }, auth, dest, sb);
    const results = (result.data as any)?.results;
    if (results?.length) return String(results[0].id);
  }

  return null;
}

async function hubspotUpsertMapping(
  sb:             SupabaseClient,
  dest:           CrmDestination,
  entityId:       string,
  externalType:   string,
  externalId:     string,
) {
  await sb.from("crm_sync_mappings").upsert({
    org_id:               dest.org_id,
    destination_id:       dest.id,
    internal_entity_type: "lead",
    internal_entity_id:   entityId,
    external_entity_type: externalType,
    external_entity_id:   externalId,
    updated_at:           new Date().toISOString(),
  }, { onConflict: "destination_id,internal_entity_type,internal_entity_id,external_entity_type" })
    .then(undefined, () => {});
}

export async function syncViaHubSpot(
  dest:  CrmDestination,
  event: CrmSyncEvent,
  sb:    SupabaseClient,
): Promise<AdapterResult> {
  if (!dest.auth_json_encrypted) {
    return { success: false, skip: true, error: "hubspot_not_configured" };
  }

  let auth: HubSpotAuth;
  try {
    auth = (await decryptCrmAuth(dest.auth_json_encrypted)) as unknown as HubSpotAuth;
  } catch {
    return { success: false, authFailed: true, error: "auth_failed_decrypt_error" };
  }

  // Proactive token refresh if within 5 minutes of expiry
  if (auth.expires_at && Date.now() > auth.expires_at - 5 * 60 * 1000) {
    const refreshed = await refreshHubSpotToken(auth, dest, sb);
    if (refreshed) auth = refreshed;
  }

  const p = event.payload_json;
  const fieldMap = hubspotFieldMap(dest);

  // Map GSC payload → HubSpot properties using field mapping config
  function mapContactProps(payload: Record<string, unknown>): Record<string, string> {
    const props: Record<string, string> = {};
    for (const [hubspotField, gscField] of Object.entries(fieldMap)) {
      const val = payload[gscField];
      if (val != null && val !== "") props[hubspotField] = String(val);
    }
    // Direct field passthrough for canonical fields
    if (payload.name)            props.firstname    = String(payload.name).split(" ")[0];
    if (String(payload.name ?? "").split(" ").length > 1) props.lastname = String(payload.name).split(" ").slice(1).join(" ");
    if (payload.email)           props.email        = String(payload.email);
    if (payload.phone)           props.phone        = String(payload.phone);
    if (payload.company)         props.company      = String(payload.company);
    if (payload.lifecycle_stage) {
      const lsMap: Record<string, string> = {
        new: "lead", contacted: "marketingqualifiedlead", replied: "salesqualifiedlead",
        booked: "opportunity", converted: "customer",
      };
      props.lifecyclestage = lsMap[String(payload.lifecycle_stage)] ?? "lead";
    }
    return props;
  }

  switch (event.event_type) {

    case "lead_created":
    case "customer_updated": {
      const email = p.email ? String(p.email) : null;
      const existingId = await getHubSpotContactId(email, dest, event.entity_id, auth, sb);

      if (existingId) {
        // UPDATE existing contact
        const res = await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${existingId}`,
          { properties: mapContactProps(p) }, auth, dest, sb);
        if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
        if (res.rateLimited) return { success: false, error: "rate_limited_429" };
        if (!res.ok) return { success: false, error: `hubspot_http_${res.status}` };
        await hubspotUpsertMapping(sb, dest, event.entity_id, "contact", existingId);
        return { success: true, externalId: existingId };
      }

      // CREATE new contact
      const res = await hubspotRequest("POST", "/crm/v3/objects/contacts",
        { properties: mapContactProps(p) }, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      if (res.rateLimited) return { success: false, error: "rate_limited_429" };

      // 409 Conflict: contact already exists — HubSpot returns the existing ID
      if (res.status === 409) {
        const existingIdFromConflict = String((res.data as any)?.message ?? "").match(/Existing ID:\s*(\d+)/)?.[1];
        if (existingIdFromConflict) {
          await hubspotUpsertMapping(sb, dest, event.entity_id, "contact", existingIdFromConflict);
          return { success: true, externalId: existingIdFromConflict };
        }
      }

      if (!res.ok) return { success: false, error: `hubspot_http_${res.status}` };
      const contactId = String((res.data as any)?.id);
      await hubspotUpsertMapping(sb, dest, event.entity_id, "contact", contactId);

      // Also create a Deal linked to this contact (lead pipeline)
      if (p.name) {
        const dealRes = await hubspotRequest("POST", "/crm/v3/objects/deals", {
          properties: {
            dealname:  `${p.name} — GSC Lead`,
            dealstage: "appointmentscheduled",
            pipeline:  "default",
          },
        }, auth, dest, sb);
        if (dealRes.ok) {
          const dealId = String((dealRes.data as any)?.id);
          await hubspotUpsertMapping(sb, dest, event.entity_id, "deal", dealId);
          // Associate deal → contact
          await hubspotRequest("PUT", `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`, null, auth, dest, sb);
        }
      }

      return { success: true, externalId: contactId };
    }

    case "lead_contacted":
    case "lead_replied": {
      const contactId = await getHubSpotContactId(p.email ? String(p.email) : null, dest, event.entity_id, auth, sb);
      if (!contactId) return { success: false, error: "contact_not_found_in_hubspot" };

      const noteBody = event.event_type === "lead_replied"
        ? `Lead replied via ${p.channel ?? "unknown"}: ${p.message_preview ?? ""}`
        : `GSC contacted lead via ${p.channel ?? "unknown"}: ${p.message_preview ?? ""}`;

      // Update lifecycle stage
      const lsMap: Record<string, string> = {
        contacted: "marketingqualifiedlead", replied: "salesqualifiedlead",
      };
      if (event.event_type === "lead_replied") {
        await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`,
          { properties: { lifecyclestage: lsMap[event.event_type] ?? "salesqualifiedlead" } }, auth, dest, sb);
      }

      // Log as engagement note
      const noteRes = await hubspotRequest("POST", "/engagements/v1/engagements", {
        engagement: { active: true, type: "NOTE", timestamp: Date.now() },
        associations: { contactIds: [Number(contactId)] },
        metadata: { body: noteBody },
      }, auth, dest, sb);
      if (noteRes.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      if (noteRes.rateLimited) return { success: false, error: "rate_limited_429" };
      return { success: noteRes.ok, error: noteRes.ok ? undefined : `hubspot_http_${noteRes.status}` };
    }

    case "meeting_booked": {
      const contactId = await getHubSpotContactId(p.email ? String(p.email) : null, dest, event.entity_id, auth, sb);

      // Update lifecycle to opportunity
      if (contactId) {
        await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`,
          { properties: { lifecyclestage: "opportunity" } }, auth, dest, sb);
      }

      // Update deal stage if deal exists
      const { data: dealMapping } = await sb.from("crm_sync_mappings")
        .select("external_entity_id").eq("destination_id", dest.id)
        .eq("internal_entity_type", "lead").eq("internal_entity_id", event.entity_id)
        .eq("external_entity_type", "deal").maybeSingle();

      if (dealMapping?.external_entity_id) {
        await hubspotRequest("PATCH", `/crm/v3/objects/deals/${dealMapping.external_entity_id}`,
          { properties: { dealstage: "presentationscheduled", closedate: p.meeting_at ?? null } },
          auth, dest, sb);
      }
      return { success: true };
    }

    case "customer_converted": {
      const contactId = await getHubSpotContactId(p.email ? String(p.email) : null, dest, event.entity_id, auth, sb);
      if (!contactId) return { success: true }; // best-effort
      const res = await hubspotRequest("PATCH", `/crm/v3/objects/contacts/${contactId}`,
        { properties: { lifecyclestage: "customer" } }, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      return { success: res.ok };
    }

    case "deal_won":
    case "deal_lost": {
      const { data: dealMapping } = await sb.from("crm_sync_mappings")
        .select("external_entity_id").eq("destination_id", dest.id)
        .eq("internal_entity_type", "lead").eq("internal_entity_id", event.entity_id)
        .eq("external_entity_type", "deal").maybeSingle();
      if (!dealMapping?.external_entity_id) return { success: true }; // no deal to update
      const stage = event.event_type === "deal_won" ? "closedwon" : "closedlost";
      const res = await hubspotRequest("PATCH", `/crm/v3/objects/deals/${dealMapping.external_entity_id}`,
        { properties: { dealstage: stage } }, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      return { success: res.ok };
    }

    default:
      return { success: true }; // unhandled event type — no-op, not a failure
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPEDRIVE ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════

const PIPEDRIVE_TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";

interface PipedriveAuth {
  access_token:  string;
  refresh_token?: string;
  api_token?:    string;   // API key mode (no OAuth)
  expires_at?:   number;
  api_domain:    string;   // e.g. "companydomain.pipedrive.com" or "api.pipedrive.com"
}

async function refreshPipedriveToken(auth: PipedriveAuth, dest: CrmDestination, sb: SupabaseClient): Promise<PipedriveAuth | null> {
  if (!auth.refresh_token) return null;
  const clientId     = Deno.env.get("PIPEDRIVE_CLIENT_ID");
  const clientSecret = Deno.env.get("PIPEDRIVE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(PIPEDRIVE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: auth.refresh_token,
      }).toString(),
    });
    if (!res.ok) return null;
    const json = await res.json();

    const newAuth: PipedriveAuth = {
      access_token:  json.access_token,
      refresh_token: json.refresh_token ?? auth.refresh_token,
      expires_at:    Date.now() + (json.expires_in ?? 3600) * 1000,
      api_domain:    json.api_domain ?? auth.api_domain,
    };

    await sb.from("crm_destinations").update({
      auth_json_encrypted: await encryptCrmAuth(newAuth as unknown as Record<string, unknown>),
      health_status: "healthy",
      updated_at:    new Date().toISOString(),
    }).eq("id", dest.id);

    return newAuth;
  } catch {
    return null;
  }
}

async function pipedriveRequest(
  method:  string,
  path:    string,
  body:    unknown,
  auth:    PipedriveAuth,
  dest:    CrmDestination,
  sb:      SupabaseClient,
): Promise<{ ok: boolean; status: number; data: unknown; authFailed: boolean; rateLimited: boolean }> {
  const base  = `https://${auth.api_domain}/v1`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  const buildHeaders = (token: string, isApiKey: boolean): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(isApiKey ? {} : { "Authorization": `Bearer ${token}` }),
  });
  const buildUrl = (token: string, isApiKey: boolean): string =>
    `${base}${path}${isApiKey ? `?api_token=${encodeURIComponent(token)}` : ""}`;

  const doRequest = async (authObj: PipedriveAuth) => {
    const isApiKey = !!authObj.api_token;
    const token    = isApiKey ? authObj.api_token! : authObj.access_token;
    const res = await fetch(buildUrl(token, isApiKey), {
      method,
      headers: buildHeaders(token, isApiKey),
      body:    body ? JSON.stringify(body) : undefined,
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    let data: unknown;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  };

  try {
    let result = await doRequest(auth);

    // 401 on OAuth mode: try refresh
    if (result.status === 401 && !auth.api_token) {
      const refreshed = await refreshPipedriveToken(auth, dest, sb);
      if (!refreshed) return { ...result, authFailed: true, rateLimited: false };
      result = await doRequest(refreshed);
      if (result.status === 401) return { ...result, authFailed: true, rateLimited: false };
    }

    return {
      ...result,
      authFailed:  result.status === 401,
      rateLimited: result.status === 429,
    };
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, authFailed: false, rateLimited: false };
  }
}

async function getPipedrivePersonId(
  email:    string | null,
  dest:     CrmDestination,
  entityId: string,
  auth:     PipedriveAuth,
  sb:       SupabaseClient,
): Promise<string | null> {
  // 1. Check our mapping
  const { data: mapping } = await sb.from("crm_sync_mappings")
    .select("external_entity_id")
    .eq("destination_id", dest.id)
    .eq("internal_entity_type", "lead")
    .eq("internal_entity_id", entityId)
    .eq("external_entity_type", "person")
    .maybeSingle();
  if (mapping?.external_entity_id) return mapping.external_entity_id;

  // 2. Search Pipedrive by email
  if (email) {
    const result = await pipedriveRequest("GET", `/persons/search?term=${encodeURIComponent(email)}&fields=email&limit=1&exact_match=true`,
      null, auth, dest, sb);
    const items = (result.data as any)?.data?.items;
    if (items?.length) return String(items[0].item.id);
  }

  return null;
}

async function pipedriveUpsertMapping(
  sb:           SupabaseClient,
  dest:         CrmDestination,
  entityId:     string,
  externalType: string,
  externalId:   string,
) {
  await sb.from("crm_sync_mappings").upsert({
    org_id:               dest.org_id,
    destination_id:       dest.id,
    internal_entity_type: "lead",
    internal_entity_id:   entityId,
    external_entity_type: externalType,
    external_entity_id:   externalId,
    updated_at:           new Date().toISOString(),
  }, { onConflict: "destination_id,internal_entity_type,internal_entity_id,external_entity_type" })
    .then(undefined, () => {});
}

export async function syncViaPipedrive(
  dest:  CrmDestination,
  event: CrmSyncEvent,
  sb:    SupabaseClient,
): Promise<AdapterResult> {
  if (!dest.auth_json_encrypted) {
    return { success: false, skip: true, error: "pipedrive_not_configured" };
  }

  let auth: PipedriveAuth;
  try {
    auth = (await decryptCrmAuth(dest.auth_json_encrypted)) as unknown as PipedriveAuth;
  } catch {
    return { success: false, authFailed: true, error: "auth_failed_decrypt_error" };
  }

  // Proactive refresh (OAuth mode only)
  if (!auth.api_token && auth.expires_at && Date.now() > auth.expires_at - 5 * 60 * 1000) {
    const refreshed = await refreshPipedriveToken(auth, dest, sb);
    if (refreshed) auth = refreshed;
  }

  const p = event.payload_json;

  switch (event.event_type) {

    case "lead_created":
    case "customer_updated": {
      const email    = p.email ? String(p.email) : null;
      const existingId = await getPipedrivePersonId(email, dest, event.entity_id, auth, sb);

      const personBody = {
        name:     p.name ?? "Unknown Lead",
        email:    email ? [{ value: email, primary: true }] : undefined,
        phone:    p.phone ? [{ value: String(p.phone), primary: true }] : undefined,
        org_name: p.company ?? undefined,
        visible_to: 3, // everyone
      };

      if (existingId) {
        const res = await pipedriveRequest("PUT", `/persons/${existingId}`, personBody, auth, dest, sb);
        if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
        if (res.rateLimited) return { success: false, error: "rate_limited_429" };
        if (!res.ok) return { success: false, error: `pipedrive_http_${res.status}` };
        await pipedriveUpsertMapping(sb, dest, event.entity_id, "person", existingId);
        return { success: true, externalId: existingId };
      }

      // CREATE person
      const res = await pipedriveRequest("POST", "/persons", personBody, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      if (res.rateLimited) return { success: false, error: "rate_limited_429" };
      if (!res.ok) return { success: false, error: `pipedrive_http_${res.status}` };

      const personId = String((res.data as any)?.data?.id);
      await pipedriveUpsertMapping(sb, dest, event.entity_id, "person", personId);

      // CREATE deal linked to person
      const dealRes = await pipedriveRequest("POST", "/deals", {
        title:     `${p.name ?? "New Lead"} — GSC`,
        person_id: Number(personId),
        status:    "open",
      }, auth, dest, sb);
      if (dealRes.ok) {
        const dealId = String((dealRes.data as any)?.data?.id);
        await pipedriveUpsertMapping(sb, dest, event.entity_id, "deal", dealId);
      }

      return { success: true, externalId: personId };
    }

    case "lead_contacted":
    case "lead_replied": {
      const email    = p.email ? String(p.email) : null;
      const personId = await getPipedrivePersonId(email, dest, event.entity_id, auth, sb);
      if (!personId) return { success: false, error: "person_not_found_in_pipedrive" };

      // Get deal ID if available
      const { data: dealMap } = await sb.from("crm_sync_mappings")
        .select("external_entity_id").eq("destination_id", dest.id)
        .eq("internal_entity_type", "lead").eq("internal_entity_id", event.entity_id)
        .eq("external_entity_type", "deal").maybeSingle();

      const activityBody = {
        subject:   event.event_type === "lead_replied" ? "Lead replied" : "GSC outreach sent",
        type:      event.event_type === "lead_replied" ? "email" : (String(p.channel ?? "email")),
        person_id: Number(personId),
        ...(dealMap?.external_entity_id ? { deal_id: Number(dealMap.external_entity_id) } : {}),
        note:      String(p.message_preview ?? "").slice(0, 2000),
        done:      1,
      };
      const res = await pipedriveRequest("POST", "/activities", activityBody, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      if (res.rateLimited) return { success: false, error: "rate_limited_429" };
      return { success: res.ok, error: res.ok ? undefined : `pipedrive_http_${res.status}` };
    }

    case "meeting_booked": {
      const email    = p.email ? String(p.email) : null;
      const personId = await getPipedrivePersonId(email, dest, event.entity_id, auth, sb);
      const { data: dealMap } = await sb.from("crm_sync_mappings")
        .select("external_entity_id").eq("destination_id", dest.id)
        .eq("internal_entity_type", "lead").eq("internal_entity_id", event.entity_id)
        .eq("external_entity_type", "deal").maybeSingle();

      if (dealMap?.external_entity_id) {
        await pipedriveRequest("PUT", `/deals/${dealMap.external_entity_id}`,
          { status: "open", expected_close_date: p.meeting_at ? String(p.meeting_at).split("T")[0] : undefined },
          auth, dest, sb);
      }

      if (personId) {
        await pipedriveRequest("POST", "/activities", {
          subject:   "Meeting booked via GSC",
          type:      "meeting",
          person_id: Number(personId),
          ...(dealMap?.external_entity_id ? { deal_id: Number(dealMap.external_entity_id) } : {}),
          due_date:  p.meeting_at ? String(p.meeting_at).split("T")[0] : undefined,
          done:      0,
        }, auth, dest, sb);
      }
      return { success: true };
    }

    case "deal_won":
    case "deal_lost": {
      const { data: dealMap } = await sb.from("crm_sync_mappings")
        .select("external_entity_id").eq("destination_id", dest.id)
        .eq("internal_entity_type", "lead").eq("internal_entity_id", event.entity_id)
        .eq("external_entity_type", "deal").maybeSingle();
      if (!dealMap?.external_entity_id) return { success: true };
      const res = await pipedriveRequest("PUT", `/deals/${dealMap.external_entity_id}`,
        { status: event.event_type === "deal_won" ? "won" : "lost" }, auth, dest, sb);
      if (res.authFailed) return { success: false, authFailed: true, error: "auth_failed_401" };
      return { success: res.ok };
    }

    case "customer_converted": {
      const email    = p.email ? String(p.email) : null;
      const personId = await getPipedrivePersonId(email, dest, event.entity_id, auth, sb);
      if (!personId) return { success: true };
      // Add a note to the person
      await pipedriveRequest("POST", "/notes", {
        content:   "Lead converted to customer via GSC",
        person_id: Number(personId),
      }, auth, dest, sb);
      return { success: true };
    }

    default:
      return { success: true };
  }
}
