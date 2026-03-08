import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Called by success.html when polling times out.
// Looks up the Razorpay payment_id stored by payment.html, verifies it with Razorpay,
// synthesizes a webhook payload, runs it through the normal processing chain, then
// calls the appropriate fulfillment function.
// Result: billing_intent → 'paid', credits/provision created — same outcome as a live webhook.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const { billing_intent_id } = await req.json()
    if (!billing_intent_id) {
      return new Response(JSON.stringify({ error: "billing_intent_id required" }), { status: 400, headers: CORS })
    }

    // ── 1. Check if already paid ─────────────────────────────────────────────
    const { data: intent, error: intentErr } = await sb
      .from("billing_intents")
      .select("id, status, intent_source, org_id, pricing_snapshot")
      .eq("id", billing_intent_id)
      .single()

    if (intentErr || !intent) {
      return new Response(JSON.stringify({ error: "billing_intent not found" }), { status: 404, headers: CORS })
    }

    if (intent.status === "paid") {
      return new Response(
        JSON.stringify({ status: "paid", message: "Already fulfilled" }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // ── 2. Find Razorpay payment_id stored by payment.html handler ────────────
    const { data: attempt } = await sb
      .from("payment_attempts")
      .select("id, provider_ref, payable_amount")
      .eq("intent_id", billing_intent_id)
      .not("provider_ref", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!attempt?.provider_ref) {
      console.warn("[recover-payment] No provider_ref found for intent:", billing_intent_id)
      return new Response(
        JSON.stringify({
          status: "no_payment_found",
          message: "No Razorpay payment ID on record. If you completed payment, please wait a few minutes and refresh.",
        }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const razorpay_payment_id = attempt.provider_ref

    // ── 3. Verify payment with Razorpay API ───────────────────────────────────
    const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID") ?? ""
    const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET") ?? ""

    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      console.error("[recover-payment] Razorpay credentials missing")
      return new Response(JSON.stringify({ status: "config_error", message: "Payment gateway not configured" }), { status: 200, headers: CORS })
    }

    const basic = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`)
    const rzResp = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
      headers: { Authorization: `Basic ${basic}` },
    })

    if (!rzResp.ok) {
      const errText = await rzResp.text()
      console.error("[recover-payment] Razorpay API error:", errText)
      return new Response(
        JSON.stringify({ status: "razorpay_error", message: "Could not verify payment" }),
        { status: 200, headers: CORS },
      )
    }

    const rzPayment = await rzResp.json()

    if (rzPayment.status !== "captured") {
      return new Response(
        JSON.stringify({ status: "payment_not_captured", message: `Razorpay payment status: ${rzPayment.status}` }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // ── 4. Synthesize webhook payload → normal processing chain ──────────────
    // This runs the exact same path as a live Razorpay webhook:
    // record_webhook_and_process_razorpay → process_payment_webhook_v2 →
    //   finalize_intent_payment (marks billing_intent paid, inserts payment_attempts)
    const syntheticPayload = {
      event: "payment.captured",
      event_id: `recovery:${billing_intent_id}:${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: razorpay_payment_id,
            amount: rzPayment.amount,       // minor units (paise/cents)
            currency: rzPayment.currency,
            notes: { intent_id: billing_intent_id },
          },
        },
      },
    }

    const { data: webhookResult, error: webhookErr } = await sb.rpc("record_webhook_and_process_razorpay", {
      p_payload: syntheticPayload,
      p_signature_valid: true,
    })

    if (webhookErr) throw webhookErr

    const webhookStatus = (webhookResult as any)?.status
    console.log("[recover-payment] Webhook processing result:", webhookStatus, webhookResult)

    // 'success', 'ignored' (already processed), or 'error'
    if (webhookStatus === "error") {
      const reason = (webhookResult as any)?.reason ?? "unknown"
      // INTENT_EXPIRED is a hard failure
      if (reason === "INTENT_EXPIRED") {
        return new Response(
          JSON.stringify({ status: "intent_expired", message: "Payment intent has expired. Please contact support." }),
          { status: 200, headers: CORS },
        )
      }
      throw new Error("Webhook processing failed: " + reason)
    }

    // ── 5. Call fulfillment function ─────────────────────────────────────────
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
    const fulfillFn = intent.intent_source === "number_purchase"
      ? "fulfill-number-request"
      : "fulfill-paid-order"

    const fulfillResp = await fetch(`${SUPABASE_URL}/functions/v1/${fulfillFn}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        billing_intent_id,
        payment_event_id: `recovery:${Date.now()}`,
        razorpay_amount_raw: rzPayment.amount,
      }),
    })

    const fulfillResult = await fulfillResp.json()
    console.log("[recover-payment] Fulfillment result:", fulfillResult)

    return new Response(
      JSON.stringify({ status: "recovered", fulfillment: fulfillResult }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const errMsg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || JSON.stringify(err) : String(err))
    console.error("[recover-payment]", errMsg)
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: CORS })
  }
})
