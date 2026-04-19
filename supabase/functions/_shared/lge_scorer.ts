// lge_scorer.ts — Pure scoring functions for LGE
// No I/O — deterministic; takes enrichment data + ICP config, returns scores.
// Phase 4: domain quality, lead completeness, and prior-engagement signals added.

export interface IcpConfig {
  industry?: string[];
  company_size?: string[];
  geography?: string[];
  designations?: string[];
  fit_weight?: number;
  confidence_weight?: number;
}

export interface EnrichmentData {
  industry?: string | null;
  company_size?: string | null;
  designation?: string | null;
  email_verified?: boolean | null;
  phone_line_type?: string | null;  // mobile | landline | voip | invalid | unknown | null (not verified)
  phone_valid?: boolean | null;
  website_reachable?: boolean | null;
}

export interface LeadData {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  designation?: string | null; // from raw_data (title/job_title) when no enrichment
}

// ── Free email provider list ──────────────────────────────────────────────────
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","yahoo.in","yahoo.com.au",
  "hotmail.com","hotmail.co.uk","outlook.com","live.com","msn.com",
  "icloud.com","me.com","mac.com","aol.com","protonmail.com","proton.me",
  "zoho.com","yandex.com","yandex.ru","mail.com","inbox.com","gmx.com","gmx.net",
  "rediffmail.com","sify.com","verizon.net","att.net","comcast.net","sbcglobal.net",
]);

// ── Domain quality adjustment ─────────────────────────────────────────────────
// Business domain = +5 (positive signal — verified professional identity)
// Free provider domain = 0 (neutral — small businesses commonly use personal email)
// No email = 0
export function computeDomainQualityAdj(email?: string | null): number {
  if (!email) return 0;
  const parts = email.toLowerCase().split("@");
  if (parts.length !== 2) return 0;
  const domain = parts[1].trim();
  return FREE_EMAIL_DOMAINS.has(domain) ? 0 : 5;
}

// ── Lead completeness adjustment ──────────────────────────────────────────────
// All 5 key fields present = +5 | 4 fields = +2 | fewer = 0
export function computeCompletenessAdj(lead: LeadData): number {
  const fields = [lead.name, lead.email, lead.phone, lead.company, lead.designation];
  const filled = fields.filter(Boolean).length;
  if (filled >= 5) return 5;
  if (filled >= 4) return 2;
  return 0;
}

// ── Signal adjustments summary ────────────────────────────────────────────────
// Returns all Phase 4 signal adjustments so the worker can log them individually.
export interface SignalAdjustments {
  domainAdj:      number; // -10 | 0 | +5
  completenessAdj: number; // 0 | +2 | +5
  engagementAdj:  number; // 0 | +8 (warm re-engagement)
  sourceAdj:      number; // reliability nudge from lge_source_stats
  recencyAdj:     number; // recency nudge from lge_source_stats
  total:          number; // sum, clamped by computeConfidenceScore
}

export function computeSignalAdjustments(
  lead: LeadData,
  sourceAdj = 0,
  recencyAdj = 0,
  priorEngagement = false,
): SignalAdjustments {
  const domainAdj       = computeDomainQualityAdj(lead.email);
  const completenessAdj = computeCompletenessAdj(lead);
  const engagementAdj   = priorEngagement ? 8 : 0;
  return {
    domainAdj,
    completenessAdj,
    engagementAdj,
    sourceAdj,
    recencyAdj,
    total: domainAdj + completenessAdj + engagementAdj + sourceAdj + recencyAdj,
  };
}

// ── Company size tiers (ordered) ─────────────────────────────────────────────
const SIZE_TIERS = ["1-10", "11-50", "51-200", "201-500", "500+"];

function sizeDistance(a: string, b: string): number {
  const ai = SIZE_TIERS.indexOf(a.trim());
  const bi = SIZE_TIERS.indexOf(b.trim());
  if (ai === -1 || bi === -1) return 99;
  return Math.abs(ai - bi);
}

// Returns true if term fuzzy-matches any entry in list (substring both ways)
function keywordMatch(term: string, list: string[]): boolean {
  if (!list.length) return false;
  const t = term.toLowerCase();
  return list.some((item) => {
    const i = item.toLowerCase();
    return t.includes(i) || i.includes(t);
  });
}

// ── Fit Score (0–100) ────────────────────────────────────────────────────────
// industry 35pts | company_size 30pts | designation 25pts | geography 10pts
// When no ICP constraint on a dimension → full credit (open campaign).
export function computeFitScore(enrich: EnrichmentData, icp: IcpConfig): number {
  let score = 0;

  // Industry: 35pts
  if (!icp.industry?.length) {
    score += 35; // no constraint → full credit
  } else if (enrich.industry && keywordMatch(enrich.industry, icp.industry)) {
    score += 35;
  }

  // Company size: 30pts (adjacent tier = 15pts)
  if (!icp.company_size?.length) {
    score += 30;
  } else if (enrich.company_size) {
    const bestDist = Math.min(...icp.company_size.map((s) => sizeDistance(enrich.company_size!, s)));
    if (bestDist === 0) score += 30;
    else if (bestDist === 1) score += 15;
  }

  // Designation: 25pts
  if (!icp.designations?.length) {
    score += 25;
  } else if (enrich.designation && keywordMatch(enrich.designation, icp.designations)) {
    score += 25;
  }

  // Geography: 10pts
  // lge_enrichment doesn't store geography yet → give full credit when no ICP constraint
  if (!icp.geography?.length) {
    score += 10;
  }
  // When ICP has geography filter but enrichment lacks it → 0pts (can't verify)

  return Math.min(100, Math.max(0, score));
}

// ── Confidence Score (0–100) ─────────────────────────────────────────────────
// Base: email(35/15) + phone(0–20) + company(15) + industry_data(15) + name(15) + website(3) = 103 max → clamped
// Phone is tiered by line_type when AbstractAPI ran:
//   mobile=20 | landline=15 | voip=8 | invalid=0 | other(satellite/toll_free/unknown)=12
//   When phone_line_type is null (verification not run): flat +20 (backward compatible)
// signalTotal: sum of all Phase 4 adjustments (domain, completeness, engagement, source, recency)
//   applied after base, clamped to [0, 100]
export function computeConfidenceScore(
  lead: LeadData,
  enrich: EnrichmentData,
  signalTotal = 0,
): number {
  let score = 0;

  if (lead.email) score += enrich.email_verified ? 35 : 15;

  // Phone: tiered when AbstractAPI verification ran; flat +20 when unverified
  if (lead.phone) {
    if (enrich.phone_line_type != null) {
      switch (enrich.phone_line_type) {
        case "mobile":   score += 20; break;
        case "landline": score += 15; break;
        case "voip":     score += 8;  break;
        case "invalid":  score += 0;  break;
        default:         score += 12; break; // satellite / toll_free / unknown — partial credit
      }
    } else {
      score += 20; // not verified — full credit (no AbstractAPI key configured)
    }
  }

  if (lead.company) score += 15;
  if (enrich.industry) score += 15; // enrichment actually ran and returned industry data
  if (lead.name) score += 15;
  if (enrich.website_reachable === true) score += 3; // company site live — positive signal

  score += signalTotal;
  return Math.min(100, Math.max(0, score));
}

// ── Total Score ──────────────────────────────────────────────────────────────
export function computeTotalScore(
  fitScore: number,
  confidenceScore: number,
  fitWeight = 0.6,
  confidenceWeight = 0.4,
): number {
  return Math.round((fitWeight * fitScore + confidenceWeight * confidenceScore) * 100) / 100;
}

// ── Routing Decision ─────────────────────────────────────────────────────────
export type RoutingDecision = "auto_push" | "review_queue" | "discard";

// autoPushThreshold and reviewThreshold come from lge_campaigns per-campaign config.
// Defaults (80/60) match the original hardcoded values — backward compatible.
export function routeByScore(
  totalScore: number,
  autoPushThreshold = 80,
  reviewThreshold = 60,
): RoutingDecision {
  if (totalScore >= autoPushThreshold) return "auto_push";
  if (totalScore >= reviewThreshold) return "review_queue";
  return "discard";
}
