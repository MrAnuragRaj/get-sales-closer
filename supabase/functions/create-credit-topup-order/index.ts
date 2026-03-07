import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Frozen pricing — matches roadmap policy decisions
// AI: $0.01 per 30 credits → unit cost per credit = 0.01/30
// Amount computed as: Math.round((qty / 30) * 0.01 * 100) / 100
const CREDIT_CONFIG: Record<string, {
  label: string
  unit_price: number        // per unit (credit/minute/message)
  min_qty: number
  line_type: string
  step: number              // UI step hint returned to frontend
  ai_bundle?: boolean       // special billing: per-30-bundle not per-unit
}> = {
  voice_min:  { label: "Voice Minutes",    unit_price: 0.20,          min_qty: 100,   line_type: "credit_voice", step: 100 },
  sms_msg:    { label: "SMS Credits",      unit_price: 0.01,          min_qty: 2000,  line_type: "credit_sms",   step: 1000 },
  ai_credit:  { label: "AI Credits",       unit_price: 0.01 / 30,     min_qty: 90000, line_type: "credit_ai",    step: 90000, ai_bundle: true },
  wa_msg:     { label: "WhatsApp Credits", unit_price: 0.01,          min_qty: 2000,  line_type: "credit_wa",    step: 1000 },
  rcs_msg:    { label: "RCS Credits",      unit_price: 0.01,          min_qty: 2000,  line_type: "credit_rcs",   step: 1000 },
}

function computeLineAmount(token_key: string, qty: number): number {
  const cfg = CREDIT_CONFIG[token_key]
  if (!cfg) return 0
  if (cfg.ai_bundle) {
    // $0.01 per 30 credits — avoid floating point drift
    return Math.round((qty / 30) * 0.01 * 100) / 100
  }
  return Math.round(qty * cfg.unit_price * 100) / 100
}

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

    // Verify user JWT via anon client
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
    const { token_key, quantity } = body

    // Validate token_key
    const cfg = CREDIT_CONFIG[token_key as string]
    if (!cfg) {
      return new Response(
        JSON.stringify({ error: "Invalid token_key. Must be one of: voice_min, sms_msg, ai_credit, wa_msg" }),
        { status: 400, headers: CORS },
      )
    }

    // Validate quantity
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < cfg.min_qty) {
      return new Response(
        JSON.stringify({ error: `Minimum quantity is ${cfg.min_qty}` }),
        { status: 400, headers: CORS },
      )
    }

    // Resolve org_id from org_members
    const { data: members } = await sb
      .from("org_members")
      .select("org_id")
      .eq("user_id", user.id)
      .limit(1)
    const org_id = members?.[0]?.org_id
    if (!org_id) {
      return new Response(JSON.stringify({ error: "No organisation found for this user" }), { status: 400, headers: CORS })
    }

    // Idempotency: prevent duplicate draft orders within 5 min
    const { data: existingOrders } = await sb
      .from("orders")
      .select("id, billing_intent_id")
      .eq("org_id", org_id)
      .eq("order_type", "credit_topup")
      .eq("status", "payment_pending")
      .filter("metadata->>token_key", "eq", token_key)
      .filter("metadata->>quantity", "eq", String(qty))
      .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .limit(1)

    if (existingOrders && existingOrders.length > 0 && existingOrders[0].billing_intent_id) {
      // Return existing intent for idempotent checkout
      return new Response(
        JSON.stringify({ intent_id: existingOrders[0].billing_intent_id, reused: true }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // Compute total
    const total_amount = computeLineAmount(token_key, qty)
    const description = `${qty.toLocaleString()} ${cfg.label}`
    const ref = `TOP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // 1. Create order
    const { data: order, error: orderErr } = await sb
      .from("orders")
      .insert({
        org_id,
        order_type: "credit_topup",
        status: "payment_pending",
        subtotal_amount: total_amount,
        total_amount,
        customer_visible_reference: ref,
        created_by_user_id: user.id,
        metadata: { token_key, quantity: qty },
      })
      .select("id")
      .single()
    if (orderErr) throw orderErr

    // 2. Create order line
    const { data: line, error: lineErr } = await sb
      .from("order_lines")
      .insert({
        order_id: order.id,
        line_type: cfg.line_type,
        description,
        quantity: qty,
        unit_amount: cfg.ai_bundle ? (0.01 / 30) : cfg.unit_price,
        line_amount: total_amount,
        token_key,
        token_quantity: qty,
      })
      .select("id")
      .single()
    if (lineErr) throw lineErr

    // 3. Create billing_intent (so payment.html can read it)
    const { data: intent, error: intentErr } = await sb
      .from("billing_intents")
      .insert({
        org_id,
        created_by: user.id,
        source: "credit_topup",
        billing_cycle: "one_time",
        status: "created",
        intent_source: "credit_topup",
        reference_id: ref,
        pricing_snapshot: {
          final_invoice_amount: total_amount,
          order_id: order.id,
          order_line_id: line.id,
          token_key,
          quantity: qty,
          description,
        },
      })
      .select("id")
      .single()
    if (intentErr) throw intentErr

    // 4. Link billing_intent back to order
    await sb.from("orders").update({ billing_intent_id: intent.id }).eq("id", order.id)

    // 5. Audit
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "user",
      actor_id: user.id,
      object_type: "order",
      object_id: order.id,
      action: "credit_topup_order_created",
      after_state: { token_key, quantity: qty, total_amount, billing_intent_id: intent.id },
    })

    return new Response(
      JSON.stringify({
        intent_id: intent.id,
        reference: ref,
        amount: total_amount,
        description,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("[create-credit-topup-order]", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS })
  }
})
