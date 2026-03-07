import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { replyRouter } from "../_shared/reply_router.ts";
import { ruleBasedIntentClassifier } from "../_shared/intent_rules.ts";

/**
 * Minimal E.164-ish normalization.
 * - Keeps leading '+'
 * - Removes spaces, (), -, etc
 * - If no '+', assumes US default and prefixes '+1'
 * This is NOT full validation; DB routing + lead lookup are your canonical checks.
 */
function normalizeE164Loose(raw: string, defaultCountry: "US" | "IN" = "US"): string {
  if (!raw) return "";
  let s = String(raw).trim();

  // Remove common punctuation
  s = s.replace(/[^\d+]/g, "");

  // If it has multiple +, keep only the first at start
  s = s.replace(/\+/g, "");
  if (raw.trim().startsWith("+")) s = "+" + s;

  // If no +, assume country
  if (!s.startsWith("+")) {
    if (defaultCountry === "US") s = "+1" + s;
    else if (defaultCountry === "IN") s = "+91" + s;
    else s = "+" + s;
  }

  // Very basic sanity: must be + and 8-15 digits (E.164 max 15)
  const digits = s.replace("+", "");
  if (!/^\d{8,15}$/.test(digits)) return s; // return best-effort, don’t crash
  return "+" + digits;
}

function getPublicUrlForTwilio(req: Request): string {
  const u = new URL(req.url);

  const proto = (req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "") ?? "https").trim();
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host).trim();

  // Rebuild canonical external URL
  return `${proto}://${host}${u.pathname}${u.search}`;
}

function requireVapiWebhookToken(url: URL): Response | null {
  const expected = (Deno.env.get("VAPI_WEBHOOK_TOKEN") ?? "").trim();
  const got = (url.searchParams.get("token") ?? "").trim();

  if (!expected) return new Response("VAPI_WEBHOOK_TOKEN not set", { status: 500 });

  if (!got) {
    return new Response(JSON.stringify({ error: "Unauthorized", reason: "missing_token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (got !== expected) {
    // no full token leak: only lengths + last 6 chars
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        reason: "token_mismatch",
        got_len: got.length,
        expected_len: expected.length,
        got_tail6: got.slice(-6),
        expected_tail6: expected.slice(-6),
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}

function pick<T = any>(obj: any, paths: string[], fallback: T): T {
  for (const p of paths) {
    const parts = p.split(".");
    let cur: any = obj;
    let ok = true;
    for (const k of parts) {
      if (cur && typeof cur === "object" && k in cur) cur = cur[k];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined && cur !== null) return cur as T;
  }
  return fallback;
}

async function resolveInboundOrg(
  supabase: any,
  args: {
    provider: "twilio" | "vapi";
    channel: "sms" | "voice";
    to_e164?: string | null;
    provider_number_id?: string | null;
  },
): Promise<{ status: string; source: string | null; org_id: string | null }> {
  const { provider, channel, to_e164, provider_number_id } = args;

  const { data, error } = await supabase.rpc("resolve_inbound_org_channel_v1", {
    p_provider: provider,
    p_channel: channel,
    p_to_e164: to_e164 ?? null,
    p_provider_number_id: provider_number_id ?? null,
  });

  if (error) {
    console.error("resolve_inbound_org_failed", { provider, channel, error: error.message });
    return { status: "error", source: null, org_id: null };
  }

  const res = data as any;
  return {
    status: res?.status ?? "error",
    source: res?.source ?? null,
    org_id: res?.org_id ?? null,
  };
}

/**
 * Twilio signature validation using WebCrypto (Edge-safe).
 * Twilio algorithm:
 *  - baseString = URL + concatenation of (paramName + paramValue) in alphabetical order by paramName
 *  - signature = base64(HMAC-SHA1(auth_token, baseString))
 */
async function twilioComputeSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const keys = Object.keys(params).sort();
  let base = url;
  for (const k of keys) base += k + (params[k] ?? "");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const bytes = new Uint8Array(sigBuf);

  // base64 encode
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time-ish compare for same-length strings
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

const MAX_PAYLOAD_BYTES = 131072; // 128 KB

serve(async (req) => {
  const supabase = getServiceSupabaseClient();
  const url = new URL(req.url);

  // Reject oversized payloads before reading body
  const contentLen = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLen > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const source = url.searchParams.get("source");
    const isTwilio = source === "twilio";
    const isVapi = source === "vapi";

    // Vapi requires shared secret token (deploy webhook with --no-verify-jwt)
    if (isVapi) {
      const deny = requireVapiWebhookToken(url);
      if (deny) return deny;
    }

    let inboundText = "";
    let rawFromPhone = "";
    let rawToPhone = "";
    let channel: "sms" | "voice" | "whatsapp" = "sms";
    let vapiEventType: string | null = null;

    // Vapi hints
    let hintedLeadId: string | null = null;
    let hintedOrgId: string | null = null;
    let hintedTaskId: string | null = null;
    let hintedActor: string | null = null;

    let providerNumberId: string | null = null;

    // -----------------------------
    // TWILIO (SMS)
    // -----------------------------
    if (isTwilio) {
      channel = "sms";

      const TWILIO_TOKEN = (Deno.env.get("TWILIO_AUTH_TOKEN") ?? "").trim();
      if (!TWILIO_TOKEN) return new Response("TWILIO_AUTH_TOKEN not set", { status: 500 });

      const signature = (req.headers.get("X-Twilio-Signature") ?? "").trim();
      if (!signature) return new Response("Unauthorized", { status: 403 });

      const formData = await req.formData().catch(() => null);
      if (!formData) return new Response("OK", { status: 200 });

      const params: Record<string, string> = {};
      formData.forEach((value, key) => (params[key] = value.toString()));

      // Twilio expects the *exact* request URL (no body) used to compute signature.
      // In Supabase Edge, req.url may be internal http; use a proxy-aware public URL.
      const debug = url.searchParams.get("debug") === "1";

      let expected = "";
      let baseTail64 = "";
      let keys: string[] = [];
      let publicUrl = "";

      try {
        // compute signature AND also expose keys/base tail for debug
        const sortedKeys = Object.keys(params).sort();
        keys = sortedKeys;

        // IMPORTANT: Use public URL for both signature and debug base string
        publicUrl = getPublicUrlForTwilio(req);

        let base = publicUrl;
        for (const k of sortedKeys) base += k + (params[k] ?? "");
        baseTail64 = base.slice(-64);

        expected = await twilioComputeSignature(TWILIO_TOKEN, publicUrl, params);
      } catch (e) {
        console.error("twilio_signature_compute_failed", { error: String(e) });
        return new Response("Unauthorized", { status: 403 });
      }

      // ✅ Correct Fix: console.error OUTSIDE JSON, debug base matches signature base.
      if (!timingSafeEqual(signature, expected)) {
        console.error("invalid_twilio_signature", {
          sig_tail6: signature.slice(-6),
          exp_tail6: expected.slice(-6),
          server_url: req.url,
          public_url: publicUrl,
          keys,
        });

        if (debug) {
          return new Response(
            JSON.stringify({
              error: "Unauthorized",
              reason: "twilio_sig_mismatch",
              server_url: req.url,
              public_url: publicUrl,
              keys,
              base_tail64: baseTail64,
              expected_tail6: expected.slice(-6),
              got_tail6: signature.slice(-6),
              params,
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Unauthorized", { status: 403 });
      }

      // ── WhatsApp status callback (has MessageStatus but no Body) ─────────────
      if (params.MessageStatus && !params.Body) {
        const sid = params.MessageSid ?? params.SmsSid ?? null;
        const status = params.MessageStatus; // sent|delivered|read|failed|undelivered

        if (sid) {
          const deliveryStatus = status === "delivered"
            ? "delivered"
            : status === "read"
            ? "read"
            : ["failed", "undelivered"].includes(status)
            ? "failed"
            : "sent";

          const patch: Record<string, any> = { status: deliveryStatus };
          if (status === "delivered") patch.delivered_at = new Date().toISOString();
          if (status === "read") patch.read_at = new Date().toISOString();
          if (["failed", "undelivered"].includes(status)) {
            patch.error_code = `TWILIO_${status.toUpperCase()}`;
            patch.error_message = params.ErrorCode ?? null;
          }

          await supabase
            .from("delivery_attempts")
            .update(patch)
            .eq("provider_message_id", sid)
            .catch(() => {});
        }

        return new Response("OK", { status: 200 });
      }

      // ── Detect WhatsApp inbound (From starts with "whatsapp:") ──────────────
      const isWhatsApp = (params.From ?? "").startsWith("whatsapp:");
      if (isWhatsApp) {
        channel = "whatsapp";
        // Strip "whatsapp:" prefix for E.164 handling below
        rawFromPhone = (params.From ?? "").replace(/^whatsapp:/, "");
        rawToPhone = (params.To ?? "").replace(/^whatsapp:/, "");
        inboundText = params.Body || "";
      } else {
        inboundText = params.Body || "";
        rawFromPhone = params.From || "";
        rawToPhone = params.To || ""; // destination number (tenant routing)
      }
    }

    // -----------------------------
    // VAPI (VOICE)
    // -----------------------------
    else if (isVapi) {
      channel = "voice";

      const json = await req.json().catch(() => ({}));
      vapiEventType = pick<string | null>(json, ["message.type", "type"], null);

      const vv = pick<any>(
        json,
        [
          "message.call.assistantOverrides.variableValues",
          "message.call.variableValues",
          "message.call.metadata.variableValues",
          "message.variableValues",
        ],
        null,
      );

      hintedLeadId = vv?.lead_id ?? null;
      hintedOrgId = vv?.org_id ?? null;
      hintedTaskId = vv?.task_id ?? null;
      hintedActor = vv?.actor_user_id ?? null;

      providerNumberId = pick<string | null>(json, ["message.call.phoneNumberId", "phoneNumberId", "message.phoneNumberId"], null);

      rawToPhone =
        (pick<string | null>(
          json,
          ["message.call.phoneNumber.number", "message.phoneNumber.number", "phoneNumber.number"],
          null,
        ) ?? "") as string;

      // A) Settlement event: end-of-call-report
      if (vapiEventType === "end-of-call-report") {
        const callId = pick<string | null>(
          json,
          ["message.call.id", "call.id", "message.callId", "message.call.callId"],
          null,
        );
        if (!callId) {
          console.error("vapi_end_of_call_missing_call_id");
          return new Response("OK", { status: 200 });
        }

        const durationSecondsRaw = pick<any>(
          json,
          ["message.call.durationSeconds", "message.call.duration", "call.durationSeconds", "call.duration"],
          0,
        );
        const durationSeconds = Math.max(0, Math.trunc(Number(durationSecondsRaw ?? 0)));

        const transcript = pick<string | null>(
          json,
          ["message.analysis.transcript", "message.transcript", "message.artifact.transcript", "message.call.transcript"],
          null,
        );

        const recordingUrl = pick<string | null>(
          json,
          [
            "message.artifact.recordingUrl",
            "message.artifact.stereoRecordingUrl",
            "message.call.artifact.recordingUrl",
            "message.recordingUrl",
          ],
          null,
        );

        const { data: settleRes, error: settleErr } = await supabase.rpc("settle_voice_call_tokens_v2", {
          p_provider: "vapi",
          p_provider_call_id: callId,
          p_duration_seconds: durationSeconds,
          p_transcript: transcript,
          p_raw_report: json,
        });

        if (settleErr) {
          console.error("voice_settlement_rpc_failed", { call_id: callId, error: settleErr.message });
          return new Response("OK", { status: 200 }); // ack to prevent retry storm
        }

        const orgId = (settleRes as any)?.org_id ?? hintedOrgId ?? null;
        const leadId = (settleRes as any)?.lead_id ?? hintedLeadId ?? null;
        const actorUserId = (settleRes as any)?.actor_user_id ?? hintedActor ?? null;

        if (orgId && leadId) {
          await supabase
            .from("interactions")
            .insert({
              lead_id: leadId,
              org_id: orgId,
              user_id: actorUserId,
              type: "voice",
              direction: "system",
              content: "Vapi end-of-call-report received",
              metadata: {
                provider: "vapi",
                event_type: "end-of-call-report",
                call_id: callId,
                duration_seconds: durationSeconds,
                transcript: transcript ?? null,
                recording_url: recordingUrl ?? null,
                settlement: settleRes ?? null,
                task_id: hintedTaskId ?? null,
                phone_number_id: providerNumberId ?? null,
                to_e164: rawToPhone ? normalizeE164Loose(rawToPhone, "US") : null,
              },
            })
            .select()
            .single()
            .catch(() => {});
        }

        return new Response("OK", { status: 200 });
      }

      // B) Final transcript event
      if (vapiEventType === "transcript" && pick<string>(json, ["message.transcriptType"], "") === "final") {
        inboundText = pick<string>(json, ["message.transcript"], "");
        rawFromPhone = pick<string>(json, ["message.customer.number"], "");
      } else {
        return new Response("Ignored Event", { status: 200 });
      }

      // Tenant resolution
      let orgId = hintedOrgId;
      let leadId = hintedLeadId;

      if (!orgId) {
        const toE164 = rawToPhone ? normalizeE164Loose(rawToPhone, "US") : null;
        const resolved = await resolveInboundOrg(supabase, {
          provider: "vapi",
          channel: "voice",
          to_e164: toE164,
          provider_number_id: providerNumberId,
        });

        if (resolved.status !== "ok") return new Response("OK", { status: 200 });
        orgId = resolved.org_id;
        if (!orgId) return new Response("OK", { status: 200 });
      }

      // Lead resolution inside org
      if (!leadId) {
        if (!rawFromPhone) return new Response("OK", { status: 200 });
        const fromE164 = normalizeE164Loose(rawFromPhone, "US");

        const { data: lead } = await supabase
          .from("leads")
          .select("id, org_id")
          .eq("org_id", orgId)
          .eq("phone", fromE164)
          .maybeSingle();

        if (!lead) return new Response("OK", { status: 200 });
        leadId = lead.id;
      }

      await supabase
        .from("interactions")
        .insert({
          lead_id: leadId,
          org_id: orgId,
          user_id: hintedActor ?? null,
          type: "voice",
          direction: "inbound",
          content: inboundText,
          metadata: {
            provider: "vapi",
            vapi_event_type: vapiEventType,
            task_id: hintedTaskId ?? null,
            phone_number_id: providerNumberId ?? null,
            to_e164: rawToPhone ? normalizeE164Loose(rawToPhone, "US") : null,
            from_e164: rawFromPhone ? normalizeE164Loose(rawFromPhone, "US") : null,
          },
        })
        .select()
        .single()
        .catch(() => {});

      // Hard intents => halt (voice path)
      const intent = ruleBasedIntentClassifier(inboundText);
      if (intent === "unsubscribe" || intent === "not_interested" || intent === "objection_hard") {
        await supabase.rpc("apply_lead_halt_and_cancel", {
          p_org_id: orgId,
          p_lead_id: leadId,
          p_scope: "lead",
          p_plan_id: null,
          p_channel: null,
          p_reason:
            intent === "unsubscribe"
              ? "UNSUBSCRIBE"
              : intent === "not_interested"
              ? "NOT_INTERESTED"
              : "OBJECTION_HARD",
        });
      }

      // Upsell hook — create manual action request when service is inactive
      if ((intent === "request_callback" || intent === "request_meeting") && orgId && leadId) {
        const serviceKey = intent === "request_callback" ? "voice" : "architect";
        const { data: svc } = await supabase
          .from("org_services")
          .select("status")
          .eq("org_id", orgId)
          .eq("service_key", serviceKey)
          .maybeSingle();
        if (!svc || svc.status !== "active") {
          const type = intent === "request_callback" ? "callback_requested" : "meeting_requested";
          const msg = intent === "request_callback"
            ? "Lead requested a callback via voice. Manual follow-up required."
            : "Lead wants to schedule a meeting. Manual follow-up required.";
          await Promise.all([
            supabase.from("manual_action_requests").insert({
              org_id: orgId, lead_id: leadId, type, lead_message: inboundText,
            }),
            supabase.from("notifications").insert({
              org_id: orgId, lead_id: leadId, type, message: msg, is_read: false,
            }),
          ]);
        }
      }

      return new Response("OK", { status: 200 });
    } else {
      return new Response("Unknown Source", { status: 400 });
    }

    // -----------------------------
    // SMS / WHATSAPP INBOUND PATH
    // -----------------------------
    if (!inboundText || !rawFromPhone) return new Response("No content", { status: 200 });

    const toE164 = rawToPhone ? normalizeE164Loose(rawToPhone, "US") : null;
    const resolved = await resolveInboundOrg(supabase, {
      provider: "twilio",
      channel: channel === "whatsapp" ? "whatsapp" as any : "sms",
      to_e164: toE164,
      provider_number_id: null,
    });

    if (resolved.status !== "ok") return new Response("OK", { status: 200 });

    const orgId = resolved.org_id;
    const fromE164 = normalizeE164Loose(rawFromPhone, "US");

    let leadId: string | null = null;
    let leadOrgId: string | null = null;

    if (orgId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("id, org_id")
        .eq("org_id", orgId)
        .eq("phone", fromE164)
        .maybeSingle();

      if (!lead) return new Response("OK", { status: 200 });
      leadId = lead.id;
      leadOrgId = lead.org_id;
    } else {
      // Platform number fallback: resolve by lead phone across orgs
      const { data: leads } = await supabase.from("leads").select("id, org_id").eq("phone", fromE164).limit(3);

      if (!leads || leads.length === 0) {
        // No lead found for this phone — log and drop
        console.warn(`[webhook_inbound] event=inbound_route_no_lead channel=${channel} phone=${fromE164}`);
        await supabase.from("audit_events").insert({
          org_id: null,
          actor_type: "system",
          actor_id: null,
          object_type: "inbound_message",
          object_id: crypto.randomUUID(),
          action: "inbound_route_no_lead",
          reason: "no_lead_found_for_phone",
          before_state: null,
          after_state: { phone: fromE164, channel, provider: "twilio" },
        }).catch(() => {});
        return new Response("OK", { status: 200 });
      }

      if (leads.length > 1) {
        // Multiple orgs have a lead with this phone — ambiguous, log and drop
        const candidateOrgIds = leads.map((l: any) => l.org_id);
        console.warn(`[webhook_inbound] event=inbound_route_ambiguous channel=${channel} phone=${fromE164} candidate_org_count=${leads.length}`);
        await supabase.from("audit_events").insert({
          org_id: null,
          actor_type: "system",
          actor_id: null,
          object_type: "inbound_message",
          object_id: crypto.randomUUID(),
          action: "inbound_route_ambiguous",
          reason: "multiple_orgs_match_phone",
          before_state: null,
          after_state: { phone: fromE164, channel, candidate_org_ids: candidateOrgIds },
        }).catch(() => {});
        return new Response("OK", { status: 200 });
      }

      leadId = leads[0].id;
      leadOrgId = leads[0].org_id;
    }

    await supabase
      .from("interactions")
      .insert({
        lead_id: leadId,
        org_id: leadOrgId,
        type: channel, // "sms" or "whatsapp"
        direction: "inbound",
        content: inboundText,
        metadata: {
          provider: channel === "whatsapp" ? "twilio_wa" : "twilio",
          to_e164: toE164,
          from_e164: fromE164,
          routing_source: resolved.source,
        },
      })
      .select()
      .single()
      .catch(() => {});

    // WhatsApp inbound: log to delivery_attempts as received
    if (channel === "whatsapp") {
      const msgSidParam = url.searchParams.get("MessageSid") ?? null;
      await supabase.from("delivery_attempts").insert({
        org_id: leadOrgId,
        lead_id: leadId,
        channel: "whatsapp",
        provider: "twilio_wa",
        provider_message_id: msgSidParam,
        status: "received",
        sent_at: new Date().toISOString(),
        metadata: { from_e164: fromE164, to_e164: toE164, direction: "inbound" },
      }).catch(() => {});
    }

    const intent = ruleBasedIntentClassifier(inboundText);

    if (intent === "unsubscribe") {
      await supabase.rpc("apply_lead_halt_and_cancel", {
        p_org_id: leadOrgId,
        p_lead_id: leadId,
        p_scope: "lead",
        p_plan_id: null,
        p_channel: null,
        p_reason: "UNSUBSCRIBE",
      });
      return new Response("OK", { status: 200 });
    }

    if (intent === "not_interested" || intent === "objection_hard") {
      await supabase.rpc("apply_lead_halt_and_cancel", {
        p_org_id: leadOrgId,
        p_lead_id: leadId,
        p_scope: "lead",
        p_plan_id: null,
        p_channel: null,
        p_reason: intent === "not_interested" ? "NOT_INTERESTED" : "OBJECTION_HARD",
      });
      return new Response("OK", { status: 200 });
    }

    // Upsell hook — create manual action request when service is inactive
    if (intent === "request_callback" || intent === "request_meeting") {
      const serviceKey = intent === "request_callback" ? "voice" : "architect";
      const { data: svc } = await supabase
        .from("org_services")
        .select("status")
        .eq("org_id", leadOrgId)
        .eq("service_key", serviceKey)
        .maybeSingle();
      if (!svc || svc.status !== "active") {
        const type = intent === "request_callback" ? "callback_requested" : "meeting_requested";
        const msg = intent === "request_callback"
          ? "Lead requested a callback via SMS. Manual follow-up required."
          : "Lead wants to schedule a meeting. Manual follow-up required.";
        await Promise.all([
          supabase.from("manual_action_requests").insert({
            org_id: leadOrgId, lead_id: leadId, type, lead_message: inboundText,
          }),
          supabase.from("notifications").insert({
            org_id: leadOrgId, lead_id: leadId, type, message: msg, is_read: false,
          }),
        ]);
      }
    }

    await replyRouter({
      supabase,
      org_id: leadOrgId,
      lead_id: leadId,
      inbound_text: inboundText,
      channel_source: channel === "whatsapp" ? "whatsapp" : "sms",
    });

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("webhook_inbound_error", error);
    return new Response("Internal Error", { status: 500 });
  }
});