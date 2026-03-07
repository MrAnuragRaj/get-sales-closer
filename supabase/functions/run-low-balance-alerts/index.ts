import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Cron: runs every 15 minutes via pg_cron or Supabase scheduled invocation.
// Checks all org credit_wallets against thresholds.
// Sends email + SMS alerts with 24h cooldown debounce.
// Transitions credit_alert_state: healthy/recovered → low_alerted.
// On balance recovery (wallet > recovery_balance): transitions low_alerted → recovered.

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!
const FROM_EMAIL = "billing@getsalescloser.com"
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!
const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER")!
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const TOKEN_LABELS: Record<string, string> = {
  voice_min:  "Voice Minutes",
  sms_msg:    "SMS Credits",
  ai_credit:  "AI Credits",
  wa_msg:     "WhatsApp Credits",
}

serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const now = new Date()
  let alerts_sent = 0
  let recoveries_marked = 0
  let errors = 0

  try {
    // Fetch all wallets
    const { data: wallets, error: wErr } = await sb
      .from("credit_wallets")
      .select("id, org_id, token_key, available_balance")
    if (wErr) throw wErr

    // Fetch all alert states
    const { data: alertStates, error: aErr } = await sb
      .from("credit_alert_state")
      .select("id, org_id, token_key, threshold_value, recovery_balance, state, cooldown_until, last_alerted_at")
    if (aErr) throw aErr

    // Fetch org members (to get user_ids for contact info)
    const { data: members } = await sb
      .from("org_members")
      .select("org_id, user_id")

    // Fetch all profiles (for phone numbers)
    const { data: profiles } = await sb
      .from("profiles")
      .select("id, phone")

    // Fetch all user emails via admin API
    const { data: { users: allUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 })

    // Helper: get contact info for an org
    function getOrgContacts(org_id: string): { emails: string[]; phones: string[] } {
      const userIds = (members ?? []).filter(m => m.org_id === org_id).map(m => m.user_id)
      const emails: string[] = []
      const phones: string[] = []
      for (const uid of userIds) {
        const u = allUsers?.find(u => u.id === uid)
        if (u?.email) emails.push(u.email)
        const p = profiles?.find(p => p.id === uid)
        if (p?.phone) phones.push(p.phone)
      }
      return { emails, phones }
    }

    for (const wallet of (wallets ?? [])) {
      const balance = Number(wallet.available_balance)
      const relevantAlerts = (alertStates ?? []).filter(
        a => a.org_id === wallet.org_id && a.token_key === wallet.token_key
      )

      for (const alertState of relevantAlerts) {
        const threshold = Number(alertState.threshold_value)
        const recoveryThreshold = Number(alertState.recovery_balance)

        // --- Recovery transition ---
        if (balance >= recoveryThreshold && alertState.state === "low_alerted") {
          await sb.from("credit_alert_state").update({
            state: "recovered",
            updated_at: now.toISOString(),
          }).eq("id", alertState.id)
          recoveries_marked++
          continue
        }

        // --- Alert needed? ---
        if (balance >= threshold) continue  // healthy, no alert needed

        const cooldownOk = !alertState.cooldown_until || new Date(alertState.cooldown_until) < now
        const shouldAlert =
          alertState.state === "healthy" ||
          alertState.state === "recovered" ||
          (alertState.state === "low_alerted" && cooldownOk)

        if (!shouldAlert) continue

        const { emails, phones } = getOrgContacts(wallet.org_id)
        if (emails.length === 0 && phones.length === 0) continue

        const label = TOKEN_LABELS[wallet.token_key] ?? wallet.token_key
        const subject = `Low ${label} Alert — GetSalesCloser`
        const bodyHtml = `
<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;padding:32px;border-radius:16px">
  <h2 style="color:#f87171;margin-bottom:16px">⚠️ Low ${label} Alert</h2>
  <p>Your <strong>${label}</strong> balance is running low:</p>
  <div style="background:#1e293b;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
    <p style="font-size:32px;font-weight:800;color:#f87171;margin:0">${balance.toLocaleString()}</p>
    <p style="color:#94a3b8;margin:8px 0 0">${label} remaining</p>
  </div>
  <p>Top up your credits now to avoid service interruption.</p>
  <a href="https://www.getsalescloser.com/dashboard.html" style="display:inline-block;background:#4f46e5;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:16px">Buy Credits Now</a>
  <p style="color:#64748b;font-size:12px;margin-top:24px">You'll receive another alert in 24 hours if the balance remains low.</p>
</div>`
        const bodyText = `Your ${label} balance is low (${balance.toLocaleString()} remaining). Buy credits: https://www.getsalescloser.com/dashboard.html`

        try {
          // Email alerts
          for (const email of emails) {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: FROM_EMAIL, to: email, subject, html: bodyHtml }),
            })
          }

          // SMS alert (only if cooldown allows — prevents SMS spam on each cron tick)
          if (cooldownOk) {
            for (const phone of phones) {
              const twilioBody = new URLSearchParams({
                From: TWILIO_FROM,
                To: phone,
                Body: bodyText,
              })
              await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${btoa(TWILIO_SID + ":" + TWILIO_TOKEN)}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: twilioBody.toString(),
                },
              )
            }
          }

          // Update alert state — set cooldown 24h
          await sb.from("credit_alert_state").update({
            state: "low_alerted",
            last_alerted_at: now.toISOString(),
            last_balance: balance,
            cooldown_until: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
            updated_at: now.toISOString(),
          }).eq("id", alertState.id)

          alerts_sent++
        } catch (alertErr) {
          console.error(`[run-low-balance-alerts] error for org=${wallet.org_id} key=${wallet.token_key}:`, alertErr)
          errors++
        }
      }
    }

    console.log(`[run-low-balance-alerts] done: alerts_sent=${alerts_sent} recoveries=${recoveries_marked} errors=${errors}`)
    return new Response(
      JSON.stringify({ alerts_sent, recoveries_marked, errors }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  } catch (err) {
    console.error("[run-low-balance-alerts] fatal:", err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 })
  }
})
