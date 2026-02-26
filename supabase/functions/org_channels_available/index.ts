import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireAuth(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return { ok: false as const, error: "MISSING_AUTH" };
  return { ok: true as const };
}

async function twilioRequest(path: string, method: string, body?: URLSearchParams) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  if (!sid || !token) throw new Error("TWILIO_NOT_CONFIGURED");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`;
  const basic = btoa(`${sid}:${token}`);

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? body.toString() : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`TWILIO_FAILED:${resp.status}:${text}`);
  return JSON.parse(text);
}

serve(async (req) => {
  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const a = requireAuth(req);
    if (!a.ok) return json(401, { ok: false, error: a.error });

    const supabase = getSupabaseClient(req);

    const body = await req.json().catch(() => ({}));
    const org_id = String(body.org_id ?? "").trim();
    const country = String(body.country ?? "US").trim().toUpperCase();
    const area_code = String(body.area_code ?? "").trim();
    const sms = Boolean(body.sms ?? true);
    const voice = Boolean(body.voice ?? true);
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? 10)));

    if (!org_id) return json(400, { ok: false, error: "org_id required" });

    // Membership check (admin not required for searching, member is OK)
    const { data: mem } = await supabase.rpc("is_org_member", { p_org_id: org_id }).catch(() => ({ data: null }));
    // Your is_org_member signature is is_org_member(uuid) => boolean
    // RPC wrapper in supabase-js returns {data}. We'll accept fail-safe:
    if (mem === false) return json(403, { ok: false, error: "NOT_ORG_MEMBER" });

    // Twilio available numbers endpoint:
    // /AvailablePhoneNumbers/{Country}/Local.json?SmsEnabled=true&VoiceEnabled=true&AreaCode=...
    // NOTE: this uses Twilio 2010 API base but different path:
    // We'll call directly without account prefix:
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    if (!sid || !token) return json(500, { ok: false, error: "TWILIO_NOT_CONFIGURED" });

    const basic = btoa(`${sid}:${token}`);
    const qs = new URLSearchParams();
    if (sms) qs.set("SmsEnabled", "true");
    if (voice) qs.set("VoiceEnabled", "true");
    if (area_code) qs.set("AreaCode", area_code);
    qs.set("PageSize", String(limit));

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${country}/Local.json?${qs.toString()}`;
    const resp = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
    const text = await resp.text();
    if (!resp.ok) return json(502, { ok: false, error: "TWILIO_AVAILABLE_QUERY_FAILED", detail: text });

    const data = JSON.parse(text);
    const numbers = (data?.available_phone_numbers ?? []).map((n: any) => ({
      friendly_name: n.friendly_name ?? null,
      phone_number: n.phone_number ?? null, // E.164
      locality: n.locality ?? null,
      region: n.region ?? null,
      iso_country: n.iso_country ?? country,
      capabilities: n.capabilities ?? {},
    }));

    return json(200, { ok: true, numbers });
  } catch (e) {
    return json(500, { ok: false, error: "INTERNAL_ERROR", detail: String(e?.message ?? e) });
  }
});
