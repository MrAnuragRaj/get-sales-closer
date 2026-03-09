import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// export-and-delete-org-data
// Two call paths:
// A. User call (JWT auth): immediate → export+email+delete now; end_of_term → set flag only (no CSV yet).
// B. Internal call (service role + scheduled:true from pg_cron): export+email+delete now for that org.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows?.length) return cols.join(",") + "\n"
  const escape = (v: unknown) => {
    const s = String(v ?? "").replace(/"/g, '""')
    return s.includes(",") || s.includes("\n") || s.includes('"') ? `"${s}"` : s
  }
  return cols.join(",") + "\n" + rows.map(r => cols.map(c => escape(r[c])).join(",")).join("\n")
}

async function exportAndDelete(sb: ReturnType<typeof createClient>, org_id: string, cancellation_id: string, user_email: string) {
  // Export
  const [leadsRes, interactionsRes, appointmentsRes] = await Promise.all([
    sb.from("leads").select("id, name, phone, email, status, source, ai_paused, is_dnc, created_at").eq("org_id", org_id).order("created_at"),
    sb.from("interactions").select("id, lead_id, channel, direction, content, intent, created_at").eq("org_id", org_id).order("created_at"),
    sb.from("appointments").select("id, lead_id, title, status, scheduled_at, notes, created_at").eq("org_id", org_id).order("created_at"),
  ])
  const leadsCsv = toCsv(leadsRes.data ?? [], ["id", "name", "phone", "email", "status", "source", "ai_paused", "is_dnc", "created_at"])
  const interactionsCsv = toCsv(interactionsRes.data ?? [], ["id", "lead_id", "channel", "direction", "content", "intent", "created_at"])
  const appointmentsCsv = toCsv(appointmentsRes.data ?? [], ["id", "lead_id", "title", "status", "scheduled_at", "notes", "created_at"])
  const leadCount = leadsRes.data?.length ?? 0
  const interactionCount = interactionsRes.data?.length ?? 0
  const appointmentCount = appointmentsRes.data?.length ?? 0

  // Fetch display names
  const [orgRes] = await Promise.all([
    sb.from("organizations").select("name").eq("id", org_id).maybeSingle(),
  ])
  const orgName = orgRes.data?.name || "your organization"

  // Send email
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? ""
  if (RESEND_API_KEY && user_email) {
    const htmlBody = `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#020617;color:#e2e8f0;">
  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;">Your Data Export</h1>
  <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Your data has been permanently deleted from our systems. Please find your complete data export attached below.</p>
  <div style="background:#0f172a;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="margin:0 0 10px;font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Attached Files</p>
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#e2e8f0;line-height:2;">
      <li>leads.csv &mdash; ${leadCount} contacts</li>
      <li>interactions.csv &mdash; ${interactionCount} conversation records</li>
      <li>appointments.csv &mdash; ${appointmentCount} appointments</li>
    </ul>
  </div>
  <p style="font-size:13px;color:#64748b;line-height:1.7;margin:0;">We truly valued the relationship we built with you and <strong style="color:#94a3b8;">${orgName}</strong>. Wishing you every success ahead.<br><br>If you ever decide to come back, all your configuration can be restored — just reach out.<br><br>— The GetSalesCloser Team</p>
</div>`
    const emailResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "support@getsalescloser.com",
        to: user_email,
        subject: `Your ${orgName} data export — GetSalesCloser`,
        html: htmlBody,
        attachments: [
          { filename: "leads.csv",        content: toBase64(leadsCsv) },
          { filename: "interactions.csv", content: toBase64(interactionsCsv) },
          { filename: "appointments.csv", content: toBase64(appointmentsCsv) },
        ],
      }),
    })
    if (!emailResp.ok) console.error("[export-and-delete-org-data] Resend error:", emailResp.status, await emailResp.text())
    else console.log("[export-and-delete-org-data] export email sent to:", user_email)
  }

  // Delete
  await performDataDeletion(sb, org_id)
  await sb.from("subscription_cancellations").update({ data_deletion_processed_at: new Date().toISOString() }).eq("id", cancellation_id)
  console.log("[export-and-delete-org-data] data deleted for org:", org_id)
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })

  try {
    const authHeader = req.headers.get("Authorization") ?? ""
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS })

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
    const body = await req.json()

    // ── Path B: Internal pg_cron call ─────────────────────────────────────────
    const isInternalCall = body?.scheduled === true &&
      authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`

    if (isInternalCall) {
      const { org_id, user_id } = body
      if (!org_id || !user_id) return new Response(JSON.stringify({ error: "org_id and user_id required" }), { status: 400, headers: CORS })

      const { data: cancellation } = await sb
        .from("subscription_cancellations")
        .select("id")
        .eq("org_id", org_id)
        .eq("data_deletion_requested", true)
        .is("data_deletion_processed_at", null)
        .order("requested_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!cancellation) return new Response(JSON.stringify({ status: "no_pending_deletion" }), { status: 200, headers: CORS })

      const { data: userRow } = await sb.from("auth.users").select("email").eq("id", user_id).maybeSingle().catch(() => ({ data: null }))
      const { data: { user } } = await sb.auth.admin.getUserById(user_id)
      const user_email = user?.email ?? ""

      await exportAndDelete(sb, org_id, cancellation.id, user_email)
      return new Response(JSON.stringify({ status: "ok", deleted: true }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } })
    }

    // ── Path A: User call via JWT ─────────────────────────────────────────────
    const userSb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: userErr } = await userSb.auth.getUser()
    if (userErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS })

    // Find most recent cancellation for this user
    const { data: cancellation } = await sb
      .from("subscription_cancellations")
      .select("id, org_id, cancellation_mode, data_deletion_requested, data_deletion_processed_at")
      .eq("user_id", user.id)
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!cancellation) return new Response(JSON.stringify({ error: "No cancellation record found" }), { status: 404, headers: CORS })

    const org_id = cancellation.org_id

    // Guard: agents cannot delete org data
    const { data: membership } = await sb.from("org_members").select("role").eq("user_id", user.id).eq("org_id", org_id).maybeSingle()
    if (membership?.role === "enterprise_agent") return new Response(JSON.stringify({ error: "Agents cannot request data deletion" }), { status: 403, headers: CORS })

    if (cancellation.data_deletion_requested) {
      return new Response(JSON.stringify({ status: "already_requested", message: "Data deletion already scheduled." }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } })
    }

    const isImmediate = cancellation.cancellation_mode === "immediate"

    if (!isImmediate) {
      // End-of-term: just flag it — export+delete happens on service_ends_at via pg_cron
      await sb.from("subscription_cancellations").update({ data_deletion_requested: true }).eq("id", cancellation.id)
      return new Response(
        JSON.stringify({ status: "ok", deleted: false, scheduled: true }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    // Immediate: export + send email + delete now
    await sb.from("subscription_cancellations").update({ data_deletion_requested: true }).eq("id", cancellation.id)
    await exportAndDelete(sb, org_id, cancellation.id, user.email ?? "")

    return new Response(
      JSON.stringify({ status: "ok", deleted: true }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || (err as any).details || JSON.stringify(err) : String(err))
    console.error("[export-and-delete-org-data]", msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS })
  }
})

async function performDataDeletion(sb: ReturnType<typeof createClient>, org_id: string) {
  await sb.from("delivery_attempts").delete().eq("org_id", org_id)
  await sb.from("message_threads").delete().eq("org_id", org_id)
  await sb.from("voice_calls").delete().eq("org_id", org_id)
  await sb.from("voice_usage").delete().eq("org_id", org_id)
  await sb.from("conversation_state").delete().eq("org_id", org_id)
  await sb.from("campaign_leads").delete().in(
    "campaign_id",
    (await sb.from("campaigns").select("id").eq("org_id", org_id)).data?.map((r: any) => r.id) ?? [],
  )
  await sb.from("execution_tasks").delete().eq("org_id", org_id)
  await sb.from("decision_plans").delete().eq("org_id", org_id)
  await sb.from("interactions").delete().eq("org_id", org_id)
  await sb.from("appointments").delete().eq("org_id", org_id)
  await sb.from("leads").delete().eq("org_id", org_id)
  await sb.from("campaigns").delete().eq("org_id", org_id)
  await sb.from("knowledge_base").delete().eq("org_id", org_id)
  await sb.from("org_settings").delete().eq("org_id", org_id)
  await sb.from("org_prompts").delete().eq("org_id", org_id)
  await sb.from("org_channels").delete().eq("org_id", org_id)
}
