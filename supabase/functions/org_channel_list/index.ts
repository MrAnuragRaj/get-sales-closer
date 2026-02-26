import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

type Channel = "sms" | "voice";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function success(data: any) {
  return json(200, { ok: true, data, error: null });
}

function failure(status: number, code: string, message: string, detail?: string) {
  return json(status, {
    ok: false,
    data: null,
    error: { code, message, detail: detail ?? null },
  });
}

function getBearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  try {
    if (req.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", "GET required");

    const jwt = getBearer(req);
    if (!jwt) return failure(401, "MISSING_AUTH", "Authorization header required");

    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userRes?.user?.id) return failure(401, "INVALID_AUTH", "Invalid user token");

    const url = new URL(req.url);
    const org_id = String(url.searchParams.get("org_id") ?? "").trim();
    if (!org_id) return failure(400, "ORG_ID_REQUIRED", "org_id required");

    // AuthZ: org member is enough
    const { data: isMember, error: memErr } = await supabase.rpc("is_org_member", { p_org_id: org_id });
    if (memErr) return failure(500, "ORG_MEMBER_CHECK_FAILED", "Membership check failed", memErr.message);
    if (!isMember) return failure(403, "NOT_ORG_MEMBER", "Org membership required");

    // Load org channels (RLS allows member SELECT)
    const { data: rows, error: rowsErr } = await supabase
      .from("org_channels")
      .select(
        "id, org_id, channel, provider, from_e164, twilio_phone_sid, vapi_phone_number_id, capabilities, routing, is_default, status, last_error, created_at, updated_at, created_by, metadata",
      )
      .eq("org_id", org_id)
      .order("channel", { ascending: true })
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });

    if (rowsErr) return failure(500, "DB_READ_FAILED", "Failed to read org_channels", rowsErr.message);

    // Effective resolution (org default if active exists; else platform)
    const [smsRes, voiceRes] = await Promise.all([
      supabase.rpc("resolve_org_channel_v1", { p_org_id: org_id, p_channel: "sms" as Channel }),
      supabase.rpc("resolve_org_channel_v1", { p_org_id: org_id, p_channel: "voice" as Channel }),
    ]);

    const effective_sms = smsRes?.data?.[0]?.resolve_org_channel_v1 ?? smsRes?.data ?? null;
    const effective_voice = voiceRes?.data?.[0]?.resolve_org_channel_v1 ?? voiceRes?.data ?? null;

    return success({
      org_id,
      org_channels: rows ?? [],
      effective: {
        sms: effective_sms,
        voice: effective_voice,
      },
      warnings: {
        resolve_sms_failed: !!smsRes?.error ? smsRes.error.message : null,
        resolve_voice_failed: !!voiceRes?.error ? voiceRes.error.message : null,
      },
    });
  } catch (e: any) {
    return failure(500, "INTERNAL_ERROR", "Unexpected error", String(e?.message ?? e));
  }
});