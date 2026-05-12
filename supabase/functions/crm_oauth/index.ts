// crm_oauth — CRM OAuth flow + settings management.
// Routes:
//   POST /crm_oauth   body: { action, ...params }
//
// Actions (all require user JWT except where noted):
//   authorize_url     → returns OAuth redirect URL for hubspot/pipedrive
//   callback          → exchanges code for tokens, saves encrypted to crm_destinations (--no-verify-jwt)
//   save_api_key      → saves Pipedrive API key (no OAuth)
//   disconnect        → deletes crm_destination row
//   test_connection   → decrypts + makes a lightweight API call to verify tokens
//   update_field_mappings → stores field_mappings in config_json
//   get_destinations  → lists org's CRM destinations
//   retry_event       → calls retry_crm_sync_event RPC
//   get_sync_stats    → calls get_crm_sync_stats RPC
//   get_sync_logs     → calls get_crm_sync_logs RPC
//   get_failed_events → calls get_failed_crm_events RPC

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import {
  encryptCrmAuth,
  decryptCrmAuth,
  signOAuthState,
  verifyOAuthState,
} from "../_shared/crm_token_crypto.ts";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Content-Type": "application/json",
};

function resp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

async function resolveOrgId(jwt: string): Promise<{ orgId: string; userId: string } | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey    = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userSb     = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user } } = await userSb.auth.getUser();
  if (!user) return null;

  // Check org_members first (agency/enterprise agents)
  const { data: memRows } = await userSb
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1);
  if (memRows && memRows.length > 0) return { orgId: memRows[0].org_id, userId: user.id };

  // Fallback: solo user who owns an org directly
  const { data: orgRow } = await userSb
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (!orgRow) return null;
  return { orgId: orgRow.id, userId: user.id };
}

// ── HubSpot OAuth constants ────────────────────────────────────────────────────

const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL     = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_SCOPES        = "crm.objects.contacts.write crm.objects.contacts.read crm.objects.deals.write crm.objects.deals.read";

// ── Pipedrive OAuth constants ──────────────────────────────────────────────────

const PIPEDRIVE_AUTHORIZE_URL = "https://oauth.pipedrive.com/oauth/authorize";
const PIPEDRIVE_TOKEN_URL     = "https://oauth.pipedrive.com/oauth/token";

// ── Salesforce OAuth constants ─────────────────────────────────────────────────
const SALESFORCE_AUTHORIZE_URL = "https://login.salesforce.com/services/oauth2/authorize";
const SALESFORCE_TOKEN_URL     = "https://login.salesforce.com/services/oauth2/token";

// ── Zoho OAuth constants ───────────────────────────────────────────────────────
const ZOHO_AUTHORIZE_URL = "https://accounts.zoho.com/oauth/v2/auth";
const ZOHO_TOKEN_URL     = "https://accounts.zoho.com/oauth/v2/token";

// ── Redirect base URL ──────────────────────────────────────────────────────────

function callbackBase(): string {
  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  return `${supaUrl}/functions/v1/crm_oauth`;
}

// ── Action: authorize_url ──────────────────────────────────────────────────────

async function authorizeUrl(orgId: string, crmType: string): Promise<Response> {
  const state = await signOAuthState({ orgId, crmType, ts: Date.now() });

  if (crmType === "hubspot") {
    const clientId    = Deno.env.get("HUBSPOT_CLIENT_ID");
    if (!clientId) return resp({ error: "HUBSPOT_CLIENT_ID not configured" }, 500);
    const redirectUri = `${callbackBase()}?action=callback`;
    const url = new URL(HUBSPOT_AUTHORIZE_URL);
    url.searchParams.set("client_id",     clientId);
    url.searchParams.set("redirect_uri",  redirectUri);
    url.searchParams.set("scope",         HUBSPOT_SCOPES);
    url.searchParams.set("state",         state);
    return resp({ url: url.toString() });
  }

  if (crmType === "pipedrive") {
    const clientId    = Deno.env.get("PIPEDRIVE_CLIENT_ID");
    if (!clientId) return resp({ error: "PIPEDRIVE_CLIENT_ID not configured" }, 500);
    const redirectUri = `${callbackBase()}?action=callback`;
    const url = new URL(PIPEDRIVE_AUTHORIZE_URL);
    url.searchParams.set("client_id",    clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state",        state);
    return resp({ url: url.toString() });
  }

  if (crmType === "salesforce") {
    const clientId = Deno.env.get("SALESFORCE_CLIENT_ID");
    if (!clientId) return resp({ error: "SALESFORCE_CLIENT_ID not configured" }, 500);
    const redirectUri = `${callbackBase()}?action=callback`;
    const url = new URL(SALESFORCE_AUTHORIZE_URL);
    url.searchParams.set("client_id",     clientId);
    url.searchParams.set("redirect_uri",  redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope",         "api refresh_token offline_access");
    url.searchParams.set("state",         state);
    return resp({ url: url.toString() });
  }

  if (crmType === "zoho") {
    const clientId = Deno.env.get("ZOHO_CLIENT_ID");
    if (!clientId) return resp({ error: "ZOHO_CLIENT_ID not configured" }, 500);
    const redirectUri = `${callbackBase()}?action=callback`;
    const url = new URL(ZOHO_AUTHORIZE_URL);
    url.searchParams.set("client_id",     clientId);
    url.searchParams.set("redirect_uri",  redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope",         "ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.deals.ALL,ZohoCRM.modules.activities.ALL,ZohoCRM.modules.tasks.ALL");
    url.searchParams.set("access_type",   "offline");
    url.searchParams.set("state",         state);
    return resp({ url: url.toString() });
  }

  return resp({ error: `OAuth not supported for crm_type: ${crmType}` }, 400);
}

// ── Action: callback (GET — no JWT, HMAC-verified state) ──────────────────────

async function oauthCallback(url: URL): Promise<Response> {
  const code      = url.searchParams.get("code");
  const stateB64  = url.searchParams.get("state");
  const error     = url.searchParams.get("error");

  const frontendBase = Deno.env.get("FRONTEND_URL") ?? "https://www.getsalescloser.com";

  if (error || !code || !stateB64) {
    return Response.redirect(`${frontendBase}/crm.html?crm_error=${encodeURIComponent(error ?? "missing_code")}`);
  }

  const stateData = await verifyOAuthState(stateB64);
  if (!stateData) {
    return Response.redirect(`${frontendBase}/crm.html?crm_error=invalid_state`);
  }

  const { orgId, crmType } = stateData;
  const redirectUri = `${callbackBase()}?action=callback`;
  const sb          = getServiceSupabaseClient();

  if (crmType === "hubspot") {
    const clientId     = Deno.env.get("HUBSPOT_CLIENT_ID");
    const clientSecret = Deno.env.get("HUBSPOT_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=server_misconfigured`);
    }

    const tokenRes = await fetch(HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();
    const authObj = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in ?? 1800) * 1000,
      hub_id:        String(tokens.hub_id ?? ""),
    };

    const encrypted = await encryptCrmAuth(authObj);

    // Upsert crm_destination (one per org per crm_type)
    const { error: upsertErr } = await sb.from("crm_destinations").upsert({
      org_id:              orgId,
      crm_type:            "hubspot",
      is_active:           true,
      priority:            100,
      config_json:         {},
      auth_json_encrypted: encrypted,
      health_status:       "healthy",
      updated_at:          new Date().toISOString(),
    }, { onConflict: "org_id,crm_type" });

    if (upsertErr) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=save_failed`);
    }

    return Response.redirect(`${frontendBase}/crm.html?crm_connected=hubspot`);
  }

  if (crmType === "pipedrive") {
    const clientId     = Deno.env.get("PIPEDRIVE_CLIENT_ID");
    const clientSecret = Deno.env.get("PIPEDRIVE_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=server_misconfigured`);
    }

    const tokenRes = await fetch(PIPEDRIVE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    }

    const tokens = await tokenRes.json();
    const authObj = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
      api_domain:    tokens.api_domain ?? "api.pipedrive.com",
    };

    const encrypted = await encryptCrmAuth(authObj);

    const { error: upsertErr } = await sb.from("crm_destinations").upsert({
      org_id:              orgId,
      crm_type:            "pipedrive",
      is_active:           true,
      priority:            100,
      config_json:         {},
      auth_json_encrypted: encrypted,
      health_status:       "healthy",
      updated_at:          new Date().toISOString(),
    }, { onConflict: "org_id,crm_type" });

    if (upsertErr) {
      return Response.redirect(`${frontendBase}/crm.html?crm_error=save_failed`);
    }

    return Response.redirect(`${frontendBase}/crm.html?crm_connected=pipedrive`);
  }

  if (crmType === "salesforce") {
    const clientId     = Deno.env.get("SALESFORCE_CLIENT_ID");
    const clientSecret = Deno.env.get("SALESFORCE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return Response.redirect(`${frontendBase}/crm.html?crm_error=server_misconfigured`);
    const tokenRes = await fetch(SALESFORCE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code }).toString(),
    });
    if (!tokenRes.ok) return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    const authObj = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, instance_url: tokens.instance_url, expires_at: Date.now() + 7200 * 1000 };
    const encrypted = await encryptCrmAuth(authObj);
    const { error: upsertErr } = await sb.from("crm_destinations").upsert({ org_id: orgId, crm_type: "salesforce", is_active: true, priority: 100, config_json: {}, auth_json_encrypted: encrypted, health_status: "healthy", updated_at: new Date().toISOString() }, { onConflict: "org_id,crm_type" });
    if (upsertErr) return Response.redirect(`${frontendBase}/crm.html?crm_error=save_failed`);
    return Response.redirect(`${frontendBase}/crm.html?crm_connected=salesforce`);
  }

  if (crmType === "zoho") {
    const clientId     = Deno.env.get("ZOHO_CLIENT_ID");
    const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
    if (!clientId || !clientSecret) return Response.redirect(`${frontendBase}/crm.html?crm_error=server_misconfigured`);
    const tokenRes = await fetch(ZOHO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code }).toString(),
    });
    if (!tokenRes.ok) return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    const tokens = await tokenRes.json();
    if (tokens.error || !tokens.access_token) return Response.redirect(`${frontendBase}/crm.html?crm_error=token_exchange_failed`);
    const authObj = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, api_domain: tokens.api_domain ?? "www.zohoapis.com", accounts_server: "https://accounts.zoho.com", expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
    const encrypted = await encryptCrmAuth(authObj);
    const { error: upsertErr } = await sb.from("crm_destinations").upsert({ org_id: orgId, crm_type: "zoho", is_active: true, priority: 100, config_json: {}, auth_json_encrypted: encrypted, health_status: "healthy", updated_at: new Date().toISOString() }, { onConflict: "org_id,crm_type" });
    if (upsertErr) return Response.redirect(`${frontendBase}/crm.html?crm_error=save_failed`);
    return Response.redirect(`${frontendBase}/crm.html?crm_connected=zoho`);
  }

  return Response.redirect(`${frontendBase}/crm.html?crm_error=unsupported_crm`);
}

// ── Action: save_api_key (Pipedrive API key mode) ─────────────────────────────

async function saveApiKey(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const { crm_type, api_key, api_domain } = body;
  if (crm_type !== "pipedrive") return resp({ error: "api_key auth only supported for pipedrive" }, 400);
  if (!api_key) return resp({ error: "api_key is required" }, 400);

  const authObj = {
    api_token:   String(api_key),
    access_token: "",
    api_domain:  String(api_domain ?? "api.pipedrive.com"),
  };

  // Validate the key with a lightweight call
  const testUrl = `https://${authObj.api_domain}/v1/users/me?api_token=${encodeURIComponent(authObj.api_token)}`;
  const testRes = await fetch(testUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!testRes?.ok) return resp({ error: "Invalid Pipedrive API key or domain" }, 400);

  const encrypted = await encryptCrmAuth(authObj);
  const sb = getServiceSupabaseClient();

  const { error: upsertErr } = await sb.from("crm_destinations").upsert({
    org_id:              orgId,
    crm_type:            "pipedrive",
    is_active:           true,
    priority:            100,
    config_json:         {},
    auth_json_encrypted: encrypted,
    health_status:       "healthy",
    updated_at:          new Date().toISOString(),
  }, { onConflict: "org_id,crm_type" });

  if (upsertErr) return resp({ error: "Failed to save", detail: upsertErr.message }, 500);
  return resp({ success: true, message: "Pipedrive API key saved and verified" });
}

// ── Action: disconnect ─────────────────────────────────────────────────────────

async function disconnect(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const { crm_type } = body;
  if (!crm_type) return resp({ error: "crm_type required" }, 400);
  const sb = getServiceSupabaseClient();
  await sb.from("crm_destinations").delete()
    .eq("org_id", orgId).eq("crm_type", String(crm_type));
  return resp({ success: true });
}

// ── Action: test_connection ────────────────────────────────────────────────────

async function testConnection(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const { crm_type } = body;
  if (!crm_type) return resp({ error: "crm_type required" }, 400);
  const sb = getServiceSupabaseClient();

  const { data: dest } = await sb.from("crm_destinations")
    .select("auth_json_encrypted, crm_type")
    .eq("org_id", orgId).eq("crm_type", String(crm_type)).maybeSingle();

  if (!dest?.auth_json_encrypted) return resp({ error: "No connection found" }, 404);

  let auth: Record<string, unknown>;
  try {
    auth = await decryptCrmAuth(dest.auth_json_encrypted);
  } catch {
    return resp({ success: false, error: "Token decryption failed — reconnect required" });
  }

  if (crm_type === "hubspot") {
    const res = await fetch("https://api.hubapi.com/oauth/v1/access-tokens/" + encodeURIComponent(String(auth.access_token)), {
      headers: { "Authorization": `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    return resp({ success: !!res?.ok, status: res?.status ?? 0 });
  }

  if (crm_type === "pipedrive") {
    const domain = auth.api_domain ?? "api.pipedrive.com";
    const isApiKey = !!auth.api_token;
    const url = isApiKey
      ? `https://${domain}/v1/users/me?api_token=${encodeURIComponent(String(auth.api_token))}`
      : `https://${domain}/v1/users/me`;
    const headers: Record<string, string> = isApiKey ? {} : { Authorization: `Bearer ${auth.access_token}` };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
    return resp({ success: !!res?.ok, status: res?.status ?? 0 });
  }

  if (crm_type === "salesforce") {
    const res = await fetch(`${auth.instance_url}/services/data/v59.0/limits`, {
      headers: { "Authorization": `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    return resp({ success: !!res?.ok, status: res?.status ?? 0 });
  }

  if (crm_type === "zoho") {
    const res = await fetch(`https://${auth.api_domain}/crm/v6/org`, {
      headers: { "Authorization": `Zoho-oauthtoken ${auth.access_token}` },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    return resp({ success: !!res?.ok, status: res?.status ?? 0 });
  }

  return resp({ error: `Test not implemented for ${crm_type}` }, 400);
}

// ── Action: update_field_mappings ──────────────────────────────────────────────

async function updateFieldMappings(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const { crm_type, field_mappings } = body;
  if (!crm_type || !field_mappings) return resp({ error: "crm_type and field_mappings required" }, 400);

  const sb = getServiceSupabaseClient();
  const { data: dest } = await sb.from("crm_destinations")
    .select("id, config_json").eq("org_id", orgId).eq("crm_type", String(crm_type)).maybeSingle();
  if (!dest) return resp({ error: "Destination not found" }, 404);

  const newConfig = { ...(dest.config_json ?? {}), field_mappings };
  const { error } = await sb.from("crm_destinations")
    .update({ config_json: newConfig, updated_at: new Date().toISOString() }).eq("id", dest.id);
  if (error) return resp({ error: error.message }, 500);
  return resp({ success: true });
}

// ── Action: get_destinations ───────────────────────────────────────────────────

async function getDestinations(orgId: string): Promise<Response> {
  const sb = getServiceSupabaseClient();
  const { data, error } = await sb.from("crm_destinations")
    .select("id, crm_type, is_active, priority, config_json, health_status, last_sync_at, created_at")
    .eq("org_id", orgId)
    .order("priority", { ascending: true });
  if (error) return resp({ error: error.message }, 500);
  return resp({ destinations: data ?? [] });
}

// ── Action: retry_event ────────────────────────────────────────────────────────

async function retryEvent(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const { event_id } = body;
  if (!event_id) return resp({ error: "event_id required" }, 400);
  const sb = getServiceSupabaseClient();
  const { data, error } = await sb.rpc("retry_crm_sync_event", {
    p_event_id: String(event_id),
    p_org_id:   orgId,
  });
  if (error) return resp({ error: error.message }, 500);
  return resp({ success: !!data });
}

// ── Action: get_sync_stats ─────────────────────────────────────────────────────

async function getSyncStats(orgId: string): Promise<Response> {
  const sb = getServiceSupabaseClient();
  const { data, error } = await sb.rpc("get_crm_sync_stats", { p_org_id: orgId });
  if (error) return resp({ error: error.message }, 500);
  return resp({ stats: data ?? {} });
}

// ── Action: get_sync_logs ──────────────────────────────────────────────────────

async function getSyncLogs(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const limit = Number(body.limit ?? 50);
  const sb = getServiceSupabaseClient();
  const { data, error } = await sb.rpc("get_crm_sync_logs", { p_org_id: orgId, p_limit: limit });
  if (error) return resp({ error: error.message }, 500);
  return resp({ logs: data ?? [] });
}

// ── Action: get_failed_events ──────────────────────────────────────────────────

async function getFailedEvents(orgId: string, body: Record<string, unknown>): Promise<Response> {
  const limit = Number(body.limit ?? 25);
  const sb = getServiceSupabaseClient();
  const { data, error } = await sb.rpc("get_failed_crm_events", { p_org_id: orgId, p_limit: limit });
  if (error) return resp({ error: error.message }, 500);
  return resp({ events: data ?? [] });
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);

  // OAuth callback is a GET redirect — no JWT required, HMAC-verified state instead
  if (req.method === "GET" && url.searchParams.get("action") === "callback") {
    return oauthCallback(url);
  }

  if (req.method !== "POST") return resp({ error: "Method not allowed" }, 405);

  // All POST routes require user JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return resp({ error: "Authorization required" }, 401);

  const resolved = await resolveOrgId(jwt);
  if (!resolved) return resp({ error: "Invalid session or no org membership" }, 401);
  const { orgId } = resolved;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return resp({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action ?? "");

  switch (action) {
    case "authorize_url":       return authorizeUrl(orgId, String(body.crm_type ?? ""));
    case "save_api_key":        return saveApiKey(orgId, body);
    case "disconnect":          return disconnect(orgId, body);
    case "test_connection":     return testConnection(orgId, body);
    case "update_field_mappings": return updateFieldMappings(orgId, body);
    case "get_destinations":    return getDestinations(orgId);
    case "retry_event":         return retryEvent(orgId, body);
    case "get_sync_stats":      return getSyncStats(orgId);
    case "get_sync_logs":       return getSyncLogs(orgId, body);
    case "get_failed_events":   return getFailedEvents(orgId, body);
    default:
      return resp({ error: `Unknown action: ${action}` }, 400);
  }
});
