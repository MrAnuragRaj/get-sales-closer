import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// initiate-cancellation
// Step 1 of the cancellation flow (called from cancel.html).
// Properties:
//  1. FEEDBACK MANDATORY: requires reason_code before computing refund.
//  2. QUOTE FROM CONTRACT: refund computed from subscription_contracts.gross_amount, not ad hoc pricing.
//  3. EXCLUSIONS: top-up credits always excluded; number fees excluded unless provision failed.
//  4. IDEMPOTENCY: quote expires in 1 hour; one accepted quote per cancellation.
//  5. AUDIT: every action written to audit_events.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    const { cancellation_mode, reason_code, reason_detail, would_recommend } = body

    if (!["immediate", "end_of_term"].includes(cancellation_mode)) {
      return new Response(JSON.stringify({ error: "cancellation_mode must be immediate|end_of_term" }), { status: 400, headers: CORS })
    }
    if (!reason_code) {
      return new Response(JSON.stringify({ error: "reason_code is required" }), { status: 400, headers: CORS })
    }

    // ── 1. Resolve org + role ─────────────────────────────────────────────────
    const { data: members } = await sb
      .from("org_members").select("org_id, role").eq("user_id", user.id).limit(1)
    const membership = members?.[0]
    if (!membership) {
      return new Response(JSON.stringify({ error: "No organisation found" }), { status: 400, headers: CORS })
    }
    const org_id = membership.org_id

    if (membership.role === "enterprise_agent") {
      return new Response(JSON.stringify({ error: "Agents cannot cancel subscription" }), { status: 403, headers: CORS })
    }

    // ── 2. Guard: not already cancelled ──────────────────────────────────────
    const { data: orgRow } = await sb
      .from("organizations").select("name, cancellation_status").eq("id", org_id).single()
    if (orgRow?.cancellation_status) {
      return new Response(
        JSON.stringify({ error: "Organisation is already cancelled", cancellation_status: orgRow.cancellation_status }),
        { status: 409, headers: CORS },
      )
    }

    // ── 3. Active subscription contract ──────────────────────────────────────
    const { data: contracts } = await sb
      .from("subscription_contracts")
      .select("id, plan_code, billing_cycle, gross_amount, cycle_start_at, cycle_end_at, is_ambiguous")
      .eq("org_id", org_id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)

    const contract = contracts?.[0]
    if (!contract) {
      return new Response(JSON.stringify({ error: "No active subscription contract found" }), { status: 404, headers: CORS })
    }

    // ── 4. Create feedback (mandatory before quote) ───────────────────────────
    const { data: feedback, error: fbErr } = await sb
      .from("cancellation_feedback")
      .insert({ org_id, user_id: user.id, reason_code, reason_detail: reason_detail || null, would_recommend: would_recommend ?? null })
      .select("id").single()
    if (fbErr) throw fbErr

    // ── 5. Compute refund quote ───────────────────────────────────────────────
    const now = new Date()
    const endsAt = new Date(contract.cycle_end_at)
    const daysInCycle = contract.billing_cycle === "yearly" ? 366 : 30
    const msRemaining = Math.max(0, endsAt.getTime() - now.getTime())
    const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24))

    let grossRefund = 0
    let excludedCreditsAmount = 0
    let excludedNumberAmount = 0

    if (cancellation_mode === "immediate") {
      grossRefund = Number(contract.gross_amount) * (daysRemaining / daysInCycle)
      grossRefund = Math.max(0, Math.round(grossRefund * 100) / 100)

      // Number purchases are always excluded (Twilio charges are non-refundable)
      const { data: numberPurchases } = await sb
        .from("billing_intents")
        .select("id, pricing_snapshot")
        .eq("org_id", org_id)
        .eq("intent_source", "number_purchase")
        .eq("status", "paid")

      for (const np of numberPurchases ?? []) {
        const numAmount = Number(np.pricing_snapshot?.final_invoice_amount ?? 0)
        if (numAmount <= 0) continue
        // Number purchases are always excluded — Twilio charges are non-refundable
        // regardless of provision status (pending or succeeded)
        excludedNumberAmount += numAmount
      }

      // Top-up credits (always excluded from refund)
      const { data: topups } = await sb
        .from("billing_intents")
        .select("pricing_snapshot")
        .eq("org_id", org_id)
        .eq("intent_source", "credit_topup")
        .eq("status", "paid")

      for (const t of topups ?? []) {
        excludedCreditsAmount += Number(t.pricing_snapshot?.final_invoice_amount ?? 0)
      }
    }

    const netRefund = Math.round(grossRefund * 100) / 100
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const refundBreakdown = {
      subscription_proration: grossRefund,
      excluded_top_up_credits: excludedCreditsAmount,
      excluded_number_fees: excludedNumberAmount,
      contract_gross_amount: contract.gross_amount,
      days_remaining: daysRemaining,
      days_in_cycle: daysInCycle,
      billing_cycle: contract.billing_cycle,
      cycle_end_at: contract.cycle_end_at,
      is_contract_ambiguous: contract.is_ambiguous,
    }

    // ── 6. Create refund_quote ────────────────────────────────────────────────
    const { data: quote, error: quoteErr } = await sb
      .from("refund_quotes")
      .insert({
        org_id,
        user_id: user.id,
        feedback_id: feedback.id,
        subscription_contract_id: contract.id,
        cancellation_mode,
        days_remaining: daysRemaining,
        days_in_cycle: daysInCycle,
        gross_refund_amount: grossRefund,
        excluded_credits_amount: excludedCreditsAmount,
        excluded_number_amount: excludedNumberAmount,
        net_refund_amount: netRefund,
        refund_breakdown: refundBreakdown,
        expires_at: expiresAt,
        status: "pending",
      })
      .select("id").single()
    if (quoteErr) throw quoteErr

    // ── 7. Audit ──────────────────────────────────────────────────────────────
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "user",
      actor_id: user.id,
      object_type: "refund_quote",
      object_id: quote.id,
      action: "cancellation_quote_created",
      after_state: {
        cancellation_mode,
        feedback_id: feedback.id,
        net_refund: netRefund,
        gross_refund: grossRefund,
        days_remaining: daysRemaining,
        contract_id: contract.id,
        is_ambiguous: contract.is_ambiguous,
      },
    })

    return new Response(
      JSON.stringify({
        quote_id: quote.id,
        feedback_id: feedback.id,
        cancellation_mode,
        net_refund_amount: netRefund,
        gross_refund_amount: grossRefund,
        excluded_credits_amount: excludedCreditsAmount,
        excluded_number_amount: excludedNumberAmount,
        days_remaining: daysRemaining,
        service_ends_at: endsAt.toISOString(),
        expires_at: expiresAt,
        refund_breakdown: refundBreakdown,
        is_contract_ambiguous: contract.is_ambiguous,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || (err as any).details || JSON.stringify(err) : String(err))
    console.error("[initiate-cancellation]", msg, err)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS })
  }
})
