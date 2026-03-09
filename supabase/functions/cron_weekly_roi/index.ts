import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = "support@getsalescloser.com";

function metricCard(label: string, value: string, sub?: string): string {
  return `
    <td style="padding:12px 16px;text-align:center;background:#f9fafb;border-radius:8px;min-width:100px;">
      <div style="font-size:24px;font-weight:700;color:#111827;">${value}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:1px;">${sub}</div>` : ""}
    </td>
  `;
}

function buildROIEmail(params: {
  orgName: string;
  recipientName: string;
  weekLabel: string;
  newLeads: number;
  activeLeads: number;
  closedWon: number;
  closedLost: number;
  booked: number;
  smsSent: number;
  emailSent: number;
  voiceMinutes: number;
  voiceCost: number;
  tokensSaved: number;
}): string {
  const {
    orgName, recipientName, weekLabel,
    newLeads, activeLeads, closedWon, closedLost, booked,
    smsSent, emailSent, voiceMinutes, voiceCost, tokensSaved,
  } = params;

  const winRate = closedWon + closedLost > 0
    ? Math.round((closedWon / (closedWon + closedLost)) * 100)
    : 0;

  const estHoursSaved = Math.round((smsSent * 0.05 + emailSent * 0.1 + voiceMinutes * 0.25) * 10) / 10;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:Inter,sans-serif;background:#f3f4f6;margin:0;padding:20px;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1d4ed8,#7c3aed);padding:32px 40px;">
          <p style="color:#bfdbfe;font-size:13px;margin:0 0 4px;">Weekly ROI Report</p>
          <h1 style="color:#fff;margin:0;font-size:24px;">Your AI Closer Report</h1>
          <p style="color:#c4b5fd;margin:8px 0 0;font-size:14px;">${weekLabel} &bull; ${orgName}</p>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="padding:32px 40px 16px;">
          <p style="color:#374151;font-size:15px;margin:0;">Hi ${recipientName},</p>
          <p style="color:#6b7280;font-size:14px;margin:12px 0 0;">Here's what your AI sales team accomplished this week.</p>
        </td></tr>

        <!-- Lead Pipeline -->
        <tr><td style="padding:8px 40px 24px;">
          <p style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin:0 0 12px;">Lead Pipeline</p>
          <table cellpadding="0" cellspacing="8" width="100%">
            <tr>
              ${metricCard("New Leads", String(newLeads), "this week")}
              <td width="8"></td>
              ${metricCard("Active", String(activeLeads), "in pipeline")}
              <td width="8"></td>
              ${metricCard("Closed Won", String(closedWon), `${winRate}% win rate`)}
              <td width="8"></td>
              ${metricCard("Meetings Booked", String(booked), "by AI")}
            </tr>
          </table>
        </td></tr>

        <!-- AI Activity -->
        <tr><td style="padding:8px 40px 24px;">
          <p style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin:0 0 12px;">AI Activity</p>
          <table cellpadding="0" cellspacing="8" width="100%">
            <tr>
              ${metricCard("SMS Sent", String(smsSent))}
              <td width="8"></td>
              ${metricCard("Emails Sent", String(emailSent))}
              <td width="8"></td>
              ${metricCard("Voice Minutes", voiceMinutes.toFixed(1))}
              <td width="8"></td>
              ${metricCard("Hours Saved", String(estHoursSaved), "vs manual")}
            </tr>
          </table>
        </td></tr>

        ${voiceCost > 0 ? `
        <!-- Voice Cost -->
        <tr><td style="padding:0 40px 24px;">
          <div style="background:#fef3c7;border-radius:8px;padding:12px 16px;font-size:13px;color:#92400e;">
            Voice Liaison cost this week: <strong>$${voiceCost.toFixed(2)}</strong> &mdash; covered by your AI credits.
          </div>
        </td></tr>` : ""}

        <!-- CTA -->
        <tr><td style="padding:8px 40px 32px;text-align:center;">
          <a href="https://www.getsalescloser.com/dashboard.html"
             style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">
            Open Dashboard &rarr;
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="font-size:12px;color:#9ca3af;margin:0;text-align:center;">
            GetSalesCloser &bull; <a href="https://www.getsalescloser.com" style="color:#6b7280;">getsalescloser.com</a>
            &bull; <a href="mailto:Support@getsalescloser.com" style="color:#6b7280;">Support</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoIso = weekAgo.toISOString();

  // Build week label e.g. "Mar 1 – Mar 7, 2026"
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const weekLabel = `${fmt(weekAgo)} – ${fmt(now)}`;

  // Get all active orgs (have at least one active org_service)
  const { data: activeOrgs } = await sb
    .from("org_services")
    .select("org_id")
    .eq("status", "active");

  const orgIds = [...new Set((activeOrgs ?? []).map((r: any) => r.org_id))];
  if (orgIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "no_active_orgs" }), { status: 200 });
  }

  let totalSent = 0;
  const errors: string[] = [];

  for (const orgId of orgIds) {
    try {
      // Org name
      const { data: org } = await sb
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .single();

      if (!org) continue;

      // Leads this week
      const { count: newLeads } = await sb
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .gte("created_at", weekAgoIso);

      // Active leads (total in pipeline)
      const { count: activeLeads } = await sb
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "active");

      // Closed this week
      const { count: closedWon } = await sb
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "closed_won")
        .gte("updated_at", weekAgoIso);

      const { count: closedLost } = await sb
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "closed_lost")
        .gte("updated_at", weekAgoIso);

      // Appointments booked this week
      const { count: booked } = await sb
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .in("lead_id",
          (await sb.from("leads").select("id").eq("org_id", orgId)).data?.map((l: any) => l.id) ?? [])
        .gte("created_at", weekAgoIso);

      // SMS sent this week
      const { count: smsSent } = await sb
        .from("execution_tasks")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("channel", "sms")
        .eq("status", "succeeded")
        .gte("executed_at", weekAgoIso);

      // Email sent this week
      const { count: emailSent } = await sb
        .from("execution_tasks")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("channel", "email")
        .eq("status", "succeeded")
        .gte("executed_at", weekAgoIso);

      // Voice usage this week
      const { data: voiceRows } = await sb
        .from("voice_usage")
        .select("minutes_used, cost")
        .eq("org_id", orgId)
        .gte("created_at", weekAgoIso);

      const voiceMinutes = (voiceRows ?? []).reduce((s: number, r: any) => s + (r.minutes_used ?? 0), 0);
      const voiceCost = (voiceRows ?? []).reduce((s: number, r: any) => s + (r.cost ?? 0), 0);

      // Get recipients: all non-agent members (owners, solo users, admins)
      const { data: adminMembers } = await sb
        .from("org_members")
        .select("user_id")
        .eq("org_id", orgId)
        .not("role", "eq", "enterprise_agent");

      const recipientIds: string[] = (adminMembers ?? []).map((m: any) => m.user_id);

      const { data: recipients } = await sb
        .from("profiles")
        .select("id, full_name, email")
        .in("id", recipientIds);

      if (!recipients || recipients.length === 0) continue;

      for (const recipient of recipients) {
        if (!recipient.email) continue;

        const html = buildROIEmail({
          orgName: org.name,
          recipientName: recipient.full_name ?? "there",
          weekLabel,
          newLeads: newLeads ?? 0,
          activeLeads: activeLeads ?? 0,
          closedWon: closedWon ?? 0,
          closedLost: closedLost ?? 0,
          booked: booked ?? 0,
          smsSent: smsSent ?? 0,
          emailSent: emailSent ?? 0,
          voiceMinutes,
          voiceCost,
          tokensSaved: (smsSent ?? 0) + (emailSent ?? 0) + Math.round(voiceMinutes * 5),
        });

        const emailResp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [recipient.email],
            subject: `Your Weekly AI Report — ${org.name}`,
            html,
          }),
        });

        if (emailResp.ok) {
          totalSent++;
        } else {
          const errText = await emailResp.text();
          console.error(`[weekly_roi] Resend failed for ${recipient.email}: ${errText}`);
          errors.push(`${recipient.email}: ${errText}`);
        }
      }
    } catch (err) {
      console.error(`[weekly_roi] error for org ${orgId}:`, err);
      errors.push(String(err));
    }
  }

  return new Response(JSON.stringify({ sent: totalSent, orgs: orgIds.length, errors }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
