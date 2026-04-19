// lge_notifications_manage — LGE Alert & Notification Management
// Actions: list_alerts, acknowledge_alert, resolve_alert, suppress_alert,
//          get_notification_prefs, update_notification_prefs,
//          get_digest_history, trigger_digest

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function resolveOrgAndRole(adminSb: any, userId: string): Promise<{ orgId: string | null; role: "admin" | "operator" | "viewer" }> {
  const { data: memRows } = await adminSb
    .from("org_members").select("org_id, role").eq("user_id", userId).limit(1);

  let orgId: string | null = null;
  let rawRole: string | null = null;

  if (memRows?.length) {
    orgId = memRows[0].org_id;
    rawRole = memRows[0].role ?? null;
  } else {
    const { data: orgRow } = await adminSb.from("organizations").select("id").limit(1).maybeSingle();
    orgId = orgRow?.id ?? null;
    rawRole = null;
  }

  let role: "admin" | "operator" | "viewer" = "viewer";
  if (rawRole === null || rawRole === "agency_admin" || rawRole === "enterprise_admin" || rawRole === "owner") role = "admin";
  else if (rawRole === "enterprise_agent") role = "operator";

  return { orgId, role };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return err("Unauthorized", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey  = Deno.env.get("GSC_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "Authorization": `Bearer ${token}`, "apikey": serviceKey },
    });
    if (!userResp.ok) return err("Unauthorized", 401);
    const { id: userId } = await userResp.json();
    if (!userId) return err("Unauthorized", 401);

    const adminSb = getServiceSupabaseClient();
    const { orgId, role } = await resolveOrgAndRole(adminSb, userId);
    if (!orgId) return err("No organization found", 403);

    // Entitlement check
    const { data: svc } = await adminSb.from("org_services").select("status")
      .eq("org_id", orgId).eq("service_key", "lead_gen").maybeSingle();
    if (svc?.status !== "active") return err("lead_gen entitlement not active", 403);

    const body = await req.json();
    const { action } = body;
    if (!action) return err("action required");

    switch (action) {

      // ── list_alerts ──────────────────────────────────────────────────────────
      case "list_alerts": {
        const { severity, status: statusFilter = "open", campaign_id, limit: lim = 50, offset: off = 0 } = body;
        let q = adminSb.from("lge_alerts")
          .select("id, campaign_id, alert_type, severity, status, title, message, context_json, dedupe_key, first_seen_at, last_seen_at, acknowledged_by, acknowledged_at, resolved_at, resolution_note, suppressed_until, created_at")
          .eq("org_id", orgId)
          .order("last_seen_at", { ascending: false })
          .range(off, off + lim - 1);

        if (statusFilter !== "all") q = q.eq("status", statusFilter);
        if (severity) q = q.eq("severity", severity);
        if (campaign_id) q = q.eq("campaign_id", campaign_id);

        const { data, error, count } = await q;
        if (error) return err(error.message, 500);

        // Attach campaign names
        const campIds = [...new Set((data ?? []).map((a: any) => a.campaign_id).filter(Boolean))];
        let campNames: Record<string, string> = {};
        if (campIds.length) {
          const { data: camps } = await adminSb.from("lge_campaigns").select("id, name").in("id", campIds);
          for (const c of camps ?? []) campNames[c.id] = c.name;
        }

        // Unread counts by severity
        const { data: openCounts } = await adminSb
          .from("lge_alerts")
          .select("severity")
          .eq("org_id", orgId)
          .eq("status", "open");
        const unread = { info: 0, warning: 0, critical: 0, total: 0 };
        for (const a of openCounts ?? []) {
          unread[a.severity as keyof typeof unread]++;
          unread.total++;
        }

        const alerts = (data ?? []).map((a: any) => ({ ...a, campaign_name: campNames[a.campaign_id] ?? null }));
        return ok({ alerts, total: count ?? alerts.length, unread });
      }

      // ── acknowledge_alert ────────────────────────────────────────────────────
      case "acknowledge_alert": {
        const { alert_id } = body;
        if (!alert_id) return err("alert_id required");
        // operator+ can acknowledge
        if (role === "viewer") return err("Permission denied — operator role required", 403);

        const { data: alert } = await adminSb.from("lge_alerts").select("id, status").eq("id", alert_id).eq("org_id", orgId).maybeSingle();
        if (!alert) return err("Alert not found", 404);
        if (alert.status === "resolved" || alert.status === "suppressed") return err("Alert is already resolved/suppressed", 400);

        const { error } = await adminSb.from("lge_alerts").update({
          status: "acknowledged",
          acknowledged_by: userId,
          acknowledged_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", alert_id);
        if (error) return err(error.message, 500);
        return ok({ ok: true, alert_id, status: "acknowledged" });
      }

      // ── resolve_alert ────────────────────────────────────────────────────────
      case "resolve_alert": {
        const { alert_id, resolution_note } = body;
        if (!alert_id) return err("alert_id required");
        if (role !== "admin") return err("Permission denied — admin role required to resolve alerts", 403);
        if (!resolution_note || !String(resolution_note).trim()) return err("resolution_note required");

        const { data: alert } = await adminSb.from("lge_alerts").select("id, status").eq("id", alert_id).eq("org_id", orgId).maybeSingle();
        if (!alert) return err("Alert not found", 404);
        if (alert.status === "resolved") return err("Alert is already resolved", 400);

        const { error } = await adminSb.from("lge_alerts").update({
          status: "resolved",
          resolved_by: userId,
          resolved_at: new Date().toISOString(),
          resolution_note: String(resolution_note).slice(0, 500),
          updated_at: new Date().toISOString(),
        }).eq("id", alert_id);
        if (error) return err(error.message, 500);
        return ok({ ok: true, alert_id, status: "resolved" });
      }

      // ── suppress_alert ───────────────────────────────────────────────────────
      case "suppress_alert": {
        const { alert_id, suppress_hours = 24 } = body;
        if (!alert_id) return err("alert_id required");
        if (role !== "admin") return err("Permission denied — admin role required to suppress alerts", 403);

        const suppressUntil = new Date(Date.now() + Math.min(Number(suppress_hours), 168) * 60 * 60 * 1000).toISOString();
        const { error } = await adminSb.from("lge_alerts").update({
          status: "suppressed",
          suppressed_until: suppressUntil,
          updated_at: new Date().toISOString(),
        }).eq("id", alert_id).eq("org_id", orgId);
        if (error) return err(error.message, 500);
        return ok({ ok: true, alert_id, status: "suppressed", suppressed_until: suppressUntil });
      }

      // ── get_notification_prefs ───────────────────────────────────────────────
      case "get_notification_prefs": {
        const { data } = await adminSb.from("lge_notification_prefs").select("*").eq("org_id", orgId).maybeSingle();
        // Return defaults if no prefs saved yet
        return ok({ prefs: data ?? { org_id: orgId, channel_in_app: true, channel_email: true, digest_frequency: "daily", min_severity: "warning" } });
      }

      // ── update_notification_prefs ────────────────────────────────────────────
      case "update_notification_prefs": {
        if (role !== "admin") return err("Permission denied — admin role required", 403);
        const { channel_in_app, channel_email, digest_frequency, min_severity } = body;
        const updates: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
        if (channel_in_app !== undefined) updates.channel_in_app = Boolean(channel_in_app);
        if (channel_email !== undefined) updates.channel_email = Boolean(channel_email);
        if (digest_frequency !== undefined) {
          if (!["daily","weekly","off"].includes(digest_frequency)) return err("digest_frequency must be daily|weekly|off");
          updates.digest_frequency = digest_frequency;
        }
        if (min_severity !== undefined) {
          if (!["info","warning","critical"].includes(min_severity)) return err("min_severity must be info|warning|critical");
          updates.min_severity = min_severity;
        }
        const { error } = await adminSb.from("lge_notification_prefs").upsert(updates, { onConflict: "org_id" });
        if (error) return err(error.message, 500);
        return ok({ ok: true });
      }

      // ── get_digest_history ───────────────────────────────────────────────────
      case "get_digest_history": {
        const { limit: lim = 30 } = body;
        const { data, error } = await adminSb.from("lge_digests")
          .select("id, digest_type, period_start, period_end, delivery_status, sent_at, created_at")
          .eq("org_id", orgId)
          .order("created_at", { ascending: false })
          .limit(Math.min(lim, 90));
        if (error) return err(error.message, 500);
        return ok({ digests: data ?? [] });
      }

      // ── trigger_digest ───────────────────────────────────────────────────────
      case "trigger_digest": {
        if (role !== "admin") return err("Permission denied — admin role required", 403);

        // Idempotency guard: prevent duplicate digests within 5 minutes
        const { data: recentDigest } = await adminSb.from("lge_digests")
          .select("id, created_at")
          .eq("org_id", orgId)
          .gte("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (recentDigest) {
          return err("A digest was already triggered in the last 5 minutes. Please wait before retrying.", 429);
        }

        // Build a manual on-demand digest and email it
        const periodEnd = new Date().toISOString();
        const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        // Gather stats
        const { data: camps } = await adminSb.from("lge_campaigns")
          .select("id, name, mode").eq("org_id", orgId).neq("status", "archived");
        const campIds = (camps ?? []).map((c: any) => c.id);

        const [{ data: leads }, { data: openAlerts }] = await Promise.all([
          campIds.length
            ? adminSb.from("lge_raw_leads").select("campaign_id, status").eq("org_id", orgId).in("campaign_id", campIds)
            : { data: [] },
          adminSb.from("lge_alerts").select("id, severity, title, status").eq("org_id", orgId).eq("status", "open").limit(10),
        ]);

        // Per-campaign summary
        const summaryByCamp = (camps ?? []).map((c: any) => {
          const cl = (leads ?? []).filter((l: any) => l.campaign_id === c.id);
          return {
            name: c.name,
            mode: c.mode,
            total: cl.length,
            pending: cl.filter((l: any) => ["pending","enriching"].includes(l.status)).length,
            review: cl.filter((l: any) => l.status === "review_queue").length,
            pushed: cl.filter((l: any) => l.status === "pushed").length,
            failed: cl.filter((l: any) => l.status === "failed").length,
          };
        });

        const content_json = { period_start: periodStart, period_end: periodEnd, campaigns: summaryByCamp, open_alerts: openAlerts ?? [] };

        // Insert digest record
        const { data: digest, error: digestErr } = await adminSb.from("lge_digests").insert({
          org_id: orgId, digest_type: "daily",
          period_start: periodStart, period_end: periodEnd,
          content_json, delivery_status: "pending",
        }).select("id").single();
        if (digestErr) return err(digestErr.message, 500);

        // Resolve email
        const { data: { user }, error: ueErr } = await (adminSb as any).auth.admin.getUserById(userId);
        if (ueErr || !user?.email) return err("Could not resolve your email address", 500);

        const resendKey = Deno.env.get("RESEND_API_KEY");
        if (!resendKey) return err("RESEND_API_KEY not set", 500);

        const dateStr = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        const alertsHtml = (openAlerts ?? []).length
          ? (openAlerts as any[]).map((a: any) => {
              const sevColor: Record<string, string> = { critical: "#ef4444", warning: "#f59e0b", info: "#6366f1" };
              return `<div style="padding:8px 0;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:10px"><span style="width:70px;font-size:11px;color:${sevColor[a.severity] ?? '#64748b'};font-weight:600;text-transform:uppercase">${a.severity}</span><span style="font-size:13px;color:#cbd5e1">${String(a.title ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")}</span></div>`;
            }).join("")
          : `<p style="color:#475569;font-size:13px">No open alerts.</p>`;

        const tableRows = summaryByCamp.map(c =>
          `<tr style="border-bottom:1px solid #1e293b">
            <td style="padding:9px 12px;color:#e2e8f0;font-weight:500">${c.name}</td>
            <td style="padding:9px 12px;text-align:right;color:#94a3b8">${c.total}</td>
            <td style="padding:9px 12px;text-align:right;color:#34d399">${c.pushed}</td>
            <td style="padding:9px 12px;text-align:right;color:#fbbf24">${c.review}</td>
            <td style="padding:9px 12px;text-align:right;color:#475569">${c.failed}</td>
          </tr>`
        ).join("");

        const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0f172a;font-family:Inter,sans-serif">
        <div style="max-width:600px;margin:0 auto;padding:28px 16px">
          <div style="background:#1e293b;border-radius:12px;overflow:hidden">
            <div style="padding:22px 28px;border-bottom:1px solid #334155">
              <p style="margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;font-weight:600">GetSalesCloser · LGE Daily Digest</p>
              <h1 style="margin:0;font-size:18px;color:#f1f5f9;font-weight:700">${dateStr}</h1>
            </div>
            ${(openAlerts ?? []).length ? `<div style="padding:20px 28px;border-bottom:1px solid #334155"><p style="margin:0 0 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:600">Open Alerts</p>${alertsHtml}</div>` : ""}
            <div style="padding:20px 28px">
              <p style="margin:0 0 12px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:600">Campaign Summary</p>
              <table style="width:100%;border-collapse:collapse;font-size:12px">
                <thead><tr style="border-bottom:2px solid #334155">
                  <th style="padding:7px 12px;text-align:left;color:#64748b">Campaign</th>
                  <th style="padding:7px 12px;text-align:right;color:#64748b">Total</th>
                  <th style="padding:7px 12px;text-align:right;color:#64748b">Pushed</th>
                  <th style="padding:7px 12px;text-align:right;color:#64748b">Review</th>
                  <th style="padding:7px 12px;text-align:right;color:#64748b">Failed</th>
                </tr></thead>
                <tbody>${tableRows || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#475569">No campaigns yet.</td></tr>'}</tbody>
              </table>
            </div>
            <div style="padding:14px 28px;border-top:1px solid #1e293b;text-align:center">
              <a href="https://www.getsalescloser.com/lge_dashboard.html" style="font-size:12px;color:#6366f1;text-decoration:none">Open LGE Dashboard</a>
            </div>
          </div>
        </div></body></html>`;

        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "support@getsalescloser.com", to: [user.email], subject: `LGE Daily Digest — ${dateStr}`, html: emailHtml }),
        });

        if (mailRes.ok) {
          await adminSb.from("lge_digests").update({ delivery_status: "sent", sent_at: new Date().toISOString() }).eq("id", digest.id);
          return ok({ ok: true, digest_id: digest.id, sent_to: user.email });
        } else {
          const mailErr = await mailRes.text().catch(() => "");
          await adminSb.from("lge_digests").update({ delivery_status: "failed", error_message: mailErr }).eq("id", digest.id);
          return err(`Digest email failed: ${mailErr}`, 500);
        }
      }

      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (e: any) {
    console.error("[lge_notifications_manage] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
