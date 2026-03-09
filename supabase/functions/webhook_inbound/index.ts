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

  // x-forwarded-host inside Supabase Edge resolves to "edge-runtime.supabase.com" (internal),
  // not the actual project hostname. Use SUPABASE_URL env var for the canonical public base.
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/webhook_inbound${u.search}`;
  }

  // Fallback: reconstruct from forwarded headers (less reliable)
  const proto = (req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "") ?? "https").trim();
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host).trim();
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

// ── Provider Webhook Event Store helpers ────────────────────────────────────
// Persist raw event before processing; returns id + already_processed flag.
// On duplicate (23505): look up existing row and return its processed state.
// Fail-open: if insert fails for any other reason, returns null (processing continues).
async function persistWebhookEvent(
  supabase: any,
  provider: string,
  provider_event_id: string,
  event_type: string,
  raw_payload: any,
): Promise<{ id: string; already_processed: boolean } | null> {
  const { data, error } = await supabase
    .from("provider_webhook_events")
    .insert({ provider, provider_event_id, event_type, raw_payload })
    .select("id, processed")
    .single();
  if (error) {
    if (error.code === "23505") {
      // Duplicate event — return existing row's processed state for idempotency gate
      const { data: existing } = await supabase
        .from("provider_webhook_events")
        .select("id, processed")
        .eq("provider", provider)
        .eq("provider_event_id", provider_event_id)
        .maybeSingle();
      return existing ? { id: existing.id, already_processed: existing.processed } : null;
    }
    console.error(`[webhook_inbound] persistWebhookEvent failed: provider=${provider} event_id=${provider_event_id} err=${error.message}`);
    return null;
  }
  return { id: data.id, already_processed: false };
}

async function markWebhookProcessed(supabase: any, eventId: string): Promise<void> {
  const { error } = await supabase
    .from("provider_webhook_events")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error) console.error(`[webhook_inbound] markWebhookProcessed failed: ${error.message}`);
}

async function markWebhookFailed(supabase: any, eventId: string, errMsg: string): Promise<void> {
  const { error } = await supabase
    .from("provider_webhook_events")
    .update({ processing_error: errMsg.slice(0, 2000) })
    .eq("id", eventId);
  if (error) console.error(`[webhook_inbound] markWebhookFailed failed: ${error.message}`);
}

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
    const source = url.searchParams.get("source");
    const isTwilio = source === "twilio";
    const isVapi = source === "vapi";
    const isRbm = source === "google_rbm";
    const isMessenger = source === "facebook_messenger";

    // Facebook Messenger webhook verification: GET hub.challenge before POST check
    if (req.method === "GET" && isMessenger) {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      const expectedToken = (Deno.env.get("FACEBOOK_VERIFY_TOKEN") ?? "").trim();
      if (mode === "subscribe" && token === expectedToken && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

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
    let messageSid: string | null = null; // hoisted for SMS/WA bottom section + event store

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
      messageSid = params.MessageSid ?? params.SmsSid ?? null;


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

        // Log event (best-effort — status callbacks are idempotent so no processing gate)
        if (sid) {
          await persistWebhookEvent(supabase, "twilio", `${sid}:status:${status}`, "whatsapp_status", { sid, status, error_code: params.ErrorCode ?? null }).then(undefined, () => {});
        }

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

          const { error: daStatusErr } = await supabase
            .from("delivery_attempts")
            .update(patch)
            .eq("provider_message_id", sid);
          if (daStatusErr) console.error(`[webhook_inbound] delivery_attempts status update failed: ${daStatusErr.message}`);
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

        // Persist event before processing; gate on already_processed to prevent double token settlement
        let pweEocId: string | null = null;
        const pweEoc = await persistWebhookEvent(supabase, "vapi", `${callId}:end_of_call`, "vapi_end_of_call", { call_id: callId });
        if (pweEoc?.already_processed) {
          console.warn(`[webhook_inbound] vapi_end_of_call duplicate ignored: callId=${callId}`);
          return new Response("OK", { status: 200 });
        }
        pweEocId = pweEoc?.id ?? null;

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
          if (pweEocId) await markWebhookFailed(supabase, pweEocId, `settle_voice_call_tokens_v2 failed: ${settleErr.message}`);
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
            .then(undefined, () => {});
        }

        if (pweEocId) await markWebhookProcessed(supabase, pweEocId);
        return new Response("OK", { status: 200 });
      }

      // B) Final transcript event
      let pweTranscriptId: string | null = null;
      if (vapiEventType === "transcript" && pick<string>(json, ["message.transcriptType"], "") === "final") {
        inboundText = pick<string>(json, ["message.transcript"], "");
        rawFromPhone = pick<string>(json, ["message.customer.number"], "");

        // Persist transcript event; use callId:transcript suffix to distinguish from end-of-call
        const transcriptCallId = pick<string | null>(json, ["message.call.id", "call.id", "message.callId"], null);
        const pweTranscriptEventId = `${transcriptCallId ?? hintedTaskId ?? crypto.randomUUID()}:transcript`;
        const pweTr = await persistWebhookEvent(supabase, "vapi", pweTranscriptEventId, "vapi_transcript", { call_id: transcriptCallId, task_id: hintedTaskId });
        if (pweTr?.already_processed) {
          console.warn(`[webhook_inbound] vapi_transcript duplicate ignored: callId=${transcriptCallId}`);
          return new Response("OK", { status: 200 });
        }
        pweTranscriptId = pweTr?.id ?? null;
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
        .then(undefined, () => {});

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

      if (pweTranscriptId) await markWebhookProcessed(supabase, pweTranscriptId);
      return new Response("OK", { status: 200 });
    } else if (isRbm) {
      // ─────────────────────────────────────────────────────────────
      // GOOGLE RBM (RCS Business Messaging) — Pub/Sub push webhook
      // Source: POST ?source=google_rbm&token={RBM_WEBHOOK_SECRET}
      // Google pushes events via Cloud Pub/Sub (userEvent or agentEvent).
      // Pub/Sub envelope: { message: { data: base64(RbmEvent), messageId } }
      // ─────────────────────────────────────────────────────────────

      // Token validation (shared secret in query param — simple but effective for Phase 5A)
      const rbmToken = url.searchParams.get("token") ?? "";
      const expectedToken = (Deno.env.get("GOOGLE_RBM_WEBHOOK_SECRET") ?? "").trim();
      if (!expectedToken || rbmToken !== expectedToken) {
        console.warn("[webhook_inbound] RBM webhook: invalid or missing token");
        // Always return 200 to Pub/Sub (avoid redelivery storms on auth failure)
        return new Response("OK", { status: 200 });
      }

      const rbmBody = await req.json().catch(() => ({}));
      const rawData = rbmBody?.message?.data as string | undefined;
      if (!rawData) {
        // Heartbeat / empty message from Pub/Sub — ack and ignore
        return new Response("OK", { status: 200 });
      }

      let rbmEvent: Record<string, any>;
      try {
        rbmEvent = JSON.parse(atob(rawData));
      } catch {
        console.warn("[webhook_inbound] RBM event decode failed");
        return new Response("OK", { status: 200 });
      }

      // ── Delivery receipt (agentEvent) — update delivery_attempts ──
      const agentEvent = rbmEvent?.agentEvent;
      if (agentEvent) {
        const rbmMessageId = agentEvent.requestId ?? null;
        const eventType: string = agentEvent.eventType ?? "";
        // RBM eventTypes: DELIVERED, READ
        if (rbmMessageId && (eventType === "DELIVERED" || eventType === "READ")) {
          // Log event best-effort — delivery receipts are idempotent (updates same row)
          await persistWebhookEvent(supabase, "google_rbm", `${rbmMessageId}:receipt:${eventType}`, "rbm_delivery_receipt", { request_id: rbmMessageId, event_type: eventType }).then(undefined, () => {});
          const patch: Record<string, any> = {
            status: eventType === "READ" ? "read" : "delivered",
          };
          if (eventType === "DELIVERED") patch.delivered_at = new Date().toISOString();
          if (eventType === "READ") patch.read_at = new Date().toISOString();

          await supabase.from("delivery_attempts")
            .update(patch)
            .eq("provider_message_id", rbmMessageId)
            .then(undefined, () => {});

          console.log(`[webhook_inbound] RBM delivery receipt: message_id=${rbmMessageId} event=${eventType}`);
        }
        return new Response("OK", { status: 200 });
      }

      // ── Inbound user message (userEvent) ──────────────────────────
      const userEvent = rbmEvent?.userEvent;
      if (!userEvent) return new Response("OK", { status: 200 });

      const rbmFromPhone = (userEvent.phoneNumber ?? "") as string;
      const rbmText = (userEvent.text ?? userEvent.suggestionResponse?.text ?? "") as string;
      const rbmMessageId = (userEvent.messageId ?? null) as string | null;

      // Persist inbound event; gate on already_processed to prevent duplicate routing
      let pweRbmId: string | null = null;
      if (rbmMessageId) {
        const pweRbm = await persistWebhookEvent(supabase, "google_rbm", rbmMessageId, "rbm_inbound", { from_phone: rbmFromPhone, text: rbmText.slice(0, 500) });
        if (pweRbm?.already_processed) {
          console.warn(`[webhook_inbound] rbm_inbound duplicate ignored: messageId=${rbmMessageId}`);
          return new Response("OK", { status: 200 });
        }
        pweRbmId = pweRbm?.id ?? null;
      }

      if (!rbmFromPhone || !rbmText) return new Response("OK", { status: 200 });

      const rbmFromE164 = normalizeE164Loose(rbmFromPhone, "US");

      // Cross-org lead lookup (all orgs use platform RBM agent in Phase 5A)
      const { data: rbmLeads } = await supabase
        .from("leads").select("id, org_id").eq("phone", rbmFromE164).limit(3);

      if (!rbmLeads || rbmLeads.length === 0) {
        console.warn(`[webhook_inbound] event=inbound_route_no_lead channel=rcs phone=${rbmFromE164}`);
        await supabase.from("audit_events").insert({
          org_id: null, actor_type: "system", actor_id: null,
          object_type: "inbound_message", object_id: crypto.randomUUID(),
          action: "inbound_route_no_lead", reason: "no_lead_found_for_phone",
          before_state: null,
          after_state: { phone: rbmFromE164, channel: "rcs", provider: "google_rbm" },
        }).then(undefined, () => {});
        return new Response("OK", { status: 200 });
      }

      if (rbmLeads.length > 1) {
        const candidateOrgIds = rbmLeads.map((l: any) => l.org_id);
        console.warn(`[webhook_inbound] event=inbound_route_ambiguous channel=rcs phone=${rbmFromE164} count=${rbmLeads.length}`);
        await supabase.from("audit_events").insert({
          org_id: null, actor_type: "system", actor_id: null,
          object_type: "inbound_message", object_id: crypto.randomUUID(),
          action: "inbound_route_ambiguous", reason: "multiple_orgs_match_phone",
          before_state: null,
          after_state: { phone: rbmFromE164, channel: "rcs", candidate_org_ids: candidateOrgIds },
        }).then(undefined, () => {});
        return new Response("OK", { status: 200 });
      }

      const rbmLeadId = rbmLeads[0].id;
      const rbmLeadOrgId = rbmLeads[0].org_id;

      // Insert interaction
      await supabase.from("interactions").insert({
        lead_id: rbmLeadId,
        org_id: rbmLeadOrgId,
        type: "rcs",
        direction: "inbound",
        content: rbmText,
        metadata: { provider: "google_rbm", from_e164: rbmFromE164, rbm_message_id: rbmMessageId },
      }).select();

      // Log to delivery_attempts (inbound)
      await supabase.from("delivery_attempts").insert({
        org_id: rbmLeadOrgId,
        lead_id: rbmLeadId,
        channel: "rcs",
        provider: "google_rbm",
        provider_message_id: rbmMessageId,
        status: "received",
        sent_at: new Date().toISOString(),
        metadata: { from_e164: rbmFromE164, direction: "inbound" },
      }).then(undefined, () => {});

      // Route to reply_router
      await replyRouter({
        supabase,
        org_id: rbmLeadOrgId,
        lead_id: rbmLeadId,
        inbound_text: rbmText,
        channel_source: "rcs",
      });

      console.log(`[webhook_inbound] RBM inbound: lead=${rbmLeadId} org=${rbmLeadOrgId} phone=${rbmFromE164}`);
      if (pweRbmId) await markWebhookProcessed(supabase, pweRbmId);
      return new Response("OK", { status: 200 });

    } else if (isMessenger) {
      // ─────────────────────────────────────────────────────────────
      // FACEBOOK MESSENGER webhook
      // Source: GET/POST ?source=facebook_messenger
      //
      // GET = webhook verification challenge from Meta.
      // POST = message/delivery/read events from the Messenger Platform.
      //        Secured with X-Hub-Signature-256 (HMAC-SHA256 of body using FACEBOOK_APP_SECRET).
      // ─────────────────────────────────────────────────────────────

      // ── Webhook verification (GET — Meta subscribes or re-verifies) ──────────
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expectedToken = (Deno.env.get("FACEBOOK_VERIFY_TOKEN") ?? "").trim();

        if (mode === "subscribe" && token === expectedToken && challenge) {
          console.log("[webhook_inbound] Messenger webhook verification successful");
          return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
        }

        console.warn("[webhook_inbound] Messenger webhook verification failed: invalid token or mode");
        return new Response("Forbidden", { status: 403 });
      }

      // ── POST: validate X-Hub-Signature-256 ───────────────────────────────────
      const fbBodyText = await req.text().catch(() => "");
      const fbSignatureHeader = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
      const fbAppSecret = (Deno.env.get("FACEBOOK_APP_SECRET") ?? "").trim();

      if (fbAppSecret && fbSignatureHeader) {
        const encoder = new TextEncoder();
        const sigKey = await crypto.subtle.importKey(
          "raw", encoder.encode(fbAppSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        const sigBytes = await crypto.subtle.sign("HMAC", sigKey, encoder.encode(fbBodyText));
        const expectedSig = Array.from(new Uint8Array(sigBytes))
          .map((b) => b.toString(16).padStart(2, "0")).join("");

        if (expectedSig !== fbSignatureHeader) {
          console.warn("[webhook_inbound] Messenger: X-Hub-Signature-256 mismatch — rejecting");
          return new Response("Unauthorized", { status: 401 });
        }
      } else if (!fbAppSecret) {
        // FACEBOOK_APP_SECRET not set — log and continue (dev/test mode)
        console.warn("[webhook_inbound] Messenger: FACEBOOK_APP_SECRET not set — signature validation skipped");
      }

      let fbPayload: Record<string, any>;
      try {
        fbPayload = JSON.parse(fbBodyText);
      } catch {
        return new Response("OK", { status: 200 });
      }

      if (fbPayload?.object !== "page") {
        return new Response("OK", { status: 200 });
      }

      for (const entry of (fbPayload?.entry ?? []) as any[]) {
        const pageId = entry?.id as string | undefined;

        for (const event of (entry?.messaging ?? []) as any[]) {
          const psid = event?.sender?.id as string | undefined;
          if (!psid) continue;

          // ── Delivery receipt (messaging_deliveries) ──────────────
          if (event.delivery) {
            // Watermark = all messages sent before this timestamp are delivered
            const watermarkMs = event.delivery.watermark as number | undefined;
            if (watermarkMs) {
              const watermarkTs = new Date(watermarkMs).toISOString();
              await supabase.from("delivery_attempts")
                .update({ status: "delivered", delivered_at: watermarkTs })
                .eq("channel", "messenger")
                .lte("sent_at", watermarkTs)
                .eq("status", "sent")
                .then(undefined, () => {});
              console.log(`[webhook_inbound] Messenger delivery watermark: page=${pageId} watermark=${watermarkTs}`);
            }
            continue;
          }

          // ── Read receipt (messaging_reads) ───────────────────────
          if (event.read) {
            const watermarkMs = event.read.watermark as number | undefined;
            if (watermarkMs) {
              const watermarkTs = new Date(watermarkMs).toISOString();
              await supabase.from("delivery_attempts")
                .update({ status: "read", read_at: watermarkTs })
                .eq("channel", "messenger")
                .lte("sent_at", watermarkTs)
                .in("status", ["sent", "delivered"])
                .then(undefined, () => {});
            }
            continue;
          }

          // ── Inbound text message (messaging.message.text) ────────
          const msgText = event?.message?.text as string | undefined;
          const msgId = event?.message?.mid as string | undefined;
          if (!msgText) continue; // echoes, stickers, attachments — skip for now

          // Persist per-message event; gate on already_processed to prevent duplicate routing
          let pweMsgId: string | null = null;
          if (msgId) {
            const pweMsg = await persistWebhookEvent(supabase, "facebook", msgId, "messenger_inbound", { psid, page_id: pageId, text: msgText.slice(0, 500) });
            if (pweMsg?.already_processed) {
              console.warn(`[webhook_inbound] messenger_inbound duplicate ignored: msgId=${msgId}`);
              continue;
            }
            pweMsgId = pweMsg?.id ?? null;
          }

          // Resolve lead by messenger_psid
          const { data: psidLead } = await supabase
            .from("leads")
            .select("id, org_id, messenger_psid")
            .eq("messenger_psid", psid)
            .limit(2);

          let fbLeadId: string | null = null;
          let fbLeadOrgId: string | null = null;

          if (!psidLead || psidLead.length === 0) {
            // PSID not yet linked — attempt safe auto-link:
            // 1. Resolve which org owns this Messenger page.
            // 2. In that org, find leads with messenger_psid IS NULL.
            //    Exactly 1 → link. >1 → ambiguous, audit only.
            let candidateOrgId: string | null = null;
            const { data: messengerChannels } = await supabase
              .from("org_channels")
              .select("org_id, metadata")
              .eq("channel", "messenger")
              .eq("is_default", true)
              .eq("status", "active");

            const matchingOrg = (messengerChannels ?? []).find(
              (ch: any) => ch.metadata?.page_id === pageId,
            );
            if (matchingOrg) {
              candidateOrgId = matchingOrg.org_id;
            } else if (pageId && pageId === Deno.env.get("FACEBOOK_PAGE_ID")) {
              // Shared platform page — can't safely infer org from PSID alone
              candidateOrgId = null;
            }

            if (!candidateOrgId) {
              console.warn(`[webhook_inbound] event=messenger_psid_no_match psid=${psid} page=${pageId} reason=no_org_for_page`);
              await supabase.from("audit_events").insert({
                org_id: null, actor_type: "system", actor_id: null,
                object_type: "lead", object_id: crypto.randomUUID(),
                action: "messenger_psid_no_match", reason: "no_org_for_page_id",
                before_state: null,
                after_state: { psid, page_id: pageId, channel: "messenger" },
              }).then(undefined, () => {});
              continue;
            }

            // Find unlinked leads in this org (limit 2 to detect ambiguity)
            const { data: unlinkedLeads } = await supabase
              .from("leads")
              .select("id")
              .eq("org_id", candidateOrgId)
              .is("messenger_psid", null)
              .eq("is_dnc", false)
              .limit(2);

            if (!unlinkedLeads || unlinkedLeads.length === 0) {
              await supabase.from("audit_events").insert({
                org_id: candidateOrgId, actor_type: "system", actor_id: null,
                object_type: "lead", object_id: crypto.randomUUID(),
                action: "messenger_psid_no_match", reason: "no_unlinked_leads_in_org",
                before_state: null,
                after_state: { psid, page_id: pageId, org_id: candidateOrgId },
              }).then(undefined, () => {});
              continue;
            }

            if (unlinkedLeads.length > 1) {
              await supabase.from("audit_events").insert({
                org_id: candidateOrgId, actor_type: "system", actor_id: null,
                object_type: "lead", object_id: crypto.randomUUID(),
                action: "messenger_psid_ambiguous", reason: "multiple_unlinked_leads_in_org",
                before_state: null,
                after_state: { psid, page_id: pageId, org_id: candidateOrgId, candidate_count: unlinkedLeads.length },
              }).then(undefined, () => {});
              continue;
            }

            // Exactly 1 unlinked lead — safe to auto-link
            const targetLeadId = unlinkedLeads[0].id;
            await supabase.from("leads")
              .update({ messenger_psid: psid })
              .eq("id", targetLeadId)
              .then(undefined, () => {});

            await supabase.from("audit_events").insert({
              org_id: candidateOrgId, actor_type: "system", actor_id: null,
              object_type: "lead", object_id: targetLeadId,
              action: "messenger_psid_linked", reason: "safe_auto_link_single_candidate",
              before_state: { messenger_psid: null },
              after_state: { messenger_psid: psid, page_id: pageId, org_id: candidateOrgId },
            }).then(undefined, () => {});

            console.log(`[webhook_inbound] Messenger PSID auto-linked: lead=${targetLeadId} org=${candidateOrgId} psid=${psid}`);
            fbLeadId = targetLeadId;
            fbLeadOrgId = candidateOrgId;

          } else if (psidLead.length > 1) {
            const candidateOrgIds = psidLead.map((l: any) => l.org_id);
            console.warn(`[webhook_inbound] event=inbound_route_ambiguous channel=messenger psid=${psid} count=${psidLead.length}`);
            await supabase.from("audit_events").insert({
              org_id: null, actor_type: "system", actor_id: null,
              object_type: "inbound_message", object_id: crypto.randomUUID(),
              action: "inbound_route_ambiguous", reason: "psid_linked_to_multiple_leads",
              before_state: null,
              after_state: { psid, page_id: pageId, channel: "messenger", candidate_org_ids: candidateOrgIds },
            }).then(undefined, () => {});
            continue;

          } else {
            fbLeadId = psidLead[0].id;
            fbLeadOrgId = psidLead[0].org_id;
          }

          if (!fbLeadId || !fbLeadOrgId) continue;

          // Insert interaction
          await supabase.from("interactions").insert({
            lead_id: fbLeadId,
            org_id: fbLeadOrgId,
            type: "messenger",
            direction: "inbound",
            content: msgText,
            metadata: { provider: "facebook", psid, page_id: pageId, message_id: msgId },
          }).select();

          // Log to delivery_attempts (inbound received)
          await supabase.from("delivery_attempts").insert({
            org_id: fbLeadOrgId,
            lead_id: fbLeadId,
            channel: "messenger",
            provider: "facebook",
            provider_message_id: msgId ?? null,
            status: "received",
            sent_at: new Date().toISOString(),
            metadata: { psid, page_id: pageId, direction: "inbound" },
          }).then(undefined, () => {});

          // Resolve actor_user_id + plan_id for reply_router task creation
          const [fbOwnerRes, fbPlanRes] = await Promise.all([
            supabase.from("org_members").select("user_id").eq("org_id", fbLeadOrgId)
              .in("role", ["owner", "agency_admin", "enterprise_admin"]).limit(1).maybeSingle(),
            supabase.from("decision_plans").select("id").eq("org_id", fbLeadOrgId)
              .order("created_at", { ascending: false }).limit(1).maybeSingle(),
          ]);
          const fbActorId: string | undefined = fbOwnerRes.data?.user_id ?? fbLeadOrgId;
          const fbPlanId: string | undefined = fbPlanRes.data?.id ?? undefined;

          // Route to reply_router
          await replyRouter({
            supabase,
            org_id: fbLeadOrgId,
            lead_id: fbLeadId,
            inbound_text: msgText,
            channel_source: "messenger" as any,
            actor_user_id: fbActorId,
            plan_id: fbPlanId,
          });

          console.log(`[webhook_inbound] Messenger inbound: lead=${fbLeadId} org=${fbLeadOrgId} psid=${psid}`);
          if (pweMsgId) await markWebhookProcessed(supabase, pweMsgId);
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

    // Persist inbound event; gate on already_processed to prevent duplicate AI routing
    const smsEventType = channel === "whatsapp" ? "whatsapp_inbound" : "sms_inbound";
    let pweSmsId: string | null = null;
    if (messageSid) {
      const pweSms = await persistWebhookEvent(supabase, "twilio", messageSid, smsEventType, { from: rawFromPhone, to: rawToPhone, channel });
      if (pweSms?.already_processed) {
        console.warn(`[webhook_inbound] ${smsEventType} duplicate ignored: sid=${messageSid}`);
        return new Response("OK", { status: 200 });
      }
      pweSmsId = pweSms?.id ?? null;
    }

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

    // ── Thread-first routing: prefer prior conversation context ───────────────
    // If this from+to+channel combo has routed before, use that lead directly.
    // This resolves shared-number ambiguity without cross-org phone lookup.
    if (fromE164 && toE164) {
      const { data: thread } = await supabase
        .from("message_threads")
        .select("lead_id, org_id")
        .eq("from_identifier", fromE164)
        .eq("to_identifier", toE164)
        .eq("channel", channel)
        .maybeSingle();
      if (thread) {
        leadId = thread.lead_id;
        leadOrgId = thread.org_id;
        console.log(`[webhook_inbound] thread-routed: channel=${channel} lead=${leadId} org=${leadOrgId}`);
      }
    }

    if (!leadId) {
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
          }).then(undefined, () => {});
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
          }).then(undefined, () => {});
          return new Response("OK", { status: 200 });
        }

        leadId = leads[0].id;
        leadOrgId = leads[0].org_id;
      }
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
      .then(undefined, () => {});

    // WhatsApp inbound: log to delivery_attempts as received
    if (channel === "whatsapp") {
      // messageSid was hoisted from the Twilio branch (params.MessageSid ?? params.SmsSid)
      const msgSid = messageSid;
      await supabase.from("delivery_attempts").insert({
        org_id: leadOrgId,
        lead_id: leadId,
        channel: "whatsapp",
        provider: "twilio_wa",
        provider_message_id: msgSid,
        status: "received",
        sent_at: new Date().toISOString(),
        metadata: { from_e164: fromE164, to_e164: toE164, direction: "inbound" },
      }).then(undefined, () => {});
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

    // Resolve actor_user_id (org owner) and plan_id for reply_router task creation
    let replyActorId: string | null = null;
    let replyPlanId: string | null = null;
    const [ownerRes, planRes] = await Promise.all([
      supabase.from("org_members").select("user_id").eq("org_id", leadOrgId)
        .in("role", ["owner", "agency_admin", "enterprise_admin"]).limit(1).maybeSingle(),
      supabase.from("decision_plans").select("id").eq("org_id", leadOrgId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    replyActorId = ownerRes.data?.user_id ?? leadOrgId; // personal org fallback: org_id = owner user_id
    replyPlanId = planRes.data?.id ?? null;

    await replyRouter({
      supabase,
      org_id: leadOrgId,
      lead_id: leadId,
      inbound_text: inboundText,
      channel_source: channel === "whatsapp" ? "whatsapp" : "sms",
      actor_user_id: replyActorId ?? undefined,
      plan_id: replyPlanId ?? undefined,
    });

    // Upsert message thread for future routing continuity (resolves shared-number ambiguity)
    if (fromE164 && toE164 && leadId && leadOrgId) {
      await supabase.from("message_threads").upsert({
        org_id: leadOrgId,
        lead_id: leadId,
        channel,
        from_identifier: fromE164,
        to_identifier: toE164,
        last_message_at: new Date().toISOString(),
      }, { onConflict: "from_identifier,to_identifier,channel" }).then(undefined, () => {});
    }

    if (pweSmsId) await markWebhookProcessed(supabase, pweSmsId);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("webhook_inbound_error", error);
    return new Response("Internal Error", { status: 500 });
  }
});