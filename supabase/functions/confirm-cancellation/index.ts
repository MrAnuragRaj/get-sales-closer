import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// confirm-cancellation
// Step 2 of the cancellation flow — user accepts refund quote and commits.
// Properties:
//  1. IDEMPOTENCY: quote status guard prevents double-processing.
//  2. IMMEDIATE: cancels org_services, bulk-cancels pending tasks, invokes execute-refund.
//  3. END_OF_TERM: sets service_ends_at; service preserved until that date.
//  4. AUDIT: every state change written to audit_events.

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
    const { quote_id } = body
    if (!quote_id) {
      return new Response(JSON.stringify({ error: "quote_id required" }), { status: 400, headers: CORS })
    }

    // ── 1. Fetch and validate quote ───────────────────────────────────────────
    const { data: quote, error: quoteErr } = await sb
      .from("refund_quotes")
      .select("id, org_id, user_id, feedback_id, subscription_contract_id, cancellation_mode, net_refund_amount, expires_at, status")
      .eq("id", quote_id)
      .single()

    if (quoteErr || !quote) {
      return new Response(JSON.stringify({ error: "Quote not found" }), { status: 404, headers: CORS })
    }

    if (quote.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: CORS })
    }

    if (quote.status !== "pending") {
      return new Response(
        JSON.stringify({ error: "Quote already used or expired", status: quote.status }),
        { status: 409, headers: CORS },
      )
    }

    if (new Date(quote.expires_at) < new Date()) {
      await sb.from("refund_quotes").update({ status: "expired" }).eq("id", quote_id)
      return new Response(JSON.stringify({ error: "Quote has expired. Please restart." }), { status: 410, headers: CORS })
    }

    const org_id = quote.org_id

    // ── 2. Guard: org not already cancelled ──────────────────────────────────
    const { data: orgRow } = await sb
      .from("organizations").select("cancellation_status, service_ends_at").eq("id", org_id).single()
    if (orgRow?.cancellation_status) {
      await sb.from("refund_quotes").update({ status: "voided" }).eq("id", quote_id)
      return new Response(
        JSON.stringify({ error: "Organisation is already cancelled" }),
        { status: 409, headers: CORS },
      )
    }

    // ── 3. Fetch contract ─────────────────────────────────────────────────────
    const { data: contract } = await sb
      .from("subscription_contracts")
      .select("id, cycle_end_at, billing_cycle, gross_amount")
      .eq("id", quote.subscription_contract_id)
      .single()
    if (!contract) {
      return new Response(JSON.stringify({ error: "Subscription contract not found" }), { status: 404, headers: CORS })
    }

    const cancellation_mode = quote.cancellation_mode
    const effectiveAt = cancellation_mode === "immediate"
      ? new Date().toISOString()
      : contract.cycle_end_at

    // ── 4. Mark quote accepted (idempotency anchor) ───────────────────────────
    const { error: quoteAcceptErr } = await sb
      .from("refund_quotes")
      .update({ status: "accepted" })
      .eq("id", quote_id)
      .eq("status", "pending")   // guard: only if still pending
    if (quoteAcceptErr) throw quoteAcceptErr

    // ── 5. Create subscription_cancellation record ────────────────────────────
    const { data: cancellation, error: cancErr } = await sb
      .from("subscription_cancellations")
      .insert({
        org_id,
        user_id: user.id,
        subscription_contract_id: contract.id,
        feedback_id: quote.feedback_id,
        refund_quote_id: quote_id,
        cancellation_mode,
        effective_at: effectiveAt,
        status: "active",
      })
      .select("id").single()
    if (cancErr) throw cancErr

    // ── 6. Update subscription_contract ──────────────────────────────────────
    const contractStatus = cancellation_mode === "immediate" ? "cancelled_immediate" : "cancelled_end_of_term"
    await sb.from("subscription_contracts").update({
      status: contractStatus,
      cancelled_at: new Date().toISOString(),
      cancellation_id: cancellation.id,
    }).eq("id", contract.id)

    // ── 7. Mode-specific enforcement ─────────────────────────────────────────
    if (cancellation_mode === "immediate") {
      // 7a. Set org cancellation status immediately
      await sb.from("organizations").update({
        cancellation_status: "cancelled_immediate",
        service_ends_at: new Date().toISOString(),
      }).eq("id", org_id)

      // 7b. Deactivate all org_services
      await sb.from("org_services").update({ status: "cancelled" }).eq("org_id", org_id)

      // 7c. Bulk-cancel all pending/running execution tasks — IMMEDIATE outbound block
      await sb.from("execution_tasks").update({
        status: "cancelled_org_terminated",
        last_error: "ORG_CANCELLED_IMMEDIATE",
        locked_by: null,
        locked_until: null,
      }).eq("org_id", org_id).in("status", ["pending", "running"])

      // 7d. Pause running campaigns
      await sb.from("campaigns").update({ status: "paused" })
        .eq("org_id", org_id).eq("status", "running")

      // 7e. Invoke execute-refund asynchronously (non-fatal if fails)
      try {
        await sb.functions.invoke("execute-refund", {
          body: {
            cancellation_id: cancellation.id,
            refund_quote_id: quote_id,
            org_id,
          },
        })
      } catch (refundErr) {
        console.warn("[confirm-cancellation] execute-refund invoke failed (non-fatal):", refundErr)
      }
    } else {
      // end_of_term: mark org but preserve service until cycle_end_at
      await sb.from("organizations").update({
        cancellation_status: "cancelled_end_of_term",
        service_ends_at: contract.cycle_end_at,
      }).eq("id", org_id)
    }

    // ── 8. Audit ──────────────────────────────────────────────────────────────
    await sb.from("audit_events").insert({
      org_id,
      actor_type: "user",
      actor_id: user.id,
      object_type: "subscription_cancellation",
      object_id: cancellation.id,
      action: `subscription_cancelled_${cancellation_mode}`,
      after_state: {
        cancellation_id: cancellation.id,
        quote_id,
        cancellation_mode,
        effective_at: effectiveAt,
        net_refund: quote.net_refund_amount,
        contract_id: contract.id,
      },
    })

    // ── 9. Send cancellation email ────────────────────────────────────────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? ""
    if (RESEND_API_KEY && user.email) {
      try {
        const { data: profile } = await sb.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
        const { data: org } = await sb.from("organizations").select("name").eq("id", org_id).maybeSingle()
        const userName = profile?.full_name || "there"
        const orgName = org?.name || "your organization"
        const endDate = new Date(contract.cycle_end_at).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })
        const refundAmt = Number(quote.net_refund_amount)

        let subject: string
        let htmlBody: string

        if (cancellation_mode === "immediate") {
          subject = "Your GetSalesCloser subscription has been cancelled"
          htmlBody = `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#020617;color:#e2e8f0;">
  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;">Subscription Cancelled</h1>
  <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Hi ${userName}, your GetSalesCloser subscription for <strong style="color:#ffffff;">${orgName}</strong> has been cancelled effective immediately.</p>
  ${refundAmt > 0 ? `
  <div style="background:#0f172a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Refund Details</p>
    <p style="margin:0;font-size:24px;font-weight:700;color:#34d399;">$${refundAmt.toFixed(2)}</p>
    <p style="margin:4px 0 0;font-size:12px;color:#64748b;">Will be credited to your original payment method within 5–7 business days.</p>
  </div>` : `
  <div style="background:#0f172a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="margin:0;font-size:13px;color:#94a3b8;">No refund is applicable for this cancellation.</p>
  </div>`}
  <p style="font-size:13px;color:#64748b;margin:0;">If you have any questions, reply to this email or contact us at <a href="mailto:support@getsalescloser.com" style="color:#60a5fa;">support@getsalescloser.com</a>.</p>
</div>`
        } else {
          subject = "Your GetSalesCloser cancellation is scheduled"
          htmlBody = `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#020617;color:#e2e8f0;">
  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;">Cancellation Scheduled</h1>
  <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Hi ${userName}, your cancellation request for <strong style="color:#ffffff;">${orgName}</strong> has been received.</p>
  <div style="background:#0f172a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Access Ends</p>
    <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">${endDate}</p>
    <p style="margin:8px 0 0;font-size:12px;color:#64748b;">You have full access to all services until this date. No refund is issued for end-of-term cancellations.</p>
  </div>
  <p style="font-size:13px;color:#64748b;margin:0;">If you have any questions, reply to this email or contact us at <a href="mailto:support@getsalescloser.com" style="color:#60a5fa;">support@getsalescloser.com</a>.</p>
</div>`
        }

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "billing@getsalescloser.com",
            to: user.email,
            subject,
            html: htmlBody,
          }),
        })
      } catch (emailErr) {
        console.warn("[confirm-cancellation] email send failed (non-fatal):", emailErr)
      }
    }

    return new Response(
      JSON.stringify({
        cancelled: true,
        cancellation_id: cancellation.id,
        cancellation_mode,
        effective_at: effectiveAt,
        net_refund_amount: quote.net_refund_amount,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || (err as any).details || JSON.stringify(err) : String(err))
    console.error("[confirm-cancellation]", msg, err)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS })
  }
})
