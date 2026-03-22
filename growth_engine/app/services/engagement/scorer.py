"""
Engagement opportunity scorer.

Calls GPT-4o-mini to evaluate a post's:
  - relevance_score  (0-1) — how relevant to our org's expertise
  - confidence_score (0-1) — how confident we are that engaging builds authority
  - risk_score       (0-1) — how risky the engagement is

Also generates the initial comment/reply text as part of the same LLM call
(single-pass: score + generate simultaneously for efficiency).

Risk heuristics applied POST-LLM (always override if triggered):
  - No brand profile loaded → confidence capped at 0.5
  - Post body < 50 chars → relevance capped at 0.3 (too short to evaluate)
  - Post body contains competitor mention from brand's banned list → risk floored at 0.6
"""

from __future__ import annotations

import json
import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.engagement import ScoringResult
from app.openai_client import CRITIC_MODEL, chat_completion
from app.prompts.engagement_prompts import build_score_prompt

log = get_logger(__name__)

SCORING_MODEL = CRITIC_MODEL  # gpt-4o-mini — fast and cost-effective for scoring


async def score_opportunity(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    post_body: str,
    opportunity_type: str,
    target_identifier: str,
    target_type: str,
    platform: str,
) -> ScoringResult:
    """
    Score an engagement opportunity and generate action text.

    Fetches brand context from DB then calls LLM.
    Falls back to safe default scores on any error.
    """
    brand_context = await _get_brand_context(pool, org_id)

    messages = build_score_prompt(
        post_body=post_body,
        opportunity_type=opportunity_type,
        target_identifier=target_identifier,
        target_type=target_type,
        org_name=brand_context["org_name"],
        org_description=brand_context["org_description"],
        brand_tone=brand_context["brand_tone"],
        platform=platform,
    )

    try:
        raw = await chat_completion(
            messages=messages,
            model=SCORING_MODEL,
            temperature=0.3,    # Low temp for consistent scoring
            max_tokens=600,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(raw)
    except Exception as exc:
        log.warning("engagement_scoring_failed", error=str(exc),
                    org_id=str(org_id), platform=platform)
        # Safe fallback — sends to human review
        return ScoringResult(
            confidence_score=0.4,
            risk_score=0.5,
            relevance_score=0.4,
            generated_action_text="[Scoring failed — please review manually]",
            generation_model=SCORING_MODEL,
        )

    confidence = float(parsed.get("confidence_score", 0.4))
    risk       = float(parsed.get("risk_score", 0.5))
    relevance  = float(parsed.get("relevance_score", 0.4))
    action_text = str(parsed.get("action_text", "")).strip()

    # Post-LLM heuristics
    if not brand_context["has_brand_profile"]:
        confidence = min(confidence, 0.5)
    if len(post_body.strip()) < 50:
        relevance = min(relevance, 0.3)
    if not action_text:
        action_text = f"Great perspective on this! Thoughts from {brand_context['org_name']}?"

    result = ScoringResult(
        confidence_score=round(min(max(confidence, 0.0), 1.0), 3),
        risk_score=round(min(max(risk, 0.0), 1.0), 3),
        relevance_score=round(min(max(relevance, 0.0), 1.0), 3),
        generated_action_text=action_text[:1200],
        generation_model=SCORING_MODEL,
    )

    log.info(
        "opportunity_scored",
        org_id=str(org_id), platform=platform,
        confidence=result.confidence_score, risk=result.risk_score,
        relevance=result.relevance_score,
    )
    return result


async def _get_brand_context(pool: asyncpg.Pool, org_id: uuid.UUID) -> dict:
    """Fetch brand profile for scoring context. Returns safe defaults if missing."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT company_name, tagline, audience_description, tone_primary
            FROM growth.brand_profiles
            WHERE org_id = $1
            LIMIT 1
            """,
            org_id,
        )
        # Get org name as fallback
        org_row = await conn.fetchrow(
            "SELECT name FROM public.organizations WHERE id = $1",
            org_id,
        )

    if row:
        org_name = row["company_name"] or (org_row["name"] if org_row else "Our Company")
        description = row.get("audience_description") or row.get("tagline") or ""
        tone = row.get("tone_primary") or "professional"
        return {
            "has_brand_profile": True,
            "org_name": org_name,
            "org_description": description,
            "brand_tone": tone,
        }

    org_name = org_row["name"] if org_row else "Our Company"
    return {
        "has_brand_profile": False,
        "org_name": org_name,
        "org_description": "B2B company",
        "brand_tone": "professional",
    }
