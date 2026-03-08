import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Pricing components
const NUMBER_FEE       = 40.00   // Twilio number monthly lease (first month)
const SETUP_FEE        = 30.00   // One-time provisioning setup
const VOICE_CREDIT_AMT = 20.00   // 100 voice minutes @ $0.20/min
const VOICE_CREDIT_QTY = 100
const SMS_CREDIT_AMT   = 20.00   // 2000 SMS messages @ $0.01/msg
const SMS_CREDIT_QTY   = 2000
// Total is dynamic: $90 for sms-only or voice-only; $110 for both

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS })
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    // Verify user JWT
    const userSb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: userErr } = await userSb.auth.getUser()
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS })
    }

    const body = await req.json()
    const { area_code, channel = "sms" } = body

    if (!["sms", "voice", "both"].includes(channel)) {
      return new Response(JSON.stringify({ error: "channel must be sms|voice|both" }), { status: 400, headers: CORS })
    }

    // Resolve org_id
    const { data: members } = await sb.from("org_members").select("org_id").eq("user_id", user.id).limit(1)
    const org_id = members?.[0]?.org_id
    if (!org_id) {
      return new Response(JSON.stringify({ error: "No organisation found" }), { status: 400, headers: CORS })
    }

    // Idempotency: one pending number purchase per org at a time
    const { data: existing } = await sb
      .from("orders")
      .select("id, billing_intent_id")
      .eq("org_id", org_id)
      .eq("order_type", "number_purchase")
      .in("status", ["payment_pending"])
      .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString()) // 30-min window
      .limit(1)

    if (existing && existing.length > 0 && existing[0].billing_intent_id) {
      return new Response(
        JSON.stringify({ intent_id: existing[0].billing_intent_id, reused: true }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const ref = `GSC-${Date.now()}`

    // Dynamic pricing: include voice credits only for voice/both, SMS credits only for sms/both
    const includeVoice = channel === "voice" || channel === "both"
    const includeSms   = channel === "sms"   || channel === "both"
    const totalAmount  = NUMBER_FEE + SETUP_FEE + (includeVoice ? VOICE_CREDIT_AMT : 0) + (includeSms ? SMS_CREDIT_AMT : 0)

    // 1. Create order
    const { data: order, error: orderErr } = await sb.from("orders").insert({
      org_id,
      order_type: "number_purchase",
      status: "payment_pending",
      subtotal_amount: totalAmount,
      total_amount: totalAmount,
      customer_visible_reference: ref,
      created_by_user_id: user.id,
      metadata: { channel, area_code: area_code || null },
    }).select("id").single()
    if (orderErr) throw orderErr

    // 2. Create order lines
    const { error: line1Err } = await sb.from("order_lines").insert({
      order_id: order.id,
      line_type: "number_fee",
      description: "Dedicated Phone Number — first month",
      quantity: 1,
      unit_amount: NUMBER_FEE,
      line_amount: NUMBER_FEE,
      token_key: null,
      token_quantity: null,
    })
    if (line1Err) throw line1Err

    const { error: line2Err } = await sb.from("order_lines").insert({
      order_id: order.id,
      line_type: "setup_fee",
      description: "Number Setup & Configuration",
      quantity: 1,
      unit_amount: SETUP_FEE,
      line_amount: SETUP_FEE,
      token_key: null,
      token_quantity: null,
    })
    if (line2Err) throw line2Err

    if (includeVoice) {
      const { error: line3Err } = await sb.from("order_lines").insert({
        order_id: order.id,
        line_type: "credit_voice",
        description: "Bundled Voice Minutes (100 min)",
        quantity: VOICE_CREDIT_QTY,
        unit_amount: 0.20,
        line_amount: VOICE_CREDIT_AMT,
        token_key: "voice_min",
        token_quantity: VOICE_CREDIT_QTY,
      })
      if (line3Err) throw line3Err
    }

    if (includeSms) {
      const { error: line4Err } = await sb.from("order_lines").insert({
        order_id: order.id,
        line_type: "credit_sms",
        description: "Bundled SMS Credits (2000 messages)",
        quantity: SMS_CREDIT_QTY,
        unit_amount: 0.01,
        line_amount: SMS_CREDIT_AMT,
        token_key: "sms_msg",
        token_quantity: SMS_CREDIT_QTY,
      })
      if (line4Err) throw line4Err
    }

    // 3. Create billing_intent
    const { data: intent, error: intentErr } = await sb.from("billing_intents").insert({
      org_id,
      created_by: user.id,
      source: "billing",
      billing_cycle: "monthly",
      status: "created",
      intent_source: "number_purchase",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      reference_id: ref,
      services: {},
      addons: {},
      channels: {},
      pricing_snapshot: {
        version: "1",
        final_invoice_amount: totalAmount,
        currency: "USD",
        breakdown: {
          number_fee: NUMBER_FEE,
          setup_fee: SETUP_FEE,
          voice_credit_qty: includeVoice ? VOICE_CREDIT_QTY : 0,
          voice_credit_amt: includeVoice ? VOICE_CREDIT_AMT : 0,
          sms_credit_qty: includeSms ? SMS_CREDIT_QTY : 0,
          sms_credit_amt: includeSms ? SMS_CREDIT_AMT : 0,
          channel,
          area_code: area_code || null,
        },
        order_id: order.id,
        description: "Dedicated Phone Number + Credits Bundle",
      },
    }).select("id").single()
    if (intentErr) throw intentErr

    // 4. Link billing_intent to order
    await sb.from("orders").update({ billing_intent_id: intent.id }).eq("id", order.id)

    // 5. Audit
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "user",
      actor_id: user.id,
      object_type: "order",
      object_id: order.id,
      action: "number_purchase_order_created",
      after_state: { order_id: order.id, total: totalAmount, channel, area_code: area_code || null, billing_intent_id: intent.id, voice_min: includeVoice ? VOICE_CREDIT_QTY : 0, sms_msg: includeSms ? SMS_CREDIT_QTY : 0 },
    })

    return new Response(
      JSON.stringify({ intent_id: intent.id, reference: ref, amount: totalAmount }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const errMsg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || JSON.stringify(err) : String(err))
    console.error("[create-number-purchase-order]", errMsg, err)
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: CORS })
  }
})
