// lge_alert_worker — LGE Alert Rule Evaluator
// Scheduled via pg_cron every 30 minutes (--no-verify-jwt).
// Evaluates alert rules per org/campaign, deduplicates via dedupe_key,
// applies cooldowns, and sends critical email alerts via Resend.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Cooldown periods per severity (ms)
const COOLDOWN_MS: Record<string, number> = {
  info:     24 * 60 * 60 * 1000,  // 24h
  warning:  12 * 60 * 60 * 1000,  // 12h
  critical:  4 * 60 * 60 * 1000,  // 4h
};

// Min sample size for rate-based rules
const MIN_SAMPLE = 20;
// Outcome lag (same as calibration — 48h)
const LAG_MS = 48 * 60 * 60 * 1000;

interface AlertCandidate {
  org_id: string;
  campaign_id: string | null;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  context_json: Record<string, unknown>;
  dedupe_key: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = getServiceSupabaseClient();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    // 1. All LGE-entitled orgs
    const { data: entitled } = await sb
      .from("org_services")
      .select("org_id")
      .eq("service_key", "lead_gen")
      .eq("status", "active");
    if (!entitled?.length) return ok({ ok: true, evaluated: 0 });

    const orgIds = entitled.map((r: any) => r.org_id as string);

    // 2. Active campaigns per org
    const { data: campaigns } = await sb
      .from("lge_campaigns")
      .select("id, org_id, name, auto_push_threshold, review_threshold, review_ttl_days, mode")
      .in("org_id", orgIds)
      .neq("status", "archived");
    if (!campaigns?.length) return ok({ ok: true, evaluated: 0 });

    const campIds = campaigns.map((c: any) => c.id as string);

    // 3. Batch fetch metrics across all campaigns
    const lagCutoff = new Date(nowMs - LAG_MS).toISOString();

    const [
      { data: rawLeads },
      { data: recentFailed },
      { data: providerErrors },
      { data: pushedOutcomes },
    ] = await Promise.all([
      // Lead status counts
      sb.from("lge_raw_leads")
        .select("id, campaign_id, org_id, status, updated_at, created_at")
        .in("campaign_id", campIds)
        .not("status", "in", '("pending","enriching")'),
      // Failed leads in last 24h (failure spike detection)
      sb.from("lge_raw_leads")
        .select("id, campaign_id, org_id")
        .in("campaign_id", campIds)
        .eq("status", "failed")
        .gte("updated_at", new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()),
      // Provider errors in last 24h
      sb.from("lge_provider_calls")
        .select("raw_lead_id, provider")
        .eq("status", "error")
        .gte("called_at", new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()),
      // Outcomes for lag-filtered pushed leads
      sb.from("lge_raw_leads")
        .select("id, campaign_id, org_id")
        .in("campaign_id", campIds)
        .eq("status", "pushed")
        .lt("updated_at", lagCutoff),
    ]);

    // Fetch outcomes for eligible pushed leads (chunked)
    const eligibleIds = (pushedOutcomes ?? []).map((l: any) => l.id as string);
    const CHUNK = 500;
    let outcomes: any[] = [];
    for (let i = 0; i < eligibleIds.length; i += CHUNK) {
      const { data } = await sb
        .from("lge_outcomes")
        .select("raw_lead_id, outcome_stage")
        .in("raw_lead_id", eligibleIds.slice(i, i + CHUNK));
      if (data) outcomes.push(...data);
    }
    const outcomeMap = new Map<string, string>(outcomes.map((o: any) => [o.raw_lead_id, o.outcome_stage]));

    // 4. Build per-campaign metrics
    const candidates: AlertCandidate[] = [];

    for (const camp of campaigns as any[]) {
      const campLeads    = (rawLeads ?? []).filter((l: any) => l.campaign_id === camp.id);
      const reviewLeads  = campLeads.filter((l: any) => l.status === "review_queue");
      const pushedLeads  = (pushedOutcomes ?? []).filter((l: any) => l.campaign_id === camp.id);
      const failed24h    = (recentFailed ?? []).filter((l: any) => l.campaign_id === camp.id);
      const totalLeads   = campLeads.length;
      const failedCount  = campLeads.filter((l: any) => l.status === "failed").length;

      // Review backlog
      const backlogSize = reviewLeads.length;
      const reviewAgesD = reviewLeads.map((l: any) =>
        (nowMs - new Date(l.updated_at ?? l.created_at).getTime()) / 86_400_000
      );
      const oldestDays = reviewAgesD.length ? Math.max(...reviewAgesD) : 0;
      const medianDays = reviewAgesD.length
        ? [...reviewAgesD].sort((a, b) => a - b)[Math.floor(reviewAgesD.length / 2)]
        : 0;

      // Review backlog — critical
      if (backlogSize >= 100) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "review_backlog_critical",
          severity: "critical",
          title: `Review queue critical — ${backlogSize} leads`,
          message: `Campaign "${camp.name}" has ${backlogSize} leads waiting in the review queue. Immediate action required to prevent leads from aging past the ${camp.review_ttl_days}-day auto-discard TTL.`,
          context_json: { backlog_size: backlogSize, oldest_days: Math.round(oldestDays * 10) / 10, ttl_days: camp.review_ttl_days },
          dedupe_key: `review_backlog_critical:${camp.id}`,
        });
      } else if (backlogSize >= 30) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "review_backlog_high",
          severity: "warning",
          title: `Review queue backlog — ${backlogSize} leads`,
          message: `Campaign "${camp.name}" has ${backlogSize} leads in the review queue. Median age: ${Math.round(medianDays * 10) / 10} days.`,
          context_json: { backlog_size: backlogSize, median_days: Math.round(medianDays * 10) / 10, oldest_days: Math.round(oldestDays * 10) / 10 },
          dedupe_key: `review_backlog_high:${camp.id}`,
        });
      }

      // Stale review queue
      if (backlogSize > 5 && oldestDays > camp.review_ttl_days * 0.7) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "review_queue_stale",
          severity: "warning",
          title: `Review leads aging — ${Math.round(oldestDays * 10) / 10} days`,
          message: `Campaign "${camp.name}" has review leads approaching the ${camp.review_ttl_days}-day auto-discard TTL. Oldest lead: ${Math.round(oldestDays * 10) / 10} days.`,
          context_json: { oldest_days: Math.round(oldestDays * 10) / 10, ttl_days: camp.review_ttl_days, backlog_size: backlogSize },
          dedupe_key: `review_queue_stale:${camp.id}`,
        });
      }

      // Failed leads spike (>10 failures in last 24h OR >30% of total leads failed)
      if (failed24h.length >= 10) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "failed_leads_spike",
          severity: "warning",
          title: `Failed leads spike — ${failed24h.length} in 24h`,
          message: `Campaign "${camp.name}" had ${failed24h.length} lead failures in the last 24 hours. Check provider API keys and enrichment config.`,
          context_json: { failed_24h: failed24h.length, total_failed: failedCount, total_leads: totalLeads },
          dedupe_key: `failed_leads_spike:${camp.id}`,
        });
      } else if (totalLeads >= 20 && failedCount / totalLeads > 0.3) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "high_failure_rate",
          severity: "warning",
          title: `High failure rate — ${Math.round(100 * failedCount / totalLeads)}%`,
          message: `Campaign "${camp.name}" has a ${Math.round(100 * failedCount / totalLeads)}% lead failure rate (${failedCount}/${totalLeads} leads). Enrichment providers may be misconfigured.`,
          context_json: { failure_rate_pct: Math.round(100 * failedCount / totalLeads), failed_count: failedCount, total_leads: totalLeads },
          dedupe_key: `high_failure_rate:${camp.id}`,
        });
      }

      // False push rate (outcome-eligible pushed leads)
      if (pushedLeads.length >= MIN_SAMPLE) {
        const noReplyCount = pushedLeads.filter((l: any) => outcomeMap.get(l.id) === "no_reply").length;
        const falsePushRate = Math.round(100 * noReplyCount / pushedLeads.length);
        if (falsePushRate >= 60) {
          candidates.push({
            org_id: camp.org_id, campaign_id: camp.id,
            alert_type: "false_push_rate_critical",
            severity: "critical",
            title: `False push rate critical — ${falsePushRate}%`,
            message: `Campaign "${camp.name}": ${falsePushRate}% of outcome-eligible pushed leads recorded no reply. Push threshold may be far too low, or ICP is misconfigured.`,
            context_json: { false_push_rate: falsePushRate, no_reply_count: noReplyCount, eligible: pushedLeads.length },
            dedupe_key: `false_push_rate_critical:${camp.id}`,
          });
        } else if (falsePushRate >= 40) {
          candidates.push({
            org_id: camp.org_id, campaign_id: camp.id,
            alert_type: "false_push_rate_high",
            severity: "warning",
            title: `High false push rate — ${falsePushRate}%`,
            message: `Campaign "${camp.name}": ${falsePushRate}% of outcome-eligible pushed leads recorded no reply. Consider raising the push threshold.`,
            context_json: { false_push_rate: falsePushRate, no_reply_count: noReplyCount, eligible: pushedLeads.length },
            dedupe_key: `false_push_rate_high:${camp.id}`,
          });
        }
      }

      // No outcomes recorded (pushed > 10 but 0 outcomes after >7 days)
      if (pushedLeads.length >= 10) {
        const withOutcome = pushedLeads.filter((l: any) => outcomeMap.has(l.id)).length;
        if (withOutcome === 0) {
          candidates.push({
            org_id: camp.org_id, campaign_id: camp.id,
            alert_type: "no_outcomes_recorded",
            severity: "info",
            title: "No outcomes recorded",
            message: `Campaign "${camp.name}" has ${pushedLeads.length} pushed leads (>48h old) but zero outcome records. Verify the lge_outcome_sync cron is running.`,
            context_json: { pushed_eligible: pushedLeads.length, with_outcome: withOutcome },
            dedupe_key: `no_outcomes_recorded:${camp.id}`,
          });
        }
      }

      // Campaign in active mode but 0 leads ingested (mode=active for >24h with no leads)
      if (camp.mode === "active" && totalLeads === 0) {
        candidates.push({
          org_id: camp.org_id, campaign_id: camp.id,
          alert_type: "campaign_active_no_leads",
          severity: "info",
          title: "Campaign active with no leads",
          message: `Campaign "${camp.name}" is in active mode but has no leads. Import a lead list to start processing.`,
          context_json: { mode: camp.mode },
          dedupe_key: `campaign_active_no_leads:${camp.id}`,
        });
      }
    }

    // Org-level: provider errors spike
    for (const orgId of orgIds) {
      const orgErrors = (providerErrors ?? []).filter((e: any) => {
        // Get campaign for this org
        const camp = (campaigns ?? []).find((c: any) => c.org_id === orgId && c.id === e.raw_lead_id);
        return !!camp;
      });
      // Simpler: count errors across campaigns that belong to this org
      const orgCampIds = new Set((campaigns ?? []).filter((c: any) => c.org_id === orgId).map((c: any) => c.id));
      const orgLeadIds = new Set(
        (rawLeads ?? []).filter((l: any) => orgCampIds.has(l.campaign_id)).map((l: any) => l.id)
      );
      // provider_calls joined to raw_leads — approximate by checking raw_lead_id is in org
      if ((providerErrors ?? []).length >= 20) {
        candidates.push({
          org_id: orgId, campaign_id: null,
          alert_type: "provider_error_spike",
          severity: "warning",
          title: "Provider API errors detected",
          message: `${(providerErrors ?? []).length} provider call errors in the last 24 hours across your campaigns. Check your Apollo and Hunter API keys.`,
          context_json: { error_count: (providerErrors ?? []).length },
          dedupe_key: `provider_error_spike:org:${orgId}`,
        });
      }
    }

    // 5. Fetch existing open alerts for dedup/cooldown check
    const allDedupeKeys = candidates.map(c => c.dedupe_key);
    const { data: existingAlerts } = await sb
      .from("lge_alerts")
      .select("id, dedupe_key, severity, last_seen_at, last_emailed_at, status")
      .in("org_id", orgIds)
      .not("status", "in", '("resolved","suppressed")');

    const existingMap = new Map<string, any>(
      (existingAlerts ?? []).map((a: any) => [a.dedupe_key, a])
    );

    // 6. Fetch notification prefs
    const { data: prefsRows } = await sb
      .from("lge_notification_prefs")
      .select("org_id, channel_email, min_severity")
      .in("org_id", orgIds);
    const prefsMap = new Map<string, any>((prefsRows ?? []).map((p: any) => [p.org_id, p]));

    // 7. Fetch org owner emails for alert delivery
    const orgEmailMap = new Map<string, string>();
    if (orgIds.length) {
      for (const orgId of orgIds) {
        const { data: members } = await sb
          .from("org_members")
          .select("user_id, role")
          .eq("org_id", orgId);
        let actorId: string | null = null;
        for (const role of ["enterprise_admin","agency_admin","owner"]) {
          const m = (members ?? []).find((mm: any) => mm.role === role);
          if (m) { actorId = m.user_id; break; }
        }
        if (!actorId && members?.length) {
          actorId = (members as any[]).find((m: any) => !m.role)?.user_id ?? members[0].user_id;
        }
        if (actorId) {
          const { data: { user } } = await (sb as any).auth.admin.getUserById(actorId);
          if (user?.email) orgEmailMap.set(orgId, user.email);
        }
      }
    }

    // 8. Upsert/update alerts + send emails for critical
    let created = 0, updated = 0, emailed = 0;
    const resendKey = Deno.env.get("RESEND_API_KEY");

    for (const c of candidates) {
      const existing = existingMap.get(c.dedupe_key);

      if (existing) {
        // Update last_seen_at (recurring condition)
        await sb.from("lge_alerts")
          .update({ last_seen_at: now, updated_at: now })
          .eq("id", existing.id);
        updated++;

        // Check if we should re-email (cooldown)
        const lastEmailedMs = existing.last_emailed_at ? new Date(existing.last_emailed_at).getTime() : 0;
        const cooldown = COOLDOWN_MS[existing.severity] ?? COOLDOWN_MS.warning;
        if (nowMs - lastEmailedMs > cooldown && resendKey) {
          await maybeEmail(sb, resendKey, c, existing.id, orgEmailMap, prefsMap, now);
          emailed++;
        }
      } else {
        // Create new alert
        const { data: inserted } = await sb.from("lge_alerts").insert({
          org_id: c.org_id, campaign_id: c.campaign_id,
          alert_type: c.alert_type, severity: c.severity, status: "open",
          title: c.title, message: c.message,
          context_json: c.context_json, dedupe_key: c.dedupe_key,
          first_seen_at: now, last_seen_at: now,
        }).select("id").maybeSingle();
        created++;

        // Email on first occurrence for warning/critical
        if (inserted && resendKey && c.severity !== "info") {
          await maybeEmail(sb, resendKey, c, inserted.id, orgEmailMap, prefsMap, now);
          emailed++;
        }
      }
    }

    // 9. Auto-resolve alerts where condition no longer holds
    // (leads in review backlog dropped, false push rate improved, etc.)
    // For now: mark 'review_backlog_high' and 'review_backlog_critical' as resolved
    // if no candidate was generated for the same campaign this run
    const candidateKeys = new Set(candidates.map(c => c.dedupe_key));
    const staleAlerts = (existingAlerts ?? []).filter((a: any) =>
      ["review_backlog_high","review_backlog_critical","failed_leads_spike","false_push_rate_high","false_push_rate_critical"]
        .some(t => a.dedupe_key.startsWith(t)) &&
      !candidateKeys.has(a.dedupe_key)
    );
    if (staleAlerts.length) {
      await sb.from("lge_alerts")
        .update({ status: "resolved", resolved_at: now, resolution_note: "Auto-resolved: condition no longer detected.", updated_at: now })
        .in("id", staleAlerts.map((a: any) => a.id));
    }

    return ok({ ok: true, candidates: candidates.length, created, updated, emailed, auto_resolved: staleAlerts.length });
  } catch (e: any) {
    console.error("[lge_alert_worker] error:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

async function maybeEmail(
  sb: any, resendKey: string,
  c: AlertCandidate, alertId: string,
  orgEmailMap: Map<string, string>,
  prefsMap: Map<string, any>,
  now: string,
) {
  const prefs = prefsMap.get(c.org_id);
  // Default: email enabled for warning/critical; skip info unless prefs say so
  if (prefs?.channel_email === false) return;
  const minSev = prefs?.min_severity ?? "warning";
  const sevRank: Record<string, number> = { info: 0, warning: 1, critical: 2 };
  if ((sevRank[c.severity] ?? 0) < (sevRank[minSev] ?? 1)) return;

  const recipientEmail = orgEmailMap.get(c.org_id);
  if (!recipientEmail) return;

  const sevColors: Record<string, string> = { info: "#6366f1", warning: "#f59e0b", critical: "#ef4444" };
  const sevLabels: Record<string, string> = { info: "Info", warning: "Warning", critical: "Critical" };
  const color = sevColors[c.severity] ?? "#6366f1";
  const label = sevLabels[c.severity] ?? c.severity;

  const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0f172a;font-family:Inter,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="background:#1e293b;border-radius:12px;overflow:hidden;border-left:4px solid ${color}">
      <div style="padding:20px 24px;border-bottom:1px solid #334155">
        <p style="margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;font-weight:600">GetSalesCloser · Lead Generation Engine</p>
        <h2 style="margin:0;font-size:18px;color:#f1f5f9;font-weight:700">${escapeHtml(c.title)}</h2>
        <span style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:${color}22;color:${color}">${label}</span>
      </div>
      <div style="padding:20px 24px">
        <p style="margin:0 0 16px;font-size:14px;color:#cbd5e1;line-height:1.6">${escapeHtml(c.message)}</p>
        <a href="https://www.getsalescloser.com/lge_dashboard.html" style="display:inline-block;padding:10px 20px;background:#6366f1;color:white;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600">Open LGE Dashboard</a>
      </div>
      <div style="padding:12px 24px;border-top:1px solid #1e293b;text-align:center">
        <p style="margin:0;font-size:11px;color:#475569">You can adjust notification preferences in the LGE Alerts tab.</p>
      </div>
    </div>
  </div></body></html>`;

  const mailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "support@getsalescloser.com",
      to: [recipientEmail],
      subject: `[LGE ${label}] ${c.title}`,
      html: emailHtml,
    }),
  }).catch(() => null);

  if (mailRes?.ok) {
    await sb.from("lge_alerts").update({ last_emailed_at: now, updated_at: now }).eq("id", alertId);
  }
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
