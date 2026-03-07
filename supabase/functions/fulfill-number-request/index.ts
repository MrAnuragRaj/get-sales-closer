import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const ADMIN_EMAIL = "billing@getsalescloser.com"
const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!

// Called from webhook-razorpay after payment.captured for number_purchase intents.
// Properties:
//  1. IDEMPOTENCY: idempotency_keys table prevents double-processing.
//  2. AMOUNT INTEGRITY: order.total_amount verified vs intent.pricing_snapshot.final_invoice_amount.
//  3. AUDIT LOGGING: every step written to audit_events.
//  Effect: creates org_channel_provision_requests with status='payment_received'.
//          Marks billing_intent 'paid' so success.html can detect completion.
//          Emails admin to action the provisioning.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const { billing_intent_id, payment_event_id, razorpay_amount_raw } = await req.json()
    if (!billing_intent_id) {
      return new Response(JSON.stringify({ error: "billing_intent_id required" }), { status: 400, headers: CORS })
    }

    // ── 1. Idempotency guard ─────────────────────────────────────────────────────
    const idem_key = `fulfill-number:${billing_intent_id}:${payment_event_id ?? "webhook"}`
    const { error: idemErr } = await sb.from("idempotency_keys").insert({
      scope: "fulfill_number_request",
      idempotency_key: idem_key,
      object_type: "billing_intent",
      object_id: billing_intent_id,
    })
    if (idemErr?.code === "23505") {
      return new Response(JSON.stringify({ fulfilled: true, skipped: true }), { status: 200, headers: CORS })
    }
    if (idemErr) throw idemErr

    // ── 2. Fetch & validate billing_intent ──────────────────────────────────────
    const { data: intent, error: intentErr } = await sb
      .from("billing_intents")
      .select("id, org_id, intent_source, pricing_snapshot, status")
      .eq("id", billing_intent_id)
      .single()
    if (intentErr || !intent) throw new Error("billing_intent not found: " + billing_intent_id)

    if (intent.intent_source !== "number_purchase") {
      return new Response(JSON.stringify({ fulfilled: false, reason: "not_number_purchase" }), { status: 200, headers: CORS })
    }

    const snap = intent.pricing_snapshot as Record<string, unknown>
    const order_id = snap?.order_id as string
    const intent_amount = Number(snap?.final_invoice_amount ?? 0)
    const org_id = intent.org_id as string
    const channel = (snap?.channel as string) ?? "sms"
    const area_code = (snap?.area_code as string) ?? null

    if (!order_id) throw new Error("pricing_snapshot.order_id missing: " + billing_intent_id)

    // ── 3. Amount integrity check (server-to-server) ─────────────────────────────
    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("id, total_amount")
      .eq("id", order_id)
      .single()
    if (orderErr || !order) throw new Error("order not found: " + order_id)

    if (Math.abs(Number(order.total_amount) - intent_amount) > 0.001) {
      await sb.from("audit_events").insert({
        org_id,
        actor_type: "system",
        object_type: "billing_intent",
        object_id: billing_intent_id,
        action: "number_purchase_amount_mismatch",
        after_state: { order_total: order.total_amount, intent_amount, razorpay_amount_raw },
      })
      return new Response(
        JSON.stringify({ error: "Amount integrity check failed", order_total: order.total_amount, intent_amount }),
        { status: 400, headers: CORS },
      )
    }

    // ── 4. Grant bundled credits (voice_min + sms_msg) idempotently ─────────────
    const { data: orderLines } = await sb
      .from("order_lines")
      .select("id, token_key, token_quantity, description")
      .eq("order_id", order_id)
      .not("token_key", "is", null)

    for (const line of orderLines ?? []) {
      const creditIdemKey = `credit-grant:${line.id}:${billing_intent_id}`

      // Resolve or create wallet
      let { data: wallet } = await sb
        .from("credit_wallets")
        .select("id, balance")
        .eq("org_id", org_id)
        .eq("token_key", line.token_key)
        .maybeSingle()

      if (!wallet) {
        const { data: newWallet } = await sb
          .from("credit_wallets")
          .insert({ org_id, token_key: line.token_key, balance: 0 })
          .select("id, balance")
          .single()
        wallet = newWallet
      }

      if (!wallet) {
        console.error(`[fulfill-number-request] Could not resolve wallet for token_key=${line.token_key}`)
        continue
      }

      // Ledger entry first — unique key is the idempotency guard
      const { error: ledgerErr } = await sb.from("credit_ledger").insert({
        org_id,
        wallet_id: wallet.id,
        token_key: line.token_key,
        entry_type: "grant",
        quantity: line.token_quantity,
        balance_after: 0, // placeholder; patched below
        idempotency_key: creditIdemKey,
        source: "number_purchase_bundle",
        reference_id: billing_intent_id,
        metadata: { billing_intent_id, order_line_id: line.id, description: line.description },
      })

      if (ledgerErr?.code === "23505") {
        console.log(`[fulfill-number-request] Credit already granted for line ${line.id} — skipping`)
        continue
      }
      if (ledgerErr) throw ledgerErr

      // Atomic wallet increment
      const { data: newBalance, error: walletRpcErr } = await sb.rpc("credit_wallet_add_v1", {
        p_wallet_id: wallet.id,
        p_quantity: line.token_quantity,
      })
      if (walletRpcErr) throw walletRpcErr

      // Patch ledger balance_after with authoritative value
      await sb.from("credit_ledger")
        .update({ balance_after: newBalance })
        .eq("idempotency_key", creditIdemKey)

      console.log(`[fulfill-number-request] Granted ${line.token_quantity} ${line.token_key} — new balance: ${newBalance}`)
    }

    // ── 6. Fetch org name for admin notification ─────────────────────────────────
    const { data: orgRow } = await sb.from("organizations").select("name").eq("id", org_id).maybeSingle()
    const org_name = orgRow?.name ?? org_id

    // ── 7. Fetch requesting user's email ────────────────────────────────────────
    const { data: { user: reqUser } } = await sb.auth.admin.getUserById(intent.created_by ?? "").catch(() => ({ data: { user: null } }))
    const requester_email = reqUser?.email ?? "unknown"

    // ── 8. Create provisioning request (status = payment_received) ───────────────
    const prov_idem_key = `prov-req:${billing_intent_id}`
    const { data: provReq, error: provErr } = await sb.from("org_channel_provision_requests").insert({
      org_id,
      created_by: intent.created_by,
      channel,
      mode: "purchase",
      provider: "twilio",
      country: "US",
      area_code: area_code || null,
      status: "payment_received",
      idempotency_key: prov_idem_key,
      detail: {
        billing_intent_id,
        order_id,
        amount_paid: intent_amount,
        area_code,
        channel,
        requester_email,
        razorpay_amount_raw: razorpay_amount_raw ?? null,
      },
    }).select("id").single()

    if (provErr?.code === "23505") {
      console.log("[fulfill-number-request] Provision request already exists for intent:", billing_intent_id)
    } else if (provErr) {
      throw provErr
    }

    // ── 9. Mark order as payment_received ────────────────────────────────────────
    await sb.from("orders").update({ status: "payment_received" }).eq("id", order_id)

    // ── 10. Mark billing_intent paid (success.html polling) ──────────────────────
    await sb.from("billing_intents").update({ status: "paid" }).eq("id", billing_intent_id)

    // ── 11. Email admin ───────────────────────────────────────────────────────────
    try {
      const adminHtml = `
<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;padding:32px;border-radius:16px">
  <h2 style="color:#818cf8;margin-bottom:16px">📞 New Number Purchase — Action Required</h2>
  <p>A customer has paid for a dedicated phone number and requires provisioning.</p>
  <div style="background:#1e293b;border-radius:12px;padding:20px;margin:20px 0">
    <p><strong>Org:</strong> ${org_name}</p>
    <p><strong>Org ID:</strong> ${org_id}</p>
    <p><strong>Channel:</strong> ${channel}</p>
    <p><strong>Area Code Preference:</strong> ${area_code || "Any"}</p>
    <p><strong>Requested by:</strong> ${requester_email}</p>
    <p><strong>Amount Paid:</strong> $${intent_amount.toFixed(2)}</p>
    <p><strong>Provision Request ID:</strong> ${provReq?.id ?? "see DB"}</p>
  </div>
  <a href="https://www.getsalescloser.com/admin.html" style="display:inline-block;background:#4f46e5;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Open Admin Panel</a>
  <p style="color:#64748b;font-size:12px;margin-top:24px">Provision the number in the Number Provisioning Queue section.</p>
</div>`

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: ADMIN_EMAIL,
          to: "anurag@yogmayaindustries.com",
          subject: `Number Purchase — ${org_name} ($${intent_amount.toFixed(2)})`,
          html: adminHtml,
        }),
      })
    } catch (emailErr) {
      console.warn("[fulfill-number-request] Admin email failed (non-fatal):", emailErr)
    }

    // ── 12. Audit ────────────────────────────────────────────────────────────────
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "system",
      object_type: "order",
      object_id: order_id,
      action: "number_purchase_fulfilled",
      after_state: {
        billing_intent_id,
        provision_request_id: provReq?.id,
        amount_paid: intent_amount,
        channel,
        area_code,
        razorpay_amount_raw: razorpay_amount_raw ?? null,
      },
    })

    console.log(`[fulfill-number-request] Fulfilled: org=${org_id} amount=$${intent_amount} channel=${channel}`)
    return new Response(
      JSON.stringify({ fulfilled: true, provision_request_id: provReq?.id }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("[fulfill-number-request]", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS })
  }
})
