/**
 * growth-flag-proxy
 *
 * Secure server-side proxy for Growth Engine feature flag management.
 *
 * Why this exists:
 *   The Growth Engine internal routes are gated by X-Internal-Secret.
 *   That secret must never appear in client-side JS (admin.html).
 *   This function holds the secret as a Supabase environment secret and
 *   proxies flag read/toggle requests from the admin UI server-to-server.
 *
 * Auth:
 *   Caller must be authenticated and have profiles.is_admin = true.
 *   Any other user receives 403.
 *
 * Required Supabase secrets (set via supabase secrets set):
 *   GROWTH_ENGINE_URL              — Railway URL e.g. https://your-engine.railway.app
 *   GROWTH_ENGINE_INTERNAL_SECRET  — matches INTERNAL_SWEEP_SECRET on Railway
 *
 * Routes proxied:
 *   GET  /growth-flag-proxy          → GET  /internal/feature-flags
 *   POST /growth-flag-proxy          → POST /internal/feature-flags/{key}
 *     body: { key: string, enabled: boolean }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROWTH_ENGINE_URL      = Deno.env.get("GROWTH_ENGINE_URL") ?? "";
const GROWTH_ENGINE_SECRET   = Deno.env.get("GROWTH_ENGINE_INTERNAL_SECRET") ?? "";
const SUPABASE_URL           = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  // ── Verify admin JWT ────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }
  const jwt = authHeader.slice(7);

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) {
    return json({ error: "Invalid or expired token" }, 401);
  }

  // Check is_admin
  const { data: profile } = await sb
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) {
    return json({ error: "Admin access required" }, 403);
  }

  // ── Config check ────────────────────────────────────────────────────────────
  if (!GROWTH_ENGINE_URL || !GROWTH_ENGINE_SECRET) {
    return json({ error: "Growth Engine not configured on this deployment" }, 503);
  }

  // ── Proxy ────────────────────────────────────────────────────────────────────
  try {
    if (req.method === "GET") {
      // List all flags
      const upstream = await fetch(`${GROWTH_ENGINE_URL}/internal/feature-flags`, {
        headers: { "X-Internal-Secret": GROWTH_ENGINE_SECRET },
      });
      const data = await upstream.json();
      return json(data, upstream.status);

    } else if (req.method === "POST") {
      // Toggle a flag
      const body = await req.json();
      const { key, enabled } = body;

      if (!key || typeof enabled !== "boolean") {
        return json({ error: "body must include key (string) and enabled (boolean)" }, 422);
      }

      const upstream = await fetch(`${GROWTH_ENGINE_URL}/internal/feature-flags/${key}`, {
        method:  "POST",
        headers: {
          "X-Internal-Secret": GROWTH_ENGINE_SECRET,
          "Content-Type":      "application/json",
        },
        body: JSON.stringify({
          enabled,
          updated_by_user_id: user.id,
        }),
      });
      const data = await upstream.json();
      return json(data, upstream.status);

    } else {
      return json({ error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json({ error: "Growth Engine unreachable", detail: String(err) }, 502);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
