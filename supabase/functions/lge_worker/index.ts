// lge_worker — LGE Processing Worker
// Invoked by pg_cron every 2 min (--no-verify-jwt).
// Pipeline per lead: claim → enrich (Apollo + Hunter) → score → GPT context → route → push to GSC.

import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import {
  decryptProviderKey,
  enrichWithApollo,
  verifyWithHunter,
  enrichFromHunterDomain,
  verifyPhoneAbstract,
  checkWebsiteReachable,
  type ApolloResult,
  type HunterResult,
  type HunterDomainResult,
} from "../_shared/lge_providers.ts";
import {
  computeFitScore,
  computeConfidenceScore,
  computeTotalScore,
  computeSignalAdjustments,
  routeByScore,
  type IcpConfig,
  type EnrichmentData,
} from "../_shared/lge_scorer.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 10;
const LOCK_MINUTES = 5;
const CONCURRENCY = 4;

function workerId(): string {
  return `lge_worker:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];

  async function drain() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  }

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(drain());
  }
  await Promise.all(workers);
}

// ── GPT context generation ────────────────────────────────────────────────────

interface LgeContext {
  reason_to_reach_out: string;
  pain_point_hypothesis: string;
  recommended_pitch_angle: string;
}

async function generateContext(
  lead: { name?: string | null; company?: string | null },
  enrich: EnrichmentData,
  icp: IcpConfig,
): Promise<LgeContext> {
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiKey) throw new Error("OPENAI_API_KEY not set");

  const prompt = `You are a B2B sales researcher. Given this lead profile, write a JSON object with exactly three string fields.

Lead:
- Name: ${lead.name ?? "Unknown"}
- Company: ${lead.company ?? "Unknown"}
- Industry: ${enrich.industry ?? "Unknown"}
- Company size: ${enrich.company_size ?? "Unknown"}
- Job title: ${enrich.designation ?? "Unknown"}

Target buyer profile:
- Industries: ${icp.industry?.join(", ") ?? "Any"}
- Company sizes: ${icp.company_size?.join(", ") ?? "Any"}
- Target titles: ${icp.designations?.join(", ") ?? "Any"}

Return ONLY valid JSON:
{
  "reason_to_reach_out": "1-2 sentences — specific reason this lead is worth contacting now",
  "pain_point_hypothesis": "1-2 sentences — likely business pain this lead faces based on their role/industry",
  "recommended_pitch_angle": "1 sentence — the strongest angle for the first outreach"
}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);

    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);

    return {
      reason_to_reach_out: String(parsed.reason_to_reach_out ?? ""),
      pain_point_hypothesis: String(parsed.pain_point_hypothesis ?? ""),
      recommended_pitch_angle: String(parsed.recommended_pitch_angle ?? ""),
    };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── Resolve actor user for an org ─────────────────────────────────────────────
// Matches hook_inbound's pattern: named roles first, null-role solo user fallback.

async function resolveActorUserId(sb: ReturnType<typeof getServiceSupabaseClient>, orgId: string): Promise<string | null> {
  const { data: namedRow } = await sb
    .from("org_members")
    .select("user_id")
    .eq("org_id", orgId)
    .in("role", ["enterprise_admin", "agency_admin", "owner"])
    .limit(1)
    .maybeSingle();

  if (namedRow) return namedRow.user_id;

  const { data: nullRow } = await sb
    .from("org_members")
    .select("user_id")
    .eq("org_id", orgId)
    .is("role", null)
    .limit(1)
    .maybeSingle();

  return nullRow?.user_id ?? null;
}

// ── Push lead to GSC pipeline ─────────────────────────────────────────────────
// Replicates hook_inbound's DB pattern directly (no HTTP call).

async function pushToGsc(
  sb: ReturnType<typeof getServiceSupabaseClient>,
  lead: {
    lead_id: string;
    org_id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
  },
  context: LgeContext | null,
  totalScore: number,
  outreachTemplate: string | null = null,
): Promise<string | null> {
  const actorUserId = await resolveActorUserId(sb, lead.org_id);
  if (!actorUserId) {
    console.error("[lge_worker] no actor user for org", lead.org_id);
    return null;
  }

  // Phone dedupe guard (same as hook_inbound)
  if (lead.phone) {
    const { data: existing } = await sb
      .from("leads")
      .select("id")
      .eq("org_id", lead.org_id)
      .eq("phone", lead.phone)
      .maybeSingle();
    if (existing) return existing.id as string;
  }

  const notes = JSON.stringify({
    source: "lge",
    lge_lead_id: lead.lead_id,
    score: totalScore,
    company: lead.company ?? null,
    reason: context?.reason_to_reach_out ?? null,
    pitch: context?.recommended_pitch_angle ?? null,
  });

  const { data: gscLead, error: leadErr } = await sb
    .from("leads")
    .insert({
      org_id: lead.org_id,
      profile_id: actorUserId,
      name: lead.name,
      phone: lead.phone ?? null,
      email: lead.email ?? null,
      notes,
      status: "new",
      source: "lge",
    })
    .select("id")
    .single();

  if (leadErr || !gscLead) {
    console.error("[lge_worker] lead insert failed:", leadErr?.message);
    return null;
  }

  const { data: plan, error: planErr } = await sb
    .from("decision_plans")
    .insert({
      lead_id: gscLead.id,
      org_id: lead.org_id,
      trigger: "webhook_inbound",
      plan: { channel: "sms", source_event: "lge_push", source: "lge" },
    })
    .select("id")
    .single();

  if (planErr || !plan) {
    console.error("[lge_worker] plan insert failed:", planErr?.message);
    return gscLead.id as string; // lead created — still return it
  }

  await sb.from("execution_tasks").insert({
    plan_id: plan.id,
    lead_id: gscLead.id,
    org_id: lead.org_id,
    channel: "sms",
    max_attempts: 3,
    scheduled_for: new Date().toISOString(),
    status: "pending",
    actor_user_id: actorUserId,
    metadata: {
      source: "lge",
      source_event: "lge_push",
      trigger: "introductory_sms",
      lge_lead_id: lead.lead_id,
      lge_score: totalScore,
      ...(outreachTemplate ? { force_content: outreachTemplate } : {}),
    },
  });

  return gscLead.id as string;
}

// ── Per-lead processor ────────────────────────────────────────────────────────

interface ClaimedLead {
  lead_id: string;
  campaign_id: string;
  org_id: string;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  lead_company: string | null;
  lead_source: string;
  raw_data: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  campaign_mode: string;
  icp_config: IcpConfig;
}

type OrgKeys = { apollo?: string; hunter?: string; abstract_phone?: string };
// source → adjustments (Phase 14: adds reliability_score and reliability_sample)
type SourceAdjMap = Map<string, { confidence_adj: number; recency_adj: number; reliability_score: number | null; reliability_sample: number }>;
// Per-campaign routing config
type CampaignConfig = {
  auto_push_threshold: number;
  review_threshold: number;
  outreach_template: string | null;
};

async function processLead(
  lead: ClaimedLead,
  sb: ReturnType<typeof getServiceSupabaseClient>,
  orgKeyCache: Map<string, OrgKeys>,
  sourceAdjCache: Map<string, SourceAdjMap>,
  campaignConfigCache: Map<string, CampaignConfig>,
): Promise<void> {
  try {
    // Load and cache provider keys per org
    if (!orgKeyCache.has(lead.org_id)) {
      const { data: rows } = await sb
        .from("lge_provider_config")
        .select("provider, api_key_encrypted")
        .eq("org_id", lead.org_id)
        .eq("is_active", true);

      const keys: OrgKeys = {};
      for (const row of rows ?? []) {
        try {
          keys[row.provider as "apollo" | "hunter" | "abstract_phone"] = await decryptProviderKey(row.api_key_encrypted);
        } catch {
          console.warn("[lge_worker] decrypt failed for", row.provider, lead.org_id);
        }
      }
      orgKeyCache.set(lead.org_id, keys);
    }
    const keys = orgKeyCache.get(lead.org_id)!;

    // Load and cache source reliability + recency adjustments per org
    if (!sourceAdjCache.has(lead.org_id)) {
      const { data: sourceRows } = await sb
        .from("lge_source_stats")
        .select("source, confidence_adj, recency_adj, reliability_score, sample_size")
        .eq("org_id", lead.org_id);
      const adjMap: SourceAdjMap = new Map();
      for (const row of sourceRows ?? []) {
        adjMap.set(row.source, {
          confidence_adj:    Number(row.confidence_adj)    || 0,
          recency_adj:       Number(row.recency_adj)       || 0,
          reliability_score: row.reliability_score != null ? Number(row.reliability_score) : null,
          reliability_sample: Number(row.sample_size) || 0,
        });
      }
      sourceAdjCache.set(lead.org_id, adjMap);
    }
    const srcEntry   = sourceAdjCache.get(lead.org_id)!.get(lead.lead_source ?? "unknown");
    const sourceAdj  = srcEntry?.confidence_adj ?? 0;
    const recencyAdj = srcEntry?.recency_adj ?? 0;

    // Phase 14: reliability_score modifier (requires ≥100 sample, bounded ±5)
    // reliability ≥70 → +1..+5; reliability <30 → -1..-5; else 0
    const reliabilityScore  = (srcEntry?.reliability_sample ?? 0) >= 100 ? (srcEntry?.reliability_score ?? null) : null;
    let reliabilityModifier = 0;
    if (reliabilityScore !== null) {
      if (reliabilityScore >= 70) {
        reliabilityModifier = Math.round(((reliabilityScore - 70) / 30) * 5);   // 0 to +5
      } else if (reliabilityScore < 30) {
        reliabilityModifier = Math.round(((reliabilityScore - 30) / 30) * 5);   // -5 to 0
      }
    }

    // Load and cache per-campaign routing config (thresholds + outreach template)
    if (!campaignConfigCache.has(lead.campaign_id)) {
      const { data: camp } = await sb
        .from("lge_campaigns")
        .select("auto_push_threshold, review_threshold, outreach_template")
        .eq("id", lead.campaign_id)
        .maybeSingle();
      campaignConfigCache.set(lead.campaign_id, {
        auto_push_threshold: camp?.auto_push_threshold ?? 80,
        review_threshold:    camp?.review_threshold    ?? 60,
        outreach_template:   camp?.outreach_template   ?? null,
      });
    }
    const campConfig = campaignConfigCache.get(lead.campaign_id)!;

    // Prior GSC engagement check — warm re-engagement signal
    let priorEngagement = false;
    if (lead.lead_email || lead.lead_phone) {
      let engQuery = sb.from("leads").select("id", { count: "exact", head: true }).eq("org_id", lead.org_id);
      if (lead.lead_email) engQuery = engQuery.eq("email", lead.lead_email);
      else if (lead.lead_phone) engQuery = engQuery.eq("phone", lead.lead_phone);
      const { count } = await engQuery;
      priorEngagement = (count ?? 0) > 0;
    }

    const leadContact = {
      name: lead.lead_name,
      email: lead.lead_email,
      company: lead.lead_company,
    };

    // ── Apollo enrichment ─────────────────────────────────────────────────────
    let apolloResult: ApolloResult | null = null;
    const hasApolloInput = !!(lead.lead_email || lead.lead_name || lead.lead_company);

    if (keys.apollo && hasApolloInput) {
      apolloResult = await enrichWithApollo(keys.apollo, leadContact);
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "apollo",
        status: apolloResult ? "success" : "failed",
      });
    } else {
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "apollo",
        status: "skipped",
        error_detail: keys.apollo ? null : "no_api_key",
      });
    }

    // ── Hunter email verification ─────────────────────────────────────────────
    let hunterResult: HunterResult | null = null;

    if (keys.hunter && lead.lead_email) {
      hunterResult = await verifyWithHunter(keys.hunter, lead.lead_email);
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "hunter",
        status: hunterResult ? "success" : "failed",
      });
    } else {
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "hunter",
        status: "skipped",
        error_detail: !keys.hunter ? "no_api_key" : "no_email",
      });
    }

    // ── Hunter Domain Search (firmographic fallback) ──────────────────────────
    // Only runs when Apollo returned no industry/company_size AND a Hunter key + email are available.
    let hunterDomainResult: HunterDomainResult | null = null;
    const apolloMissingFirmographic = !apolloResult?.industry && !apolloResult?.company_size;

    if (keys.hunter && lead.lead_email && apolloMissingFirmographic) {
      hunterDomainResult = await enrichFromHunterDomain(keys.hunter, lead.lead_email);
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "hunter_domain",
        status: hunterDomainResult ? "success" : "failed",
      });
    } else {
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "hunter_domain",
        status: "skipped",
        error_detail: !keys.hunter ? "no_api_key"
          : !lead.lead_email ? "no_email"
          : "apollo_sufficient",
      });
    }

    // ── AbstractAPI Phone Verification ────────────────────────────────────────
    let phoneVerifyResult: { valid: boolean; line_type: string; carrier: string | null } | null = null;

    if (keys.abstract_phone && lead.lead_phone) {
      phoneVerifyResult = await verifyPhoneAbstract(keys.abstract_phone, lead.lead_phone);
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "abstract_phone",
        status: phoneVerifyResult ? "success" : "failed",
      });
    } else {
      await sb.from("lge_provider_calls").insert({
        raw_lead_id: lead.lead_id,
        provider: "abstract_phone",
        status: "skipped",
        error_detail: !keys.abstract_phone ? "no_api_key" : "no_phone",
      });
    }

    // ── Website Reachability ──────────────────────────────────────────────────
    // No API key required — always attempt for business email domains.
    const websiteReachable = await checkWebsiteReachable(lead.lead_email);

    // ── Build enrichment object ───────────────────────────────────────────────
    // Apollo is primary for firmographic; Hunter Domain is fallback.
    const firmographicSource =
      apolloResult?.industry || apolloResult?.company_size ? "apollo"
      : hunterDomainResult?.industry || hunterDomainResult?.company_size ? "hunter_domain"
      : "none";

    const enrich: EnrichmentData = {
      industry:          apolloResult?.industry    ?? hunterDomainResult?.industry    ?? null,
      company_size:      apolloResult?.company_size ?? hunterDomainResult?.company_size ?? null,
      designation:       apolloResult?.designation ?? null,
      email_verified:    hunterResult?.email_verified ?? null,
      phone_line_type:   phoneVerifyResult?.line_type ?? null,
      phone_valid:       phoneVerifyResult != null ? phoneVerifyResult.valid : null,
      website_reachable: websiteReachable,
    };

    const anyEnrichmentData = apolloResult || hunterResult || hunterDomainResult || phoneVerifyResult || websiteReachable !== null;
    if (anyEnrichmentData) {
      await sb.from("lge_enrichment").upsert(
        {
          raw_lead_id:        lead.lead_id,
          industry:           enrich.industry,
          company_size:       enrich.company_size,
          designation:        enrich.designation,
          email_verified:     enrich.email_verified,
          phone_line_type:    enrich.phone_line_type,
          phone_valid:        enrich.phone_valid,
          website_reachable:  enrich.website_reachable,
          firmographic_source: firmographicSource,
          sources_json: {
            ...(apolloResult?.sources_json ?? {}),
            hunter_status:      hunterResult?.hunter_status    ?? null,
            hunter_domain_org:  hunterDomainResult?.organization ?? null,
            phone_carrier:      phoneVerifyResult?.carrier      ?? null,
          },
        },
        { onConflict: "raw_lead_id" },
      );
    }

    // Scoring
    const icp = lead.icp_config ?? {};

    // Basic mode: org has no active API keys → enrichment never ran → ICP constraints
    // requiring enrichment data (industry, company_size, designation, geography) cannot be
    // evaluated. Pass empty ICP so all fit dimensions give full credit and routing is
    // driven purely by contact-data confidence. When real API keys are added later,
    // re-processing will apply the full ICP constraints with actual enrichment data.
    const hasProviderKeys = !!(keys.apollo || keys.hunter);
    const scoringIcp: IcpConfig = hasProviderKeys ? icp : {};

    // Extract designation from raw_data for completeness signal (title / job_title / designation keys)
    const rawDesignation = String(
      lead.raw_data?.designation ?? lead.raw_data?.title ?? lead.raw_data?.job_title ?? ""
    ).trim() || null;

    const leadForScoring = {
      name: lead.lead_name,
      email: lead.lead_email,
      phone: lead.lead_phone,
      company: lead.lead_company,
      designation: enrich.designation ?? rawDesignation,
    };

    const signals = computeSignalAdjustments(leadForScoring, sourceAdj, recencyAdj, priorEngagement);

    const fitScore            = computeFitScore(enrich, scoringIcp);
    const baseConfidenceScore = computeConfidenceScore(leadForScoring, enrich, signals.total);
    // Phase 14: apply reliability modifier (bounded ±5, requires ≥100 sample)
    const confidenceScore     = Math.max(0, Math.min(100, baseConfidenceScore + reliabilityModifier));
    const fitWeight = typeof icp.fit_weight === "number" ? icp.fit_weight : 0.6;
    const confidenceWeight = typeof icp.confidence_weight === "number" ? icp.confidence_weight : 0.4;
    const totalScore = computeTotalScore(fitScore, confidenceScore, fitWeight, confidenceWeight);

    await sb.from("lge_scores").upsert(
      {
        raw_lead_id: lead.lead_id,
        fit_score: fitScore,
        confidence_score: confidenceScore,
        total_score: totalScore,
      },
      { onConflict: "raw_lead_id" },
    );

    // GPT context generation
    let context: LgeContext | null = null;
    try {
      context = await generateContext(leadContact, enrich, icp);
      await sb.from("lge_context").upsert(
        {
          raw_lead_id: lead.lead_id,
          reason_to_reach_out: context.reason_to_reach_out,
          pain_point_hypothesis: context.pain_point_hypothesis,
          recommended_pitch_angle: context.recommended_pitch_angle,
        },
        { onConflict: "raw_lead_id" },
      );
    } catch (ctxErr: any) {
      console.warn("[lge_worker] context generation failed:", ctxErr.message);
    }

    // Phase 15: Org policy enforcement — load once per org (lazy via orgKeyCache structure)
    // Check: blocked_sources, risk_threshold, compliance_filters
    let orgPolicyBlock: string | null = null;
    {
      const { data: policy } = await sb.from("lge_org_policies")
        .select("blocked_sources, risk_threshold, compliance_filters, allowed_sources")
        .eq("org_id", lead.org_id).maybeSingle();

      if (policy) {
        const src = lead.lead_source ?? "unknown";
        // Blocked source check
        if (policy.blocked_sources && Array.isArray(policy.blocked_sources) && policy.blocked_sources.includes(src)) {
          orgPolicyBlock = `source_blocked:${src}`;
        }
        // Allowed source check (if set, only these sources are permitted)
        if (!orgPolicyBlock && policy.allowed_sources && Array.isArray(policy.allowed_sources) && policy.allowed_sources.length > 0) {
          if (!policy.allowed_sources.includes(src)) {
            orgPolicyBlock = `source_not_allowed:${src}`;
          }
        }
        // Reliability below risk_threshold (if policy requires minimum reliability)
        if (!orgPolicyBlock && policy.risk_threshold > 0 && reliabilityScore !== null && reliabilityScore < policy.risk_threshold) {
          orgPolicyBlock = `reliability_below_threshold:${reliabilityScore}<${policy.risk_threshold}`;
        }
        // Compliance filters: require_verified_email
        const cf = policy.compliance_filters as any;
        if (!orgPolicyBlock && cf?.require_verified_email && !enrich.email_verified) {
          orgPolicyBlock = "compliance:email_not_verified";
        }
        if (!orgPolicyBlock && cf?.require_verified_phone && !enrich.phone_valid) {
          orgPolicyBlock = "compliance:phone_not_verified";
        }
      }
    }

    // Routing
    let routingDecision: "auto_push" | "review_queue" | "discard" | "shadow_only";
    let newStatus: string;

    if (lead.campaign_mode === "shadow") {
      routingDecision = "shadow_only";
      newStatus = "scored";
    } else if (orgPolicyBlock) {
      // Policy enforcement → discard (policy violations don't go to review queue to prevent backlog)
      routingDecision = "discard";
      newStatus = "discarded";
    } else {
      routingDecision = routeByScore(totalScore, campConfig.auto_push_threshold, campConfig.review_threshold);
      newStatus = routingDecision === "auto_push" ? "pushed"
        : routingDecision === "review_queue" ? "review_queue"
        : "discarded";
    }

    // Push to GSC if auto_push
    let gscLeadId: string | null = null;
    if (routingDecision === "auto_push") {
      gscLeadId = await pushToGsc(
        sb,
        {
          lead_id: lead.lead_id,
          org_id: lead.org_id,
          name: lead.lead_name,
          email: lead.lead_email,
          phone: lead.lead_phone,
          company: lead.lead_company,
        },
        context,
        totalScore,
        campConfig.outreach_template,
      );
    }

    // Decision log
    await sb.from("lge_decision_logs").insert({
      raw_lead_id: lead.lead_id,
      score_inputs_json: {
        icp,
        enrichment: enrich,
        lead: {
          name: lead.lead_name,
          email: lead.lead_email,
          phone: lead.lead_phone,
          company: lead.lead_company,
        },
      },
      score_outputs_json: {
        fit_score: fitScore,
        base_confidence_score: baseConfidenceScore,
        confidence_score: confidenceScore,
        total_score: totalScore,
        fit_weight: fitWeight,
        confidence_weight: confidenceWeight,
        reliability_modifier: reliabilityModifier,
        reliability_score_used: reliabilityScore,
        signals: {
          domain_adj:       signals.domainAdj,
          completeness_adj: signals.completenessAdj,
          engagement_adj:   signals.engagementAdj,
          source_adj:       signals.sourceAdj,
          recency_adj:      signals.recencyAdj,
          total:            signals.total,
          prior_engagement: priorEngagement,
        },
      },
      routing_decision: routingDecision,
      routing_reason: `total=${totalScore} fit=${fitScore} conf=${confidenceScore}(base=${baseConfidenceScore},rel_mod=${reliabilityModifier}) signals=${signals.total}(dom:${signals.domainAdj},comp:${signals.completenessAdj},eng:${signals.engagementAdj},src:${signals.sourceAdj},rec:${signals.recencyAdj}) phone=${enrich.phone_line_type ?? "unverified"} web=${enrich.website_reachable ?? "n/a"} firmographic=${firmographicSource} mode=${lead.campaign_mode}${hasProviderKeys ? "" : " basic_mode"}${orgPolicyBlock ? ` policy_block=${orgPolicyBlock}` : ""}`,
      model_output_json: context ?? {},
    });

    // Final status update (gsc_handoff_key prevents double-push via unique index)
    const statusUpdate: Record<string, unknown> = {
      status: newStatus,
      locked_by: null,
      locked_until: null,
    };
    if (gscLeadId) {
      statusUpdate.gsc_lead_id = gscLeadId;
      statusUpdate.gsc_handoff_key = `lge:${lead.lead_id}`;
    }

    await sb.from("lge_raw_leads").update(statusUpdate).eq("id", lead.lead_id);
  } catch (e: any) {
    console.error("[lge_worker] lead error", lead.lead_id, e.message);

    const failUpdate: Record<string, unknown> = {
      locked_by: null,
      locked_until: null,
      last_error: e.message ?? "Unknown error",
    };
    // attempt was already incremented by lge_claim_batch
    failUpdate.status = lead.attempt >= lead.max_attempts ? "failed" : "pending";

    await sb.from("lge_raw_leads").update(failUpdate).eq("id", lead.lead_id).then(undefined, () => {});
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const sb = getServiceSupabaseClient();
    const wid = workerId();

    // Claim a batch
    const { data: leads, error: claimErr } = await sb.rpc("lge_claim_batch", {
      p_worker_id: wid,
      p_batch_size: BATCH_SIZE,
      p_lock_minutes: LOCK_MINUTES,
    });

    if (claimErr) {
      console.error("[lge_worker] claim error:", claimErr.message);
      return new Response(JSON.stringify({ error: claimErr.message }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const batch = (leads ?? []) as ClaimedLead[];
    if (batch.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const orgKeyCache        = new Map<string, OrgKeys>();
    const sourceAdjCache     = new Map<string, SourceAdjMap>();
    const campaignConfigCache = new Map<string, CampaignConfig>();
    await runPool(batch, CONCURRENCY, (lead) => processLead(lead, sb, orgKeyCache, sourceAdjCache, campaignConfigCache));

    return new Response(JSON.stringify({ ok: true, processed: batch.length, worker: wid }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[lge_worker] unhandled:", e.message);
    return new Response(JSON.stringify({ error: e.message ?? "Internal error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
