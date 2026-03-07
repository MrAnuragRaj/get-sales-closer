import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// execute-refund
// Called by confirm-cancellation for immediate cancellations.
// Properties:
//  1. IDEMPOTENCY: refund_executions.idempotency_key UNIQUE prevents double-refund.
//  2. NOT_APPLICABLE: if net_refund = 0, marks status=not_applicable without calling Razorpay.
//  3. PAYMENT LOOKUP: finds original Razorpay payment_id from payment_attempts table.
//  4. AUDIT: all outcomes written to audit_events.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json()
    const { cancellation_id, refund_quote_id, org_id } = body

    if (!cancellation_id || !refund_quote_id || !org_id) {
      return new Response(
        JSON.stringify({ error: "cancellation_id, refund_quote_id, org_id required" }),
        { status: 400, headers: CORS },
      )
    }

    const idempotency_key = `refund:${cancellation_id}:${refund_quote_id}`

    // ── 1. Idempotency guard ──────────────────────────────────────────────────
    const { data: existing } = await sb
      .from("refund_executions")
      .select("id, status, provider_refund_id")
      .eq("idempotency_key", idempotency_key)
      .maybeSingle()

    if (existing) {
      return new Response(
        JSON.stringify({ skipped: true, execution_id: existing.id, status: existing.status }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // ── 2. Fetch refund quote ─────────────────────────────────────────────────
    const { data: quote } = await sb
      .from("refund_quotes")
      .select("id, net_refund_amount, refund_breakdown")
      .eq("id", refund_quote_id)
      .single()

    if (!quote) {
      return new Response(JSON.stringify({ error: "Refund quote not found" }), { status: 404, headers: CORS })
    }

    const netRefund = Number(quote.net_refund_amount ?? 0)

    // ── 3. Not applicable if amount = 0 ──────────────────────────────────────
    if (netRefund <= 0) {
      const { data: execRow } = await sb.from("refund_executions").insert({
        org_id,
        cancellation_id,
        refund_quote_id,
        idempotency_key,
        amount: 0,
        status: "not_applicable",
        completed_at: new Date().toISOString(),
        metadata: { reason: "net_refund_zero" },
      }).select("id").single()

      await sb.from("audit_events").insert({
        org_id,
        actor_type: "system",
        object_type: "refund_execution",
        object_id: execRow?.id ?? cancellation_id,
        action: "refund_not_applicable",
        after_state: { cancellation_id, refund_quote_id, net_refund: 0 },
      })

      return new Response(
        JSON.stringify({ status: "not_applicable", amount: 0 }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // ── 4. Find original payment_id from billing_intent → payment_attempts ────
    const { data: cancellation } = await sb
      .from("subscription_cancellations")
      .select("subscription_contract_id")
      .eq("id", cancellation_id)
      .single()

    const { data: contract } = cancellation
      ? await sb.from("subscription_contracts").select("billing_intent_id").eq("id", cancellation.subscription_contract_id).single()
      : { data: null }

    let razorpay_payment_id: string | null = null
    if (contract?.billing_intent_id) {
      const { data: attempt } = await sb
        .from("payment_attempts")
        .select("provider_payment_id")
        .eq("billing_intent_id", contract.billing_intent_id)
        .eq("status", "captured")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      razorpay_payment_id = attempt?.provider_payment_id ?? null
    }

    // ── 5. Create execution record before calling Razorpay (idempotency anchor) ─
    const { data: execRow, error: execInsertErr } = await sb.from("refund_executions").insert({
      org_id,
      cancellation_id,
      refund_quote_id,
      idempotency_key,
      amount: netRefund,
      provider: "razorpay",
      status: "pending",
      metadata: {
        razorpay_payment_id,
        refund_breakdown: quote.refund_breakdown,
      },
    }).select("id").single()

    if (execInsertErr) throw execInsertErr

    // ── 6. If no payment_id found, cannot process refund ─────────────────────
    if (!razorpay_payment_id) {
      await sb.from("refund_executions").update({
        status: "failed",
        failure_reason: "PAYMENT_ID_NOT_FOUND",
        completed_at: new Date().toISOString(),
      }).eq("id", execRow.id)

      await sb.from("audit_events").insert({
        org_id,
        actor_type: "system",
        object_type: "refund_execution",
        object_id: execRow.id,
        action: "refund_failed_no_payment_id",
        after_state: { cancellation_id, refund_quote_id, net_refund: netRefund },
      })

      return new Response(
        JSON.stringify({ status: "failed", reason: "PAYMENT_ID_NOT_FOUND", execution_id: execRow.id }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // ── 7. Call Razorpay Refund API ───────────────────────────────────────────
    const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID")!
    const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!

    // Razorpay amount is in paise (1 INR = 100 paise)
    const amountPaise = Math.round(netRefund * 100)

    let razorpayResp: Response
    try {
      razorpayResp = await fetch(
        `https://api.razorpay.com/v1/payments/${razorpay_payment_id}/refund`,
        {
          method: "POST",
          headers: {
            "Authorization": `Basic ${btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ amount: amountPaise, speed: "optimum" }),
        },
      )
    } catch (networkErr) {
      await sb.from("refund_executions").update({
        status: "failed",
        failure_reason: `NETWORK_ERROR: ${String(networkErr)}`,
        completed_at: new Date().toISOString(),
      }).eq("id", execRow.id)

      return new Response(
        JSON.stringify({ status: "failed", reason: "NETWORK_ERROR", execution_id: execRow.id }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const razorpayJson = await razorpayResp.json().catch(() => ({}))

    if (!razorpayResp.ok) {
      const failReason = razorpayJson?.error?.description ?? `RAZORPAY_${razorpayResp.status}`
      await sb.from("refund_executions").update({
        status: "failed",
        failure_reason: `RAZORPAY_ERROR: ${failReason}`,
        completed_at: new Date().toISOString(),
        metadata: { razorpay_error: razorpayJson },
      }).eq("id", execRow.id)

      await sb.from("audit_events").insert({
        org_id,
        actor_type: "system",
        object_type: "refund_execution",
        object_id: execRow.id,
        action: "refund_failed_razorpay",
        after_state: { cancellation_id, net_refund: netRefund, razorpay_error: failReason },
      })

      return new Response(
        JSON.stringify({ status: "failed", reason: failReason, execution_id: execRow.id }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const provider_refund_id = razorpayJson?.id ?? null

    // ── 8. Mark succeeded ─────────────────────────────────────────────────────
    await sb.from("refund_executions").update({
      status: "succeeded",
      provider_refund_id,
      completed_at: new Date().toISOString(),
      metadata: { razorpay_refund: razorpayJson },
    }).eq("id", execRow.id)

    // ── 9. Audit ──────────────────────────────────────────────────────────────
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "system",
      object_type: "refund_execution",
      object_id: execRow.id,
      action: "refund_succeeded",
      after_state: {
        cancellation_id,
        refund_quote_id,
        net_refund: netRefund,
        provider_refund_id,
        razorpay_payment_id,
      },
    })

    console.log(`[execute-refund] Succeeded: org=${org_id} amount=${netRefund} refund_id=${provider_refund_id}`)

    return new Response(
      JSON.stringify({ status: "succeeded", execution_id: execRow.id, provider_refund_id, amount: netRefund }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("[execute-refund]", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS })
  }
})
