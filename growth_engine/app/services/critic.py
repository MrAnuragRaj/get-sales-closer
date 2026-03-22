"""
Critic service — mandatory quality gate.

Every draft passes through the critic before being saved.
There is no path from writer output to DB that bypasses this gate.

The critic:
  1. Runs cliché pre-detection (cheap, fast, catches obvious failures first)
  2. Calls LLM critic with detected clichés injected into the prompt
  3. Parses JSON response — scores + decision + optional revision_brief
  4. Returns CriticResult regardless of approve/revise decision
     (the pipeline decides whether to rewrite or persist based on decision)

Thresholds are locked — do not modify without updating critic.md.
See critic_prompts.CRITIC_THRESHOLDS for exact values.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Literal, Optional

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import CRITIC_MODEL, chat_completion
from app.prompts.critic_prompts import (
    CRITIC_THRESHOLDS,
    MINIMUM_INSIGHT_COUNT,
    build_critic_prompt,
    build_critic_system_prompt,
)
from app.services.cliche_detector import detect_cliches

log = get_logger(__name__)

CriticDecision = Literal["approve", "revise"]


@dataclass
class CriticResult:
    decision: CriticDecision
    scores: dict[str, int]
    insight_count: int
    operator_voice: str
    weaknesses: list[str]
    generic_phrases_found: list[str]
    revision_brief: Optional[str]
    # Pre-detected clichés (before LLM even ran)
    predetected_cliches: list[str] = field(default_factory=list)
    # Which thresholds failed (empty if approve)
    failed_thresholds: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.decision == "approve"


async def run_critic(
    brand: BrandProfileOut,
    platform: str,
    draft_text: str,
) -> CriticResult:
    """
    Run the full critic pipeline on a draft.

    Always returns a CriticResult — never raises on model parse failure
    (returns a synthetic 'revise' result with a generic brief so the pipeline
    can attempt a rewrite rather than silently dropping content).
    """
    # Stage 1: cliché pre-detection (pure string matching, near-zero cost)
    predetected = detect_cliches(draft_text)
    if predetected:
        log.info(
            "critic_cliches_predetected",
            platform=platform,
            count=len(predetected),
            phrases=predetected[:5],
        )

    # Stage 2: LLM critic
    prompt = build_critic_prompt(
        post_text=draft_text,
        platform=platform,
        brand_name=brand.brand_name,
        cliches_detected=predetected,
    )

    log.info("critic_started", platform=platform, draft_length=len(draft_text))

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_critic_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=CRITIC_MODEL,
        temperature=0.1,   # near-deterministic — critic should be consistent
        max_tokens=800,
    )

    result = _parse_critic_response(raw, predetected)
    log.info(
        "critic_completed",
        platform=platform,
        decision=result.decision,
        scores=result.scores,
        failed=result.failed_thresholds,
    )
    return result


# ── Parsing ────────────────────────────────────────────────────────────────────

def _parse_critic_response(raw: str, predetected: list[str]) -> CriticResult:
    """
    Parse LLM critic JSON. On any parse failure, return a synthetic 'revise'
    result so the rewriter can attempt a fix rather than silently failing.
    """
    raw = raw.strip()
    # Strip markdown code fences if model added them
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("critic_json_parse_failed", raw=raw[:200])
        return CriticResult(
            decision="revise",
            scores={},
            insight_count=0,
            operator_voice="unknown",
            weaknesses=["Critic could not parse response"],
            generic_phrases_found=predetected,
            revision_brief="The post requires review — make the writing more specific, concrete, and operator-voiced.",
            predetected_cliches=predetected,
            failed_thresholds=["parse_error"],
        )

    scores = data.get("scores", {})
    insight_count = int(data.get("insight_count", 0))
    operator_voice = str(data.get("operator_voice", "marketing_intern"))
    weaknesses = data.get("weaknesses", [])
    generic_phrases = data.get("generic_phrases_found", []) + predetected
    # Deduplicate
    generic_phrases = list(dict.fromkeys(generic_phrases))
    decision_raw = str(data.get("decision", "revise")).lower()
    revision_brief = data.get("revision_brief")

    # Determine which thresholds failed
    failed: list[str] = []
    for dim, min_score in CRITIC_THRESHOLDS.items():
        actual = scores.get(dim)
        if actual is None or int(actual) < min_score:
            failed.append(f"{dim}<{min_score}")

    if insight_count < MINIMUM_INSIGHT_COUNT:
        failed.append(f"insight_count<{MINIMUM_INSIGHT_COUNT}")

    if operator_voice != "founder":
        failed.append("operator_voice!=founder")

    # Decision is final — we trust the model but also enforce our own logic:
    # if the model says 'approve' but thresholds failed, we override to 'revise'
    if failed:
        decision: CriticDecision = "revise"
        if not revision_brief:
            revision_brief = _synthesise_revision_brief(failed, weaknesses)
    elif decision_raw == "approve":
        decision = "approve"
    else:
        decision = "revise"

    return CriticResult(
        decision=decision,
        scores={k: int(v) for k, v in scores.items() if isinstance(v, (int, float))},
        insight_count=insight_count,
        operator_voice=operator_voice,
        weaknesses=weaknesses if isinstance(weaknesses, list) else [],
        generic_phrases_found=generic_phrases,
        revision_brief=revision_brief if decision == "revise" else None,
        predetected_cliches=predetected,
        failed_thresholds=failed,
    )


def _synthesise_revision_brief(failed: list[str], weaknesses: list[str]) -> str:
    """
    Construct a fallback revision brief when the model omits one.
    Targets the first 2 failed dimensions.
    """
    parts = []
    for f in failed[:2]:
        dim = f.split("<")[0].split("!")[0]
        if dim == "clarity":
            parts.append("Make the main point immediately clear in the first 2 lines")
        elif dim == "specificity":
            parts.append("Replace vague claims with a concrete number, example, or case")
        elif dim == "novelty":
            parts.append("Offer a perspective the audience has not heard before")
        elif dim == "non_genericness":
            parts.append("Remove all AI/SaaS clichés and rewrite in plain operator language")
        elif dim == "commercial_relevance":
            parts.append("Connect the insight directly to a business outcome or revenue impact")
        elif dim == "operator_voice!=founder":
            parts.append("Rewrite to sound like a founder who has done the work, not a content marketer")
        elif dim == "insight_count":
            parts.append("Add at least one more distinct, non-redundant insight")
        else:
            parts.append(weaknesses[0] if weaknesses else "Improve content quality")

    return ". ".join(parts) + "."
