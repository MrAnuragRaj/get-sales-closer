/**
 * revenue-doctor-generate — Edge Function
 *
 * Generates an LLM-driven Revenue Doctor diagnostic report for an org.
 *
 * POST /revenue-doctor-generate
 * Body: { org_id: string, window_type?: "daily"|"weekly"|"monthly", reference_date?: "YYYY-MM-DD" }
 *
 * Flow:
 *   1. Auth check (user JWT required — no service-role bypass, always user-initiated)
 *   2. Org membership gate
 *   3. Entitlement check — voice service must be active (Sentinel-only → 403)
 *   4. Quota check — doctor_report token_wallet balance > 0 (else 402)
 *   4.5 Rate limit — max 3 generations per minute per org (else 429)
 *   5. Consume 1 doctor_report credit (idempotent via UUID idempotency key)
 *   6. Fetch current window data (all 5 adapters — parallel)
 *   7. Compute health snapshot via scorers
 *   8. Build DiagnosticPayload via buildDiagnosticPayload()
 *   9. GPT-4o LLM call — senior revenue ops consultant prompt (9 structured sections)
 *      — 40 s AbortController timeout; refund + 504 on timeout
 *      — validate all 9 sections; retry once if invalid; refund + 422 if still invalid
 *  10. Persist to revenue_doctor_reports + flatten to doctor_report_metrics
 *  11. Return full structured report (includes request_id, generation_duration_ms)
 *
 * ── v1 COMMERCIAL MAPPING note ───────────────────────────────────────────────
 * Entitlement uses org_services.service_key='voice' as the Doctor gate.
 * Sentinel-only orgs (no active voice service) → 403 Feature not enabled.
 * When Starter/Pro/Enterprise plan_tier is introduced (v2), replace the
 * org_services gate with a plan_tier entitlement check.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getServiceSupabaseClient, getUserSupabaseClient } from "../_shared/db.ts";
import {
  buildDateWindow,
  fetchLeadFacts,
  fetchConversationFacts,
  fetchChannelFacts,
  fetchFunnelFacts,
  fetchCampaignFacts,
  type WindowType,
} from "../_shared/revenue_adapters.ts";
import {
  scoreLeadResponse,
  scoreConversationQuality,
  scoreChannelHealth,
  scoreConversionHealth,
  computeOverallScore,
  generateWarnings,
  type CategoryScore,
  type HealthSnapshot,
} from "../_shared/health_scorer.ts";
import { buildDiagnosticPayload } from "../_shared/doctor_payload_builder.ts";
import type { TeamAttentionResult } from "../_shared/team_attention.ts";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const TOKEN_KEY        = "doctor_report";
const TOKEN_COST       = 1;
const GPT4O_MODEL      = "gpt-4o";
const LLM_TIMEOUT_MS   = 40_000;  // 40s — abort + refund if exceeded
const RATE_LIMIT_COUNT = 3;       // max generations per org per minute
const MAX_LLM_ATTEMPTS = 2;       // try once, retry once on invalid output

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

// ─────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────

function ok(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}
function err(status: number, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: JSON_HEADERS });
}

// ─────────────────────────────────────────────
// PREV WINDOW HELPER (mirrors revenue-health pattern)
// ─────────────────────────────────────────────

function makePrevPeriodWindow(w: ReturnType<typeof buildDateWindow>): ReturnType<typeof buildDateWindow> {
  return {
    ...w,
    windowStart: w.prevWindowStart,
    windowEnd:   w.prevWindowEnd,
    prevWindowStart: new Date(w.prevWindowStart.getTime() - (w.windowEnd.getTime() - w.windowStart.getTime())),
    prevWindowEnd:   w.prevWindowStart,
  };
}

// ─────────────────────────────────────────────
// REPORT CONTENT TYPE
// ─────────────────────────────────────────────

interface ReportContent {
  executive_summary:       string;
  problems: Array<{
    title:    string;
    severity: "high" | "medium" | "low";
    evidence: string[];
    impact:   string;
  }>;
  root_causes: Array<{
    cause:       string;
    category:    string;
    detail:      string;
  }>;
  conversation_findings: Array<{
    finding:     string;
    supporting:  string;
    recommendation: string;
  }>;
  funnel_analysis: {
    summary:        string;
    biggest_leak:   string;
    stage_insights: string[];
  };
  recommendations: Array<{
    action:   string;
    priority: "high" | "medium" | "low";
    rationale: string;
    channel:  string;
  }>;
  top_3_actions: Array<{
    action:          string;
    expected_result: string;
    effort:          "low" | "medium" | "high";
  }>;
  expected_impact: {
    summary:         string;
    conversion_lift: string;
    revenue_impact:  string;
  };
  confidence_notes: string;

  // Enterprise-only — present only when org_type = 'enterprise'
  team_overview?: {
    summary:            string;
    agents_total:       number;
    requires_attention: number;
    top_performer_name?: string;
  };
  users_requiring_attention?: Array<{
    display_name:  string;
    flags:         string[];
    top_issue:     string;
    coaching_note: string;
  }>;
  coaching_priorities?: Array<{
    display_name:   string;
    priority_focus: string;
    specific_action: string;
  }>;
}

// ─────────────────────────────────────────────
// LLM OUTPUT VALIDATION (Item 6)
// Returns list of missing/invalid section names, or [] if valid.
// conversation_findings allowed to be empty (no conversations → legitimately empty).
// ─────────────────────────────────────────────

function validateReportContent(content: ReportContent): string[] {
  const missing: string[] = [];
  if (!content.executive_summary?.trim())                                                missing.push("executive_summary");
  if (!Array.isArray(content.problems)           || content.problems.length < 1)        missing.push("problems");
  if (!Array.isArray(content.root_causes)        || content.root_causes.length < 1)     missing.push("root_causes");
  if (!content.funnel_analysis?.summary?.trim())                                         missing.push("funnel_analysis");
  if (!Array.isArray(content.recommendations)    || content.recommendations.length < 1) missing.push("recommendations");
  if (!Array.isArray(content.top_3_actions)      || content.top_3_actions.length !== 3) missing.push("top_3_actions");
  if (!content.expected_impact?.summary?.trim())                                         missing.push("expected_impact");
  if (!content.confidence_notes?.trim())                                                 missing.push("confidence_notes");
  return missing;
}

// ─────────────────────────────────────────────
// LLM CALLER WITH 40s TIMEOUT (Items 2 + 6)
// Returns { content, inputTokens, outputTokens } or throws.
// Throws DOMException with name "AbortError" on timeout.
// ─────────────────────────────────────────────

async function callLLM(
  prompt: string,
  openAiKey: string,
): Promise<{ content: ReportContent; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let llmResponse: Response;
  try {
    llmResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Authorization": `Bearer ${openAiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:           GPT4O_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: prompt },
        ],
        temperature:     0.3,
        max_tokens:      3000,
        response_format: { type: "json_object" },
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!llmResponse.ok) {
    const body = await llmResponse.text();
    throw new Error(`OpenAI ${llmResponse.status}: ${body}`);
  }

  const llmJson    = await llmResponse.json();
  const inputTokens  = llmJson.usage?.prompt_tokens     ?? 0;
  const outputTokens = llmJson.usage?.completion_tokens ?? 0;

  const parsed   = JSON.parse(llmJson.choices[0].message.content) as ReportContent;
  const content: ReportContent = {
    executive_summary:     (parsed.executive_summary ?? "").slice(0, 1000),
    problems:              (parsed.problems ?? []).slice(0, 8),
    root_causes:           (parsed.root_causes ?? []).slice(0, 6),
    conversation_findings: (parsed.conversation_findings ?? []).slice(0, 6),
    funnel_analysis:       parsed.funnel_analysis ?? { summary: "", biggest_leak: "", stage_insights: [] },
    recommendations:       (parsed.recommendations ?? []).slice(0, 10),
    top_3_actions:         (parsed.top_3_actions ?? []).slice(0, 3),
    expected_impact:       parsed.expected_impact ?? { summary: "", conversion_lift: "", revenue_impact: "" },
    confidence_notes:      (parsed.confidence_notes ?? "").slice(0, 500),
    // Enterprise-only (pass through if present)
    ...(parsed.team_overview              ? { team_overview:              parsed.team_overview } : {}),
    ...(parsed.users_requiring_attention  ? { users_requiring_attention:  (parsed.users_requiring_attention ?? []).slice(0, 8) } : {}),
    ...(parsed.coaching_priorities        ? { coaching_priorities:        (parsed.coaching_priorities ?? []).slice(0, 5) } : {}),
  };

  return { content, inputTokens, outputTokens };
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT (role + persona)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior revenue operations consultant with 15 years of B2B sales experience.
You specialize in diagnosing conversion leaks in AI-assisted sales pipelines.
Your reports are precise, data-driven, and actionable.

You do NOT produce:
- Vague advice like "improve your messaging" or "follow up faster"
- Motivational language or filler

You DO produce:
- Specific diagnoses tied to actual pipeline metrics
- Root-cause analysis with clear causal logic
- Prioritized, implementable recommendations
- Realistic impact estimates based on observed data

Respond ONLY with a valid JSON object matching the exact schema provided. No prose outside the JSON.`;

// ─────────────────────────────────────────────
// ENTERPRISE TEAM PROMPT SECTION
// Injected into buildDoctorPrompt when teamAttention is present
// ─────────────────────────────────────────────

function buildTeamPromptSection(team: TeamAttentionResult): string {
  const attentionLines = team.immediateAttention.slice(0, 5).map((a) => {
    const flags: string[] = [];
    if (a.slowResponseCount)    flags.push(`slow_response(${a.slowResponseCount})`);
    if (a.noResponseCount)      flags.push(`no_response(${a.noResponseCount})`);
    if (a.highIntentLossCount)  flags.push(`high_intent_loss(${a.highIntentLossCount})`);
    if (a.pricingLeakCount)     flags.push(`pricing_leak(${a.pricingLeakCount})`);
    if (a.bookingWeaknessCount) flags.push(`booking_weakness(${a.bookingWeaknessCount})`);
    if (a.oneSidedCount)        flags.push(`one_sided(${a.oneSidedCount})`);
    return `  ${a.displayName}: score=${a.priorityScore}, leads=${a.leadsAssigned}, convs=${a.conversationsStarted}, deals=${a.dealsClosed}, flags=[${flags.join(", ")}]`;
  }).join("\n");

  const coachingLines = team.coaching.slice(0, 5).map((a) => {
    const flags: string[] = [];
    if (a.slowResponseCount)    flags.push(`slow_response(${a.slowResponseCount})`);
    if (a.highIntentLossCount)  flags.push(`high_intent_loss(${a.highIntentLossCount})`);
    if (a.pricingLeakCount)     flags.push(`pricing_leak(${a.pricingLeakCount})`);
    if (a.bookingWeaknessCount) flags.push(`booking_weakness(${a.bookingWeaknessCount})`);
    return `  ${a.displayName}: score=${a.priorityScore}, leads=${a.leadsAssigned}, deals=${a.dealsClosed}, flags=[${flags.join(", ")}]`;
  }).join("\n");

  const topLines = team.topPerformers.slice(0, 3).map((a) =>
    `  ${a.displayName}: leads=${a.leadsAssigned}, deals=${a.dealsClosed}, avg_response=${a.avgResponseMinutes ?? "N/A"}min`
  ).join("\n");

  return `

═══ ENTERPRISE TEAM INTELLIGENCE ═══
${team.windowSummary}
Total agents: ${team.totalAgents} (${team.eligibleAgents} with sufficient data)

Agents Requiring Immediate Attention (score ≥60):
${attentionLines || "  None"}

Coaching Candidates (score 35–59):
${coachingLines || "  None"}

Top Performers (score <35, deals closed):
${topLines || "  None"}

ADDITIONAL OUTPUT REQUIRED FOR ENTERPRISE REPORTS:
Add these 3 keys to your JSON output (alongside the standard 9 sections):

"team_overview": {
  "summary": "2 sentence diagnosis of the team's overall performance pattern",
  "agents_total": ${team.totalAgents},
  "requires_attention": ${team.immediateAttention.length},
  "top_performer_name": "name of best agent or omit if none"
},
"users_requiring_attention": [
  {
    "display_name": "agent name from the data above",
    "flags": ["slow_response", "no_response", etc — only the triggered flags],
    "top_issue": "one sentence precise diagnosis of their biggest problem",
    "coaching_note": "one specific actionable coaching instruction"
  }
],
"coaching_priorities": [
  {
    "display_name": "agent name",
    "priority_focus": "the single highest-leverage area to improve",
    "specific_action": "one concrete change they should make this week"
  }
]

Rules for team sections:
- users_requiring_attention: include ALL agents with bucket=immediate_attention (up to 8)
- coaching_priorities: include top 5 coaching candidates by priority_score
- All names must match exactly what was provided in the data above
- coaching_note and specific_action must reference actual flag data, not generic advice`;
}

// ─────────────────────────────────────────────
// PROMPT BUILDER
// Converts DiagnosticPayload to LLM-safe structured text
// ─────────────────────────────────────────────

function buildDoctorPrompt(p: Awaited<ReturnType<typeof buildDiagnosticPayload>>): string {
  const s  = p.orgSummary;
  const h  = p.healthSnapshot;
  const ci = p.conversationIntelligence;
  const fi = p.funnelInsights;
  const ai = p.automationInsights;

  const funnelStr = fi.stages
    .filter((st) => st.absoluteIn > 0)
    .map((st) => `  ${st.from} → ${st.to}: ${st.absoluteIn} in, ${st.absoluteOut} out (${st.rate}%)`)
    .join("\n");

  const objectionsStr = ci.topObjections.length > 0
    ? ci.topObjections.map((o) => `  - ${o.label}: ${o.count} leads (${o.sharePct}%)`).join("\n")
    : "  None detected";

  const intentsStr = ci.topIntents.length > 0
    ? ci.topIntents.map((i) => `  - ${i.label}: ${i.count} leads`).join("\n")
    : "  None detected";

  const evidenceStr = p.evidenceSamples.length > 0
    ? p.evidenceSamples.map((e) => `  [${e.channel.toUpperCase()}/${e.direction}] "${e.excerpt}"`).join("\n")
    : "  No evidence samples available";

  const warningsStr = h.warnings.length > 0
    ? h.warnings.map((w) => `  [${w.severity.toUpperCase()}] ${w.code}: ${w.message}`).join("\n")
    : "  No warnings";

  const categoryStr = h.categories
    .map((c) => `  ${c.category}: ${c.score}/100${c.delta !== null ? ` (Δ ${c.delta > 0 ? "+" : ""}${c.delta?.toFixed(1)})` : ""} — flags: ${c.flags?.join(", ") || "none"}`)
    .join("\n");

  return `REVENUE DOCTOR DIAGNOSTIC REQUEST
Analysis window: ${p.analysisWindow} (${p.windowStart.split("T")[0]} to ${p.windowEnd.split("T")[0]})

═══ ORG PIPELINE SUMMARY ═══
Leads this period:       ${s.leadsTotal}
Leads contacted:         ${s.leadsContacted}
Conversations started:   ${s.conversationsStarted}
Appointments booked:     ${s.appointmentsBooked}
Deals closed:            ${s.dealsClosed}
Primary channel:         ${s.primaryChannel}
Channel mix:             ${JSON.stringify(s.channelMix)}

═══ REVENUE HEALTH SCORES ═══
Overall: ${h.overallScore}/100
${categoryStr}

Active Warnings:
${warningsStr}

═══ FUNNEL BREAKDOWN ═══
${funnelStr || "  No funnel data available"}
Biggest drop-off stage: ${fi.biggestDropOff} (${fi.dropOffRate}% drop rate)
Data confidence: ${fi.dataConfidence}

═══ CONVERSATION INTELLIGENCE ═══
Sample size: ${ci.sampleCount} messages analyzed
Sentiment: ${ci.sentimentSummary}

Top Objections:
${objectionsStr}

Top Lead Intents:
${intentsStr}

Unanswered Question Patterns:
${ci.unansweredQuestionPatterns.length > 0 ? ci.unansweredQuestionPatterns.map((q) => `  - ${q}`).join("\n") : "  None detected"}

Buying Signals Observed:
${ci.buyingSignals.length > 0 ? ci.buyingSignals.map((b) => `  - ${b}`).join("\n") : "  None detected"}

═══ AUTOMATION PERFORMANCE ═══
Total tasks:       ${ai.totalTasks}
Completed:         ${ai.completedTasks} (${ai.completionRate}%)
Failed/Dead:       ${ai.failedTasks + ai.deadLetteredTasks} (${ai.failureRate}%)
Avg tasks/lead:    ${ai.avgTasksPerLead}
Channel breakdown: ${JSON.stringify(ai.channelBreakdown)}

═══ EVIDENCE SAMPLES (PII-scrubbed lead messages) ═══
${evidenceStr}

═══ REQUIRED OUTPUT SCHEMA ═══
Produce a JSON object with EXACTLY this structure:
{
  "executive_summary": "2-3 sentence precise summary of the biggest revenue leaks found",
  "problems": [
    {
      "title": "specific problem name",
      "severity": "high|medium|low",
      "evidence": ["data point 1", "data point 2"],
      "impact": "specific business impact statement"
    }
  ],
  "root_causes": [
    {
      "cause": "root cause name",
      "category": "messaging|timing|channel|follow-up|qualification|automation",
      "detail": "precise causal explanation tied to the data"
    }
  ],
  "conversation_findings": [
    {
      "finding": "specific pattern found in conversations",
      "supporting": "evidence from the sample data",
      "recommendation": "specific fix for this conversation pattern"
    }
  ],
  "funnel_analysis": {
    "summary": "precise 1-2 sentence funnel diagnosis",
    "biggest_leak": "stage name and specific drop-off reason",
    "stage_insights": ["insight per stage with data reference"]
  },
  "recommendations": [
    {
      "action": "specific actionable recommendation",
      "priority": "high|medium|low",
      "rationale": "why this addresses the root cause",
      "channel": "sms|voice|email|whatsapp|all"
    }
  ],
  "top_3_actions": [
    {
      "action": "the single most important action to take",
      "expected_result": "specific measurable outcome",
      "effort": "low|medium|high"
    }
  ],
  "expected_impact": {
    "summary": "overall impact projection",
    "conversion_lift": "estimated conversion rate improvement (be conservative and specific)",
    "revenue_impact": "qualitative revenue impact description"
  },
  "confidence_notes": "honest 1 sentence note about data quality or limitations"
}

Rules:
- All statements must reference the actual data provided above
- If data is insufficient (confidence=insufficient), note it but still diagnose what patterns exist
- problems array: 2-5 items, ranked by severity
- recommendations: 3-8 items, ranked by priority
- top_3_actions: exactly 3 items
- Be specific: cite actual numbers, not "many leads" or "some conversations"${p.teamAttention ? buildTeamPromptSection(p.teamAttention) : ""}`;
}

// ─────────────────────────────────────────────
// METRIC FLATTENER
// Extracts flat rows for doctor_report_metrics from a full report
// ─────────────────────────────────────────────

function buildMetricRows(
  reportId:      string,
  orgId:         string,
  windowType:    string,
  referenceDate: string,
  snapshot:      HealthSnapshot,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  // Category scores
  for (const cat of snapshot.categories) {
    rows.push({
      report_id:       reportId,
      org_id:          orgId,
      window_type:     windowType,
      reference_date:  referenceDate,
      metric_category: cat.category,
      metric_key:      "score",
      metric_value:    cat.score,
      metric_metadata: {
        delta: cat.deltaVsPrevious,
        flags: cat.flags,
      },
    });

    // Raw metrics within each category
    for (const [key, val] of Object.entries(cat.rawMetrics ?? {})) {
      if (val !== null && val !== undefined) {
        rows.push({
          report_id:       reportId,
          org_id:          orgId,
          window_type:     windowType,
          reference_date:  referenceDate,
          metric_category: cat.category,
          metric_key:      key,
          metric_value:    val,
          metric_metadata: {},
        });
      }
    }
  }

  // Overall score
  rows.push({
    report_id:       reportId,
    org_id:          orgId,
    window_type:     windowType,
    reference_date:  referenceDate,
    metric_category: "overall",
    metric_key:      "score",
    metric_value:    snapshot.overallScore,
    metric_metadata: { data_confidence: snapshot.dataConfidence },
  });

  return rows;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return err(405, "Method not allowed");
  }

  // ── 0. Request ID — trace token for structured logging ───────────────────
  const requestId = crypto.randomUUID();

  // ── 1. Parse body ───────────────────────────────────────────────────────
  let body: { org_id?: string; window_type?: string; reference_date?: string };
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const orgId         = body.org_id;
  const windowTypeRaw = body.window_type ?? "weekly";
  const referenceDate = body.reference_date;

  if (!orgId) return err(400, "org_id is required");
  if (!["daily", "weekly", "monthly"].includes(windowTypeRaw)) {
    return err(400, "window_type must be daily, weekly, or monthly");
  }
  const windowType = windowTypeRaw as WindowType;

  // ── 2. Auth check — user JWT required ────────────────────────────────────
  const userSb = getUserSupabaseClient(req);
  const { data: { user }, error: authErr } = await userSb.auth.getUser();
  if (authErr || !user) return err(401, "Unauthorized");
  const userId = user.id;

  const sb = getServiceSupabaseClient();

  // ── 3. Org membership gate + org type (parallel) ─────────────────────────
  const [{ data: memRow }, { data: profileRow }, { data: orgRow }] = await Promise.all([
    sb.from("org_members")
      .select("org_id")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .limit(1),
    sb.from("profiles")
      .select("is_admin")
      .eq("id", userId)
      .maybeSingle(),
    sb.from("organizations")
      .select("org_type")
      .eq("id", orgId)
      .maybeSingle(),
  ]);

  const isMember    = Array.isArray(memRow) && memRow.length > 0;
  const isAdmin     = profileRow?.is_admin === true;
  const isEnterprise = orgRow?.org_type === "enterprise";
  if (!isMember && !isAdmin) {
    return err(403, "Forbidden — you are not a member of this organisation");
  }

  // ── 3.5. Enterprise member map (fire when enterprise) ────────────────────
  let memberMap: Map<string, string> | undefined;
  if (isEnterprise) {
    const { data: memberRows } = await sb
      .from("org_members")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("role", "enterprise_agent");

    const agentIds = (memberRows ?? []).map((m: { user_id: string }) => m.user_id);
    if (agentIds.length > 0) {
      const { data: profileRows } = await sb
        .from("profiles")
        .select("id, full_name, email")
        .in("id", agentIds);

      memberMap = new Map(
        (profileRows ?? []).map((p: { id: string; full_name?: string; email?: string }) => [
          p.id,
          p.full_name?.trim() || p.email || `Agent [${p.id.slice(0, 6)}]`,
        ]),
      );
    }
  }

  // ── 4. Entitlement check — voice service must be active ──────────────────
  const { data: voiceSvc } = await sb
    .from("org_services")
    .select("status")
    .eq("org_id", orgId)
    .eq("service_key", "voice")
    .eq("status", "active")
    .maybeSingle();

  if (!voiceSvc) {
    return err(403, "Revenue Doctor requires an active Voice plan. Upgrade to unlock this feature.");
  }

  // ── 5. Quota check — doctor_report token_wallet balance ──────────────────
  const { data: wallet, error: walletErr } = await sb
    .from("token_wallets")
    .select("balance")
    .eq("org_id", orgId)
    .eq("token_key", TOKEN_KEY)
    .eq("scope", "org")
    .is("user_id", null)
    .maybeSingle();

  const currentBalance = wallet?.balance ?? 0;

  if (walletErr) {
    return err(500, "Unable to read report quota. Please try again.");
  }
  if (currentBalance < TOKEN_COST) {
    return err(402, "Report quota exhausted for this billing period.", {
      reports_remaining: 0,
      token_key:         TOKEN_KEY,
    });
  }

  // ── 4.5. Rate limit — max 3 generations per org per minute ───────────────
  // Checked AFTER quota (quota is cheaper) but BEFORE credit consume.
  const { count: recentCount } = await sb
    .from("revenue_doctor_reports")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gte("generated_at", new Date(Date.now() - 60_000).toISOString());

  if ((recentCount ?? 0) >= RATE_LIMIT_COUNT) {
    console.warn(`[revenue-doctor-generate] rate_limit org=${orgId} request_id=${requestId}`);
    return err(429, "Too many reports generated. Please wait a moment before generating another.", {
      retry_after_seconds: 60,
    });
  }

  // ── 6. Consume 1 doctor_report credit (before LLM — fail early) ──────────
  const idempotencyKey = crypto.randomUUID();

  const { data: consumeRes, error: consumeErr } = await sb.rpc("consume_tokens_v1", {
    p_org_id:          orgId,
    p_scope:           "org",
    p_user_id:         userId,   // passed for auth.uid() audit; ignored by RPC when scope=org
    p_token_key:       TOKEN_KEY,
    p_amount:          TOKEN_COST,
    p_idempotency_key: idempotencyKey,
    p_metadata: {
      window_type:    windowType,
      reference_date: referenceDate ?? null,
      source:         "revenue_doctor_generate",
      triggered_by:   userId,
      request_id:     requestId,
    },
  });

  if (consumeErr || consumeRes?.status !== "ok") {
    if (consumeRes?.reason === "INSUFFICIENT_BALANCE") {
      return err(402, "Report quota exhausted for this billing period.", {
        reports_remaining: 0,
        token_key:         TOKEN_KEY,
      });
    }
    console.error(`[revenue-doctor-generate] Credit consume failed request_id=${requestId}:`, consumeErr, consumeRes);
    return err(500, "Failed to consume report credit. Please try again.");
  }

  // ── Helper: refund credit ─────────────────────────────────────────────────
  const refundCredit = (reason: string) =>
    sb.rpc("grant_tokens_core_v1", {
      p_org_id:          orgId,
      p_scope:           "org",
      p_user_id:         userId,
      p_token_key:       TOKEN_KEY,
      p_amount:          TOKEN_COST,
      p_idempotency_key: `refund:${idempotencyKey}`,
      p_metadata:        { reason, source: "revenue_doctor_generate", request_id: requestId },
    }).then(undefined, (e: unknown) =>
      console.error(`[revenue-doctor-generate] Credit refund failed request_id=${requestId}:`, e),
    );

  // ── 7. Fetch window data (all adapters in parallel) ───────────────────────
  const window  = buildDateWindow(windowType, referenceDate);
  const prevW   = makePrevPeriodWindow(window);

  let leads, convs, channels, funnel, campaigns;
  let prevLeads, prevConvs, prevChannels, prevFunnel;

  try {
    [
      [leads, convs, channels, funnel, campaigns],
      [prevLeads, prevConvs, prevChannels, prevFunnel],
    ] = await Promise.all([
      Promise.all([
        fetchLeadFacts(sb, orgId, window),
        fetchConversationFacts(sb, orgId, window),
        fetchChannelFacts(sb, orgId, window),
        fetchFunnelFacts(sb, orgId, window),
        fetchCampaignFacts(sb, orgId, window),
      ]),
      Promise.all([
        fetchLeadFacts(sb, orgId, prevW),
        fetchConversationFacts(sb, orgId, prevW),
        fetchChannelFacts(sb, orgId, prevW),
        fetchFunnelFacts(sb, orgId, prevW),
      ]),
    ]);
  } catch (fetchErr) {
    console.error(`[revenue-doctor-generate] Data fetch failed request_id=${requestId}:`, fetchErr);
    await refundCredit("data_fetch_failed");
    return err(500, "Failed to fetch analytics data. Your report credit has been refunded.");
  }

  // ── 8. Compute health snapshot ────────────────────────────────────────────
  const leadResponseCat  = scoreLeadResponse(leads, prevLeads);
  const convQualityCat   = scoreConversationQuality(convs, prevConvs);
  const channelHealthCat = scoreChannelHealth(channels, prevChannels);
  const { score: convHealthCat, dataConfidence } =
    scoreConversionHealth(funnel, prevFunnel);

  const categories: CategoryScore[] = [
    leadResponseCat,
    convQualityCat,
    channelHealthCat,
    convHealthCat,
  ];

  const overallScore = computeOverallScore(categories);
  const warnings     = generateWarnings(categories);

  const overallConfidence = (
    leads.length    === 0 &&
    convs.length    === 0 &&
    channels.length === 0
  ) ? "insufficient" : dataConfidence;

  const snapshot: HealthSnapshot = {
    orgId,
    windowType,
    referenceDate:  window.referenceDate,
    windowStart:    window.windowStart.toISOString(),
    windowEnd:      window.windowEnd.toISOString(),
    overallScore,
    categories,
    warnings,
    dataConfidence: overallConfidence,
    computedAt:     new Date().toISOString(),
  };

  // ── 9. Build DiagnosticPayload ────────────────────────────────────────────
  const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!openAiKey) {
    console.error(`[revenue-doctor-generate] OPENAI_API_KEY not set request_id=${requestId}`);
    await refundCredit("openai_key_missing");
    return err(500, "Report generation is temporarily unavailable. Your report credit has been refunded.");
  }

  let diagnosticPayload: Awaited<ReturnType<typeof buildDiagnosticPayload>>;
  try {
    diagnosticPayload = await buildDiagnosticPayload(
      sb, orgId, window, snapshot, convs, funnel, campaigns, openAiKey,
      leads, isEnterprise, memberMap,
    );
  } catch (payloadErr) {
    console.error(`[revenue-doctor-generate] Payload build failed request_id=${requestId}:`, payloadErr);
    await refundCredit("payload_build_failed");
    return err(500, "Failed to build diagnostic context. Your report credit has been refunded.");
  }

  // ── 10. GPT-4o LLM report generation ─────────────────────────────────────
  // — 40s timeout: AbortController → refund + 504
  // — Output validation: retry once on invalid output; refund + 422 if still invalid
  const prompt           = buildDoctorPrompt(diagnosticPayload);
  const generationStart  = Date.now();

  let reportContent: ReportContent | undefined;
  let inputTokens   = 0;
  let outputTokens  = 0;

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      const result = await callLLM(prompt, openAiKey);
      const issues = validateReportContent(result.content);

      if (issues.length === 0) {
        reportContent = result.content;
        inputTokens   = result.inputTokens;
        outputTokens  = result.outputTokens;
        break;
      }

      console.warn(
        `[revenue-doctor-generate] LLM output invalid (attempt ${attempt}/${MAX_LLM_ATTEMPTS}), missing: ${issues.join(", ")} request_id=${requestId}`,
      );

      if (attempt === MAX_LLM_ATTEMPTS) {
        // Both attempts invalid — refund and fail
        await refundCredit("llm_output_invalid");
        return err(422, "Report generation produced an incomplete response after retrying. Your report credit has been refunded.", {
          request_id:     requestId,
          missing_fields: issues,
        });
      }
      // else: loop to attempt 2
    } catch (llmErr) {
      const isTimeout = llmErr instanceof DOMException && llmErr.name === "AbortError";
      console.error(
        `[revenue-doctor-generate] LLM ${isTimeout ? "timeout" : "error"} (attempt ${attempt}/${MAX_LLM_ATTEMPTS}) request_id=${requestId}:`,
        llmErr,
      );

      if (isTimeout) {
        // Don't retry on timeout — provider is slow; refund immediately
        await refundCredit("llm_timeout");
        return err(504, "Report generation timed out. Your report credit has been refunded.", {
          request_id: requestId,
        });
      }

      if (attempt === MAX_LLM_ATTEMPTS) {
        await refundCredit("llm_call_failed");
        return err(502, "Report generation failed due to an AI service error. Your report credit has been refunded.", {
          request_id: requestId,
        });
      }
      // else: retry on non-timeout error
    }
  }

  const generationDurationMs = Date.now() - generationStart;

  console.log(
    `[revenue-doctor-generate] LLM success request_id=${requestId} org=${orgId} duration_ms=${generationDurationMs} in=${inputTokens} out=${outputTokens}`,
  );

  // ── 11. Persist to revenue_doctor_reports ─────────────────────────────────
  const generatedAt = new Date().toISOString();

  const reportRow = {
    org_id:                orgId,
    window_type:           windowType,
    window_start:          window.windowStart.toISOString(),
    window_end:            window.windowEnd.toISOString(),
    health_snapshot: {
      overall_score:       overallScore,
      category_scores:     Object.fromEntries(categories.map((c) => [c.category, c.score])),
      data_confidence:     overallConfidence,
    },
    diagnostic_payload:    diagnosticPayload,
    report_content:        reportContent,
    executive_summary:     reportContent!.executive_summary,
    overall_score:         overallScore,
    model_used:            GPT4O_MODEL,
    input_token_count:     inputTokens,
    output_token_count:    outputTokens,
    generated_at:          generatedAt,
    generated_by:          userId,
    request_id:            requestId,
    generation_duration_ms: generationDurationMs,
  };

  const { data: savedReport, error: saveErr } = await sb
    .from("revenue_doctor_reports")
    .insert(reportRow)
    .select("id")
    .single();

  if (saveErr || !savedReport) {
    console.error(`[revenue-doctor-generate] Report save failed request_id=${requestId}:`, saveErr);
    // Don't refund — analysis done, credit spent. Return report inline.
    console.error(`[revenue-doctor-generate] Report content (unsaved) request_id=${requestId}:`, JSON.stringify(reportContent).slice(0, 500));
    return ok({
      report_id:       null,
      org_id:          orgId,
      request_id:      requestId,
      window:          windowType,
      window_start:    window.windowStart.toISOString(),
      window_end:      window.windowEnd.toISOString(),
      generated_at:    generatedAt,
      overall_score:   overallScore,
      data_confidence: overallConfidence,
      report:          reportContent,
      save_error:      "Report could not be saved but has been returned. Please copy this result.",
    });
  }

  const reportId = savedReport.id;

  // ── 12. Flatten metrics to doctor_report_metrics (fire-and-forget) ────────
  const metricRows = buildMetricRows(
    reportId, orgId, windowType, window.referenceDate, snapshot,
  );

  sb.from("doctor_report_metrics")
    .insert(metricRows)
    .then(undefined, (e: unknown) =>
      console.error(`[revenue-doctor-generate] Metric insert failed request_id=${requestId}:`, e),
    );

  // ── 13. Return structured report ──────────────────────────────────────────
  const reportsRemaining = Math.max(0, currentBalance - TOKEN_COST);

  return ok({
    report_id:              reportId,
    org_id:                 orgId,
    request_id:             requestId,
    window:                 windowType,
    window_start:           window.windowStart.toISOString(),
    window_end:             window.windowEnd.toISOString(),
    generated_at:           generatedAt,
    overall_score:          overallScore,
    data_confidence:        overallConfidence,
    reports_remaining:      reportsRemaining,
    generation_duration_ms: generationDurationMs,
    report:                 reportContent,
  });
});
