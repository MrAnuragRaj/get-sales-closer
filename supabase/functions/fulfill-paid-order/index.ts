import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Called from webhook-razorpay after payment.captured event for credit_topup intents.
//
// Properties guaranteed:
//  1. IDEMPOTENCY: idempotency_keys table prevents double-fulfillment on webhook retries.
//     Per-line guard via credit_ledger.idempotency_key UNIQUE constraint.
//  2. AMOUNT INTEGRITY: server-to-server check — order.total_amount must match
//     billing_intent.pricing_snapshot.final_invoice_amount (both server-computed). Rejects if mismatch.
//  3. LEDGER INTEGRITY: wallet balance updated via atomic DB RPC (credit_wallet_add_v1),
//     which returns the authoritative new balance used in the ledger entry.
//     No read-compute-write race.
//  4. AUDIT LOGGING: every grant + any amount mismatch is written to audit_events.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json()
    const { billing_intent_id, payment_event_id, razorpay_amount_raw } = body
    if (!billing_intent_id) {
      return new Response(JSON.stringify({ error: "billing_intent_id required" }), { status: 400, headers: CORS })
    }

    // ── 1. Idempotency guard (billing_intent level) ─────────────────────────────
    // Key includes payment_event_id so each Razorpay event gets one attempt,
    // but a retry of the same payment also deduplicates.
    const idem_key = `fulfill:${billing_intent_id}:${payment_event_id ?? "webhook"}`
    const { error: idemErr } = await sb.from("idempotency_keys").insert({
      scope: "fulfill_paid_order",
      idempotency_key: idem_key,
      object_type: "billing_intent",
      object_id: billing_intent_id,
    })
    if (idemErr?.code === "23505") {
      console.log("[fulfill-paid-order] Already fulfilled (idempotent skip):", billing_intent_id)
      return new Response(
        JSON.stringify({ fulfilled: true, skipped: true }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }
    if (idemErr) throw idemErr

    // ── 2. Fetch & validate billing_intent ──────────────────────────────────────
    const { data: intent, error: intentErr } = await sb
      .from("billing_intents")
      .select("id, org_id, intent_source, pricing_snapshot, status")
      .eq("id", billing_intent_id)
      .single()
    if (intentErr || !intent) throw new Error("billing_intent not found: " + billing_intent_id)

    if (intent.intent_source !== "credit_topup") {
      return new Response(
        JSON.stringify({ fulfilled: false, reason: "not_credit_topup" }),
        { status: 200, headers: CORS },
      )
    }

    const snap = intent.pricing_snapshot as Record<string, unknown>
    const order_id = snap?.order_id as string
    const intent_amount = Number(snap?.final_invoice_amount ?? 0)
    const org_id = intent.org_id as string

    if (!order_id) throw new Error("pricing_snapshot.order_id missing from billing_intent " + billing_intent_id)

    // ── 3. Fetch order and verify amount integrity (server-to-server) ────────────
    // NEVER trust the webhook payload amount for credit grant decisions.
    // Both sides were computed server-side at order creation time.
    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, total_amount, status, currency")
      .eq("id", order_id)
      .single()
    if (orderErr || !order) throw new Error("order not found: " + order_id)

    const order_total = Number(order.total_amount)
    if (Math.abs(order_total - intent_amount) > 0.001) {
      // Amount mismatch — log fraud event and reject
      await sb.from("audit_events").insert({
        org_id,
        actor_type: "system",
        object_type: "billing_intent",
        object_id: billing_intent_id,
        action: "credit_topup_amount_mismatch",
        after_state: {
          order_total,
          intent_amount,
          razorpay_amount_raw: razorpay_amount_raw ?? null,
          order_id,
        },
      })
      console.error(`[fulfill-paid-order] AMOUNT MISMATCH: order=${order_total} intent=${intent_amount}`)
      return new Response(
        JSON.stringify({ error: "Amount integrity check failed", order_total, intent_amount }),
        { status: 400, headers: CORS },
      )
    }

    // ── 4. Fetch fulfillable order lines ─────────────────────────────────────────
    const { data: lines, error: linesErr } = await sb
      .from("order_lines")
      .select("id, token_key, token_quantity, line_amount")
      .eq("order_id", order_id)
      .not("token_key", "is", null)
    if (linesErr) throw linesErr
    if (!lines || lines.length === 0) throw new Error("No fulfillable order lines for order " + order_id)

    // ── 5. Process each credit line (ledger-first, then atomic wallet update) ────
    const results: Array<{ token_key: string; quantity: number; new_balance: number }> = []

    for (const line of lines) {
      const token_key = line.token_key as string
      const quantity = Number(line.token_quantity)
      const line_idem_key = `credit-grant:${line.id}:${billing_intent_id}`

      // Ensure wallet row exists (safety net — should already exist from seeding)
      const { data: walletRows } = await sb
        .from("credit_wallets")
        .select("id")
        .eq("org_id", org_id)
        .eq("token_key", token_key)
        .limit(1)

      let wallet_id: string
      if (!walletRows || walletRows.length === 0) {
        const { data: newWallet, error: wErr } = await sb
          .from("credit_wallets")
          .insert({ org_id, token_key, available_balance: 0, lifetime_credited: 0, lifetime_debited: 0 })
          .select("id")
          .single()
        if (wErr) throw wErr
        wallet_id = newWallet!.id
      } else {
        wallet_id = walletRows[0].id
      }

      // ── Ledger entry first (idempotency_key UNIQUE prevents duplicate grants) ──
      // balance_after is a temporary placeholder; authoritative value set after atomic wallet update.
      // We use a two-step approach: insert ledger with placeholder=0, then update with real balance.
      // Rationale: the atomic RPC gives us the post-update balance, but we need wallet_id first.
      // Better: use ledger as guard, then do atomic update, then patch ledger balance_after.
      const { error: ledgerErr } = await sb.from("credit_ledger").insert({
        org_id,
        token_key,
        entry_type: "grant",
        direction: "credit",
        quantity,
        balance_after: 0, // placeholder — patched below with atomic result
        wallet_id,
        source_object_type: "order_line",
        source_object_id: line.id,
        idempotency_key: line_idem_key,
        note: `Credit topup — billing_intent ${billing_intent_id}`,
      })
      if (ledgerErr?.code === "23505") {
        // Already written in a previous attempt — skip (idempotent)
        console.log("[fulfill-paid-order] Ledger entry exists (idempotent skip) for line:", line.id)
        continue
      }
      if (ledgerErr) throw ledgerErr

      // ── Atomic wallet increment via DB function (no read-compute-write race) ───
      const { data: new_balance_raw, error: addErr } = await sb.rpc("credit_wallet_add_v1", {
        p_wallet_id: wallet_id,
        p_quantity: quantity,
      })
      if (addErr) throw addErr
      const new_balance = Number(new_balance_raw)

      // ── Patch ledger entry with authoritative balance_after ──────────────────
      await sb.from("credit_ledger")
        .update({ balance_after: new_balance })
        .eq("idempotency_key", line_idem_key)

      // ── Transition alert state to 'recovered' if balance crossed threshold ───
      const { data: alertStates } = await sb
        .from("credit_alert_state")
        .select("id, recovery_balance, state")
        .eq("org_id", org_id)
        .eq("token_key", token_key)

      for (const a of alertStates ?? []) {
        if (a.state === "low_alerted" && new_balance >= Number(a.recovery_balance)) {
          await sb.from("credit_alert_state").update({ state: "recovered" }).eq("id", a.id)
        }
      }

      results.push({ token_key, quantity, new_balance })
      console.log(`[fulfill-paid-order] Granted ${quantity} ${token_key} → org=${org_id} balance=${new_balance}`)
    }

    // ── 6. Mark order fulfilled ──────────────────────────────────────────────────
    await sb.from("orders").update({ status: "fulfilled" }).eq("id", order_id)

    // ── 7. Mark billing_intent paid (success.html polling detects completion) ───
    await sb.from("billing_intents").update({ status: "paid" }).eq("id", billing_intent_id)

    // ── 8. Audit trail ───────────────────────────────────────────────────────────
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "system",
      object_type: "order",
      object_id: order_id,
      action: "credit_order_fulfilled",
      after_state: {
        billing_intent_id,
        lines_fulfilled: results.length,
        grants: results,
        razorpay_amount_raw: razorpay_amount_raw ?? null,
        order_total,
        intent_amount,
      },
    })

    return new Response(
      JSON.stringify({ fulfilled: true, grants: results }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("[fulfill-paid-order]", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS })
  }
})
