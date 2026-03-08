import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// export-and-delete-org-data
// Called from cancel.html when user clicks "Delete My Data".
// 1. Exports leads + interactions + appointments as CSV attachments.
// 2. Sends export email via Resend.
// 3. For immediate cancellations: deletes all org data now.
// 4. For end_of_term: marks data_deletion_requested=true; deletion runs via pg_cron on service_ends_at.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Safe base64 encoding for UTF-8 content
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
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

    // ── 1. Resolve org ────────────────────────────────────────────────────────
    const { data: members } = await sb.from("org_members").select("org_id, role").eq("user_id", user.id).limit(1)
    const membership = members?.[0]
    if (!membership) {
      return new Response(JSON.stringify({ error: "No organisation found" }), { status: 400, headers: CORS })
    }
    if (membership.role === "enterprise_agent") {
      return new Response(JSON.stringify({ error: "Agents cannot request data deletion" }), { status: 403, headers: CORS })
    }
    const org_id = membership.org_id

    // ── 2. Verify cancellation record ─────────────────────────────────────────
    const { data: cancellation } = await sb
      .from("subscription_cancellations")
      .select("id, cancellation_mode, data_deletion_requested, data_deletion_processed_at")
      .eq("org_id", org_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!cancellation) {
      return new Response(JSON.stringify({ error: "No cancellation record found" }), { status: 404, headers: CORS })
    }
    if (cancellation.data_deletion_requested) {
      return new Response(
        JSON.stringify({ status: "already_requested", message: "Data deletion already scheduled." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      )
    }

    const isImmediate = cancellation.cancellation_mode === "immediate"

    // ── 3. Export data ────────────────────────────────────────────────────────
    const [leadsRes, interactionsRes, appointmentsRes] = await Promise.all([
      sb.from("leads")
        .select("id, name, phone, email, status, source, ai_paused, is_dnc, created_at")
        .eq("org_id", org_id)
        .order("created_at"),
      sb.from("interactions")
        .select("id, lead_id, channel, direction, content, intent, created_at")
        .eq("org_id", org_id)
        .order("created_at"),
      sb.from("appointments")
        .select("id, lead_id, title, status, scheduled_at, notes, created_at")
        .eq("org_id", org_id)
        .order("created_at"),
    ])

    const leadsCsv = toCsv(leadsRes.data ?? [], ["id", "name", "phone", "email", "status", "source", "ai_paused", "is_dnc", "created_at"])
    const interactionsCsv = toCsv(interactionsRes.data ?? [], ["id", "lead_id", "channel", "direction", "content", "intent", "created_at"])
    const appointmentsCsv = toCsv(appointmentsRes.data ?? [], ["id", "lead_id", "title", "status", "scheduled_at", "notes", "created_at"])

    const leadCount = leadsRes.data?.length ?? 0
    const interactionCount = interactionsRes.data?.length ?? 0
    const appointmentCount = appointmentsRes.data?.length ?? 0

    // ── 4. Mark deletion requested ────────────────────────────────────────────
    await sb.from("subscription_cancellations")
      .update({ data_deletion_requested: true })
      .eq("id", cancellation.id)

    // ── 5. Fetch names for email ──────────────────────────────────────────────
    const [profileRes, orgRes, contractRes] = await Promise.all([
      sb.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
      sb.from("organizations").select("name").eq("id", org_id).maybeSingle(),
      sb.from("subscription_contracts")
        .select("cycle_end_at")
        .eq("org_id", org_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    const userName = profileRes.data?.full_name || "there"
    const orgName = orgRes.data?.name || "your organization"
    const endDate = contractRes.data?.cycle_end_at
      ? new Date(contractRes.data.cycle_end_at).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })
      : null

    // ── 6. Send export email with CSV attachments ─────────────────────────────
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? ""
    if (RESEND_API_KEY && user.email) {
      const subject = isImmediate
        ? `Your ${orgName} data export — GetSalesCloser`
        : `Your ${orgName} data backup — deletion scheduled for ${endDate}`

      const bodyLine = isImmediate
        ? `Your data has been permanently deleted from our systems. Please find your complete data export attached below.`
        : `Your data will be permanently deleted from our systems on <strong style="color:#ffffff;">${endDate}</strong>. We're sending you a full backup now so you never lose your work.`

      const htmlBody = `
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#020617;color:#e2e8f0;">
  <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 8px;">Your Data Export</h1>
  <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Hi ${userName}, ${bodyLine}</p>
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
          to: user.email,
          subject,
          html: htmlBody,
          attachments: [
            { filename: "leads.csv",        content: toBase64(leadsCsv) },
            { filename: "interactions.csv", content: toBase64(interactionsCsv) },
            { filename: "appointments.csv", content: toBase64(appointmentsCsv) },
          ],
        }),
      })
      if (!emailResp.ok) {
        const errBody = await emailResp.text()
        console.error("[export-and-delete-org-data] Resend error:", emailResp.status, errBody)
      } else {
        console.log("[export-and-delete-org-data] export email sent to:", user.email)
      }
    }

    // ── 7. Delete data (immediate only; end_of_term handled by pg_cron) ───────
    if (isImmediate) {
      await performDataDeletion(sb, org_id)
      await sb.from("subscription_cancellations")
        .update({ data_deletion_processed_at: new Date().toISOString() })
        .eq("id", cancellation.id)
      console.log("[export-and-delete-org-data] data deleted for org:", org_id)
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        deleted: isImmediate,
        scheduled_deletion_date: isImmediate ? null : endDate,
        email_sent: !!(RESEND_API_KEY && user.email),
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : (typeof err === "object" && err !== null ? (err as any).message || (err as any).details || JSON.stringify(err) : String(err))
    console.error("[export-and-delete-org-data]", msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS })
  }
})

async function performDataDeletion(sb: ReturnType<typeof createClient>, org_id: string) {
  // Delete in FK-safe order: children before parents
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
