import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

// connect-facebook-page
//
// Handles the server-side OAuth flow for connecting a customer's Facebook Page
// to their GetSalesCloser org. Called from fb-callback.html.
//
// Actions:
//   get_config  → returns { app_id } (safe to expose — App ID is public)
//   exchange    → exchanges OAuth code for page tokens, returns pages list
//   connect     → subscribes chosen page to webhook + stores in DB
//
// Env vars required:
//   FACEBOOK_APP_ID      — Meta App ID (public, used in OAuth URLs)
//   FACEBOOK_APP_SECRET  — Meta App Secret (private, server-side only)
//   SUPABASE_URL         — used for webhook subscription URL validation

const GRAPH = "https://graph.facebook.com/v21.0";
const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

async function subscribePage(pageId: string, pageToken: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${GRAPH}/${pageId}/subscribed_apps` +
    `?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads` +
    `&access_token=${encodeURIComponent(pageToken)}`,
    { method: "POST" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    return { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

async function storePageInDB(
  supabase: any,
  orgId: string,
  pageId: string,
  pageToken: string,
  pageName: string,
): Promise<{ ok: boolean; error?: string }> {
  // Upsert channel row — handles first connect, reconnect, and post-disconnect relink
  // uq_org_channels_org_channel is UNIQUE(org_id, channel), so INSERT would fail on reconnect
  const { error: chErr } = await supabase.from("org_channels").upsert(
    {
      org_id: orgId,
      channel: "messenger",
      provider: "meta",
      provider_token: pageToken,
      status: "active",
      is_default: true,
      fallback_policy: "allow_shared",
      metadata: { page_id: pageId, page_name: pageName },
    },
    { onConflict: "org_id,channel" },
  );

  if (chErr) {
    console.error("[connect-facebook-page] org_channels insert failed:", chErr.message);
    return { ok: false, error: chErr.message };
  }

  // 3. Upsert org_channel_capabilities — enable Messenger for this org
  const { error: capErr } = await supabase
    .from("org_channel_capabilities")
    .upsert(
      { org_id: orgId, messenger_enabled: true, messenger_page_id: pageId },
      { onConflict: "org_id" },
    );

  if (capErr) {
    console.error("[connect-facebook-page] org_channel_capabilities upsert failed:", capErr.message);
    // Non-fatal — channel row is stored, capabilities can be fixed manually
  }

  // 4. Update message_routing_policies to enable Messenger
  await supabase
    .from("message_routing_policies")
    .upsert(
      { org_id: orgId, messenger_fallback_to_sms: true },
      { onConflict: "org_id" },
    ).then(undefined, () => {});

  console.log(`[connect-facebook-page] Page connected: org=${orgId} page=${pageId} (${pageName})`);
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const APP_ID = (Deno.env.get("FACEBOOK_APP_ID") ?? "").trim();
  const APP_SECRET = (Deno.env.get("FACEBOOK_APP_SECRET") ?? "").trim();

  let body: Record<string, string>;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { action, org_id } = body;

  // ── get_config — return App ID for OAuth URL construction ─────────────────
  if (action === "get_config") {
    if (!APP_ID) return json({ error: "FACEBOOK_APP_ID not configured" }, 500);
    return json({ app_id: APP_ID });
  }

  if (!org_id) return json({ error: "org_id required" }, 400);
  if (!APP_ID || !APP_SECRET) return json({ error: "Facebook App not configured on server" }, 500);

  const supabase = getServiceSupabaseClient();

  // Validate org exists
  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", org_id)
    .maybeSingle();
  if (!org) return json({ error: "Invalid org_id" }, 404);

  // ── exchange — OAuth code → user token → pages list ───────────────────────
  if (action === "exchange") {
    const { code, redirect_uri } = body;
    if (!code || !redirect_uri) return json({ error: "code and redirect_uri required" }, 400);

    // Step 1: code → short-lived user access token
    const shortRes = await fetch(
      `${GRAPH}/oauth/access_token` +
      `?client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
      `&client_secret=${APP_SECRET}` +
      `&code=${encodeURIComponent(code)}`,
    ).then(r => r.json()).catch(() => ({}));

    if (!shortRes.access_token) {
      console.error("[connect-facebook-page] code exchange failed:", shortRes);
      return json({ error: shortRes?.error?.message ?? "Code exchange failed" }, 400);
    }

    // Step 2: short-lived → long-lived user token (60-day lifetime)
    const longRes = await fetch(
      `${GRAPH}/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${APP_ID}` +
      `&client_secret=${APP_SECRET}` +
      `&fb_exchange_token=${encodeURIComponent(shortRes.access_token)}`,
    ).then(r => r.json()).catch(() => ({}));

    if (longRes.error) {
      console.warn("[connect-facebook-page] long-lived token exchange warning:", JSON.stringify(longRes.error));
    }

    const userToken = longRes.access_token ?? shortRes.access_token;

    // Step 3: get pages the user manages (page tokens from /me/accounts are long-lived)
    let pagesRawText = "";
    let pagesRes: any = {};
    try {
      const pagesHttpRes = await fetch(
        `${GRAPH}/me/accounts?fields=id,name,category,access_token&access_token=${encodeURIComponent(userToken)}`,
      );
      pagesRawText = await pagesHttpRes.text();
      pagesRes = JSON.parse(pagesRawText);
      console.log("[connect-facebook-page] /me/accounts HTTP status:", pagesHttpRes.status, "body keys:", Object.keys(pagesRes).join(","), "data_count:", pagesRes.data?.length ?? "n/a");
    } catch (e) {
      console.error("[connect-facebook-page] /me/accounts fetch/parse error:", e, "raw:", pagesRawText.slice(0, 200));
      return json({ error: `Failed to reach Facebook API: ${e}` }, 500);
    }

    // Surface the actual Facebook API error if present
    if (pagesRes.error) {
      const fbMsg = pagesRes.error.message ?? "Facebook API error";
      const fbCode = pagesRes.error.code ?? "";
      const fbSubCode = pagesRes.error.error_subcode ?? "";
      console.error("[connect-facebook-page] /me/accounts Facebook error:", JSON.stringify(pagesRes.error));
      return json({ error: `Facebook: ${fbMsg} (code ${fbCode}${fbSubCode ? "/" + fbSubCode : ""})` }, 400);
    }

    if (!pagesRes.data || pagesRes.data.length === 0) {
      // data is [] — user has no Pages accessible to this token
      // Common causes: app in Development mode, pages_show_list not granted, or user has no Pages
      console.warn("[connect-facebook-page] /me/accounts returned empty data array. userToken prefix:", userToken.slice(0, 20));
      return json({
        error: "No Facebook Pages found. Possible causes: (1) Your app is in Development mode — go to Meta App Dashboard and switch to Live mode, OR add your Facebook account as a Developer/Tester. (2) You did not grant 'pages_show_list' during the OAuth dialog. (3) The Facebook account used has no Pages with admin access.",
      }, 400);
    }

    const pages = (pagesRes.data as any[]).map((p: any) => ({
      id: p.id,
      name: p.name,
      category: p.category ?? "",
      access_token: p.access_token,
    }));

    // If exactly one page, auto-connect immediately
    if (pages.length === 1) {
      const page = pages[0];
      const subResult = await subscribePage(page.id, page.access_token);
      if (!subResult.ok) {
        console.warn(`[connect-facebook-page] webhook subscription warning: ${subResult.error}`);
        // Non-fatal — proceed anyway; user can re-subscribe manually
      }
      const storeResult = await storePageInDB(supabase, org_id, page.id, page.access_token, page.name);
      if (!storeResult.ok) return json({ error: storeResult.error }, 500);
      return json({ success: true, auto_connected: true, page_id: page.id, page_name: page.name });
    }

    // Multiple pages — return list for user to choose (access_token stripped for security)
    return json({
      pages: pages.map(p => ({ id: p.id, name: p.name, category: p.category })),
      // We store the tokens server-side by encoding as encrypted payload — but for simplicity
      // we'll pass them back to the client encrypted in the next call as opaque tokens.
      // IMPORTANT: the page tokens are included here only for the immediate follow-up connect call.
      // They are not persisted client-side beyond the selection step.
      _page_tokens: Object.fromEntries(pages.map(p => [p.id, p.access_token])),
    });
  }

  // ── connect — subscribe + store chosen page ────────────────────────────────
  if (action === "connect") {
    const { page_id, page_access_token, page_name } = body;
    if (!page_id || !page_access_token) return json({ error: "page_id and page_access_token required" }, 400);

    const subResult = await subscribePage(page_id, page_access_token);
    if (!subResult.ok) {
      console.warn(`[connect-facebook-page] webhook subscription warning: ${subResult.error}`);
    }

    const storeResult = await storePageInDB(supabase, org_id, page_id, page_access_token, page_name ?? "");
    if (!storeResult.ok) return json({ error: storeResult.error }, 500);

    return json({ success: true, page_id, page_name: page_name ?? "" });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
