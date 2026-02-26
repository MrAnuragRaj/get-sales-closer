import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

function getEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

type ChannelType = "sms" | "voice";

type Body = {
  org_id: string;
  channel: ChannelType;
  org_channel_id: string;
};

function parseBody(x: any): Body {
  const org_id = String(x?.org_id ?? "").trim();
  const channel = String(x?.channel ?? "").trim() as ChannelType;
  const org_channel_id = String(x?.org_channel_id ?? "").trim();

  if (!org_id) throw new Error("org_id required");
  if (channel !== "sms" && channel !== "voice") throw new Error("channel must be sms|voice");
  if (!org_channel_id) throw new Error("org_channel_id required");

  return { org_id, channel, org_channel_id };
}

function getAuthedClient(req: Request) {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_ANON_KEY = getEnv("SUPABASE_ANON_KEY");

  const authHeader = req.headers.get("authorization") ?? "";
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

function getServiceClient() {
  // Prefer your project-specific secret if you use it; fall back to SUPABASE_SERVICE_ROLE_KEY
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SERVICE_KEY =
    Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";

  if (!SERVICE_KEY) throw new Error("Missing env: GSC_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY");

  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });

  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const body = await req.json().catch(() => ({}));
    const { org_id, channel, org_channel_id } = parseBody(body);

    // 1) AuthZ: caller must be org admin/owner (checked using caller JWT)
    const authed = getAuthedClient(req);
    const { data: adminRows, error: adminErr } = await authed.rpc("is_org_admin_or_owner", {
      p_org_id: org_id,
    } as any);

    if (adminErr) {
      return json(403, { ok: false, error: "AUTHZ_FAILED", detail: adminErr.message });
    }

    const isAdmin = Array.isArray(adminRows) ? !!adminRows?.[0] : !!adminRows;
    if (!isAdmin) {
      return json(403, { ok: false, error: "NOT_ORG_ADMIN" });
    }

    // 2) Write with service role (bypasses RLS safely)
    const svc = getServiceClient();

    // 2.1) Validate channel row exists + belongs to org + matches channel + is active
    const { data: row, error: rowErr } = await svc
      .from("org_channels")
      .select("id, org_id, channel, status, is_default")
      .eq("id", org_channel_id)
      .maybeSingle();

    if (rowErr) return json(500, { ok: false, error: "DB_READ_FAILED", detail: rowErr.message });
    if (!row) return json(404, { ok: false, error: "ORG_CHANNEL_NOT_FOUND" });
    if (row.org_id !== org_id) return json(403, { ok: false, error: "ORG_CHANNEL_WRONG_ORG" });
    if (row.channel !== channel) return json(400, { ok: false, error: "ORG_CHANNEL_WRONG_CHANNEL" });
    if (row.status !== "active") return json(400, { ok: false, error: "ORG_CHANNEL_NOT_ACTIVE" });

    // 2.2) Clear existing default(s) for this org+channel
    const { error: clearErr } = await svc
      .from("org_channels")
      .update({ is_default: false })
      .eq("org_id", org_id)
      .eq("channel", channel)
      .eq("is_default", true);

    if (clearErr) return json(500, { ok: false, error: "CLEAR_DEFAULT_FAILED", detail: clearErr.message });

    // 2.3) Set this one as default
    const { error: setErr } = await svc
      .from("org_channels")
      .update({ is_default: true })
      .eq("id", org_channel_id);

    if (setErr) return json(500, { ok: false, error: "SET_DEFAULT_FAILED", detail: setErr.message });

    // 3) Return effective channel (org default if present, else platform)
    const { data: eff, error: effErr } = await svc.rpc("resolve_org_channel_v1", {
      p_org_id: org_id,
      p_channel: channel,
    } as any);

    if (effErr) {
      return json(200, {
        ok: true,
        status: "updated",
        effective: null,
        warning: "EFFECTIVE_RESOLVE_FAILED",
        warning_detail: effErr.message,
      });
    }

    return json(200, {
      ok: true,
      status: "updated",
      org_id,
      channel,
      org_channel_id,
      effective: eff?.[0]?.resolve_org_channel_v1 ?? eff,
    });
  } catch (e) {
    return json(500, { ok: false, error: "INTERNAL_ERROR", detail: String(e?.message ?? e) });
  }
});