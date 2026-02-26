import { serve } from "https://deno.land/std/http/server.ts";
import { getUserSupabaseClient, getServiceSupabaseClient } from "../_shared/db.ts";

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
  return json(status, { ok: false, data: null, error: { code, message, detail: detail ?? null } });
}

function getBearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function normalizeE164(x: string): string {
  const s = String(x ?? "").trim();
  if (!/^\+\d{8,15}$/.test(s)) throw new Error("INVALID_FROM_E164");
  return s;
}

function requireJson(req: Request) {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) throw new Error("UNSUPPORTED_CONTENT_TYPE");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len && len > 32_000) throw new Error("PAYLOAD_TOO_LARGE");
}

async function enforceRateLimitViaRpc(
  svc: any,
  args: { org_id: string; user_id: string; action: string; maxPerHour: number; maxPerDay: number },
) {
  const { org_id, user_id, action, maxPerHour, maxPerDay } = args;

  const { data, error } = await svc.rpc("enforce_rate_limit_v1", {
    p_org_id: org_id,
    p_user_id: user_id,
    p_action: action,
    p_max_per_hour: maxPerHour,
    p_max_per_day: maxPerDay,
  });

  if (error) throw new Error(`RATE_LIMIT_RPC_ERROR:${error.message}`);

  // expected: { ok: true } or { ok:false, code:'...' }
  const res = (data?.enforce_rate_limit_v1 ?? data) as any;
  if (!res?.ok) {
    const code = String(res?.code ?? "RATE_LIMITED");
    if (code.includes("HOURLY")) throw new Error("RATE_LIMIT_HOURLY_EXCEEDED");
    if (code.includes("DAILY")) throw new Error("RATE_LIMIT_DAILY_EXCEEDED");
    throw new Error(code);
  }
}

serve(async (req) => {
  const supabase = getUserSupabaseClient(req); // RLS enforced
  const svc = getServiceSupabaseClient();      // privileged RPC only

  try {
    if (req.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "POST required");
    requireJson(req);

    const jwt = getBearer(req);
    if (!jwt) return failure(401, "MISSING_AUTH", "Authorization header required");

    // validate JWT (works with anon client; also fine with service, but we keep it user)
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userRes?.user?.id) return failure(401, "INVALID_AUTH", "Invalid user token");
    const user_id = userRes.user.id;

    const body = await req.json().catch(() => ({}));

    const org_id = String(body?.org_id ?? "").trim();
    const channel = String(body?.channel ?? "").trim() as Channel;
    const phone_number = String(body?.phone_number ?? "").trim();

    const attach_to_vapi = Boolean(body?.attach_to_vapi ?? (channel === "voice"));
    const set_default = body?.set_default !== false;

    if (!org_id) return failure(400, "ORG_ID_REQUIRED", "org_id required");
    if (channel !== "sms" && channel !== "voice") return failure(400, "INVALID_CHANNEL", "channel must be sms|voice");
    if (!phone_number) return failure(400, "PHONE_NUMBER_REQUIRED", "phone_number required");

    const normalized = normalizeE164(phone_number);

    const providedKey = String(body?.idempotency_key ?? "").trim();
    const idempotency_key = providedKey || `purchase:${org_id}:${channel}:${normalized}`;
    if (idempotency_key.length > 200) return failure(400, "IDEMPOTENCY_KEY_TOO_LONG", "idempotency_key too long");

    // AuthZ: org admin/owner required (RLS safe)
    const { data: isAdmin, error: adminErr } = await supabase.rpc("is_org_admin_or_owner", { p_org_id: org_id });
    if (adminErr) return failure(500, "ORG_ADMIN_CHECK_FAILED", "AuthZ check failed", adminErr.message);
    if (!isAdmin) return failure(403, "NOT_ORG_ADMIN", "Admin access required");

    // Rate limit (single atomic RPC)
    try {
      await enforceRateLimitViaRpc(svc, {
        org_id,
        user_id,
        action: "org_channel_purchase",
        maxPerHour: 5,
        maxPerDay: 20,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg === "RATE_LIMIT_HOURLY_EXCEEDED" || msg === "RATE_LIMIT_DAILY_EXCEEDED" || msg === "RATE_LIMITED") {
        return failure(429, "RATE_LIMITED", "Too many requests", msg);
      }
      return failure(500, "RATE_LIMIT_INTERNAL", "Rate limit enforcement failed", msg);
    }

    // Idempotency lookup (unique constraint exists now)
    const { data: existing, error: exErr } = await supabase
      .from("org_channel_provision_requests")
      .select("*")
      .eq("idempotency_key", idempotency_key)
      .maybeSingle();

    if (exErr) return failure(500, "DB_READ_FAILED", "Failed to read idempotency record", exErr.message);

    if (existing) {
      const { data: resolved } = await supabase.rpc("resolve_org_channel_v1", {
        p_org_id: org_id,
        p_channel: channel,
      });

      return success({
        idempotent: true,
        provision_request_id: existing.id,
        provision_status: existing.status,
        resolved: (resolved as any)?.[0]?.resolve_org_channel_v1 ?? resolved ?? null,
      });
    }

    // Create provisioning request first (audit anchor)
    const { data: provReq, error: provErr } = await supabase
      .from("org_channel_provision_requests")
      .insert({
        org_id,
        created_by: user_id,
        channel,
        mode: "purchase",
        provider: "twilio",
        country: "US",
        requested_from_e164: normalized,
        status: "pending",
        idempotency_key,
        detail: {
          source: "org_channel_purchase",
          input: { phone_number: normalized, channel, attach_to_vapi, set_default },
        },
      })
      .select("*")
      .single();

    if (provErr) return failure(500, "PROVISION_REQUEST_INSERT_FAILED", "Failed to create request", provErr.message);

    // Twilio purchase
    const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      await supabase.from("org_channel_provision_requests").update({
        status: "failed",
        error_code: "TWILIO_NOT_CONFIGURED",
        error_message: "Missing Twilio env",
      }).eq("id", provReq.id);

      return failure(500, "TWILIO_NOT_CONFIGURED", "Twilio credentials missing");
    }
    if (!SUPABASE_URL) {
      await supabase.from("org_channel_provision_requests").update({
        status: "failed",
        error_code: "SUPABASE_URL_MISSING",
        error_message: "Missing SUPABASE_URL env",
      }).eq("id", provReq.id);

      return failure(500, "SUPABASE_URL_MISSING", "SUPABASE_URL missing");
    }

    const smsWebhookUrl = `${SUPABASE_URL}/functions/v1/webhook_inbound?source=twilio`;

    const basic = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const form = new URLSearchParams();
    form.set("PhoneNumber", normalized);
    form.set("SmsUrl", smsWebhookUrl);
    form.set("SmsMethod", "POST");

    const statusCb = (Deno.env.get("TWILIO_STATUS_CALLBACK_URL") ?? "").trim();
    if (statusCb) {
      form.set("StatusCallback", statusCb);
      form.set("StatusCallbackMethod", "POST");
    }

    const twResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );

    const twText = await twResp.text();
    if (!twResp.ok) {
      await supabase.from("org_channel_provision_requests").update({
        status: "failed",
        error_code: "TWILIO_BUY_FAILED",
        error_message: twText,
        detail: { ...(provReq?.detail ?? {}), twilio_error: twText },
      }).eq("id", provReq.id);

      return failure(502, "TWILIO_BUY_FAILED", "Twilio purchase failed", twText);
    }

    const twJson = JSON.parse(twText);
    const twilio_phone_sid = String(twJson?.sid ?? "").trim() || null;

    const provider = attach_to_vapi ? "vapi" : "twilio";

    const { data: ch, error: chErr } = await supabase
      .from("org_channels")
      .upsert(
        {
          org_id,
          channel,
          provider,
          from_e164: normalized,
          twilio_phone_sid,
          vapi_phone_number_id: null,
          capabilities: { sms: channel === "sms", voice: channel === "voice", country: "US" },
          routing: {},
          is_default: set_default,
          status: "active",
          created_by: user_id,
          metadata: {
            provisioned_via: "twilio_purchase",
            purchased_at: new Date().toISOString(),
            provision_request_id: provReq.id,
            twilio: { sid: twilio_phone_sid, raw: twJson },
          },
        },
        { onConflict: "org_id,channel" },
      )
      .select("*")
      .single();

    if (chErr) {
      await supabase.from("org_channel_provision_requests").update({
        status: "failed",
        error_code: "ORG_CHANNEL_UPSERT_FAILED",
        error_message: chErr.message,
        detail: { ...(provReq?.detail ?? {}), twilio_phone_sid },
      }).eq("id", provReq.id);

      return failure(
        500,
        "DB_UPSERT_FAILED_AFTER_TWILIO_PURCHASE",
        "DB write failed after Twilio purchase (manual cleanup may be needed)",
        JSON.stringify({ twilio_phone_sid, db_error: chErr.message }),
      );
    }

    await supabase.from("org_channel_provision_requests").update({
      status: "succeeded",
      twilio_phone_sid,
      requested_from_e164: normalized,
      error_code: null,
      error_message: null,
      detail: { ...(provReq?.detail ?? {}), status: "activated" },
    }).eq("id", provReq.id);

    const { data: resolved } = await supabase.rpc("resolve_org_channel_v1", {
      p_org_id: org_id,
      p_channel: channel,
    });

    return success({
      idempotent: false,
      provision_request_id: provReq.id,
      org_channel: ch,
      resolved: (resolved as any)?.[0]?.resolve_org_channel_v1 ?? resolved ?? null,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);

    if (msg === "INVALID_FROM_E164") return failure(400, "INVALID_FROM_E164", "phone_number must be E.164 (+1...)", msg);
    if (msg === "UNSUPPORTED_CONTENT_TYPE") return failure(415, "UNSUPPORTED_CONTENT_TYPE", "Content-Type must be application/json");
    if (msg === "PAYLOAD_TOO_LARGE") return failure(413, "PAYLOAD_TOO_LARGE", "Payload too large");
    if (msg === "SUPABASE_ANON_KEY_MISSING") return failure(500, "SUPABASE_ANON_KEY_MISSING", "Missing SUPABASE_ANON_KEY");
    if (msg === "SUPABASE_SERVICE_ROLE_KEY_MISSING") return failure(500, "SUPABASE_SERVICE_ROLE_KEY_MISSING", "Missing SUPABASE_SERVICE_ROLE_KEY");

    return failure(500, "INTERNAL_ERROR", "Unexpected error", msg);
  }
});