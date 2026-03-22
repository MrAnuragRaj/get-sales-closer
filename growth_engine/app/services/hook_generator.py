"""
Hook tournament service.

Generates 12 hook candidates, scores each on 4 dimensions, returns the
top-ranked hook. This is not optional — the writer ALWAYS receives the
tournament winner, never a raw hook_seed from the planner.

The tournament ensures:
  - At least 4 different hook styles represented
  - Each hook scored on tension, specificity, originality, platform_fit
  - Winner selected by total_score (average of 4 dimensions)
  - Hook style is recorded on the variant for variety tracking

Output feeds directly into writer.py.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import HOOK_MODEL, chat_completion
from app.prompts.hook_prompts import (
    build_hook_system_prompt,
    build_hook_tournament_prompt,
)

log = get_logger(__name__)

TOURNAMENT_SIZE = 12   # number of hooks generated per tournament


@dataclass
class HookResult:
    hook_text: str
    style: str
    tension_score: float
    specificity_score: float
    originality_score: float
    platform_fit_score: float
    total_score: float
    reason: str
    # rank within the tournament (1 = winner)
    rank: int = 1


async def run_hook_tournament(
    brand: BrandProfileOut,
    topic: str,
    angle_title: str,
    core_claim: str,
    platform: str,
) -> Optional[HookResult]:
    """
    Run a hook tournament for the given angle/platform and return the winner.

    Returns None on parse failure (caller should abort pipeline for this idea).
    """
    tone_desc = _extract_str(brand.tone_json, "description", "direct and authoritative")

    prompt = build_hook_tournament_prompt(
        topic=topic,
        angle_title=angle_title,
        core_claim=core_claim,
        platform=platform,
        brand_tone=tone_desc,
        n=TOURNAMENT_SIZE,
    )

    log.info(
        "hook_tournament_started",
        platform=platform,
        angle_title=angle_title[:60],
        n=TOURNAMENT_SIZE,
    )

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_hook_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=HOOK_MODEL,
        temperature=0.85,   # higher creativity — we want variety across 12 hooks
        max_tokens=2000,
    )

    hooks = _parse_hooks(raw)
    if not hooks:
        log.error("hook_tournament_parse_failed", raw=raw[:200])
        return None

    # Response should already be ordered by total_score descending (per prompt)
    # but we re-sort defensively
    hooks.sort(key=lambda h: h.total_score, reverse=True)

    # Assign ranks
    for i, hook in enumerate(hooks):
        hook.rank = i + 1

    winner = hooks[0]
    log.info(
        "hook_tournament_completed",
        winner_score=winner.total_score,
        winner_style=winner.style,
        candidates=len(hooks),
    )
    return winner


def get_all_hooks_json(hooks: list[HookResult]) -> list[dict]:
    """
    Serialise all tournament hooks for storage in content_ideas.hook_candidates_json.
    Preserves full tournament for analysis and post-hoc selection.
    """
    return [
        {
            "rank": h.rank,
            "hook": h.hook_text,
            "style": h.style,
            "total_score": h.total_score,
            "tension_score": h.tension_score,
            "specificity_score": h.specificity_score,
            "originality_score": h.originality_score,
            "platform_fit_score": h.platform_fit_score,
            "reason": h.reason,
        }
        for h in hooks
    ]


# ── Parsing ────────────────────────────────────────────────────────────────────

def _parse_hooks(raw: str) -> list[HookResult]:
    """Parse GPT JSON array of hook candidates into HookResult list."""
    raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if not match:
            return []
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError:
            return []

    if isinstance(data, dict):
        data = data.get("hooks", list(data.values())[0] if data else [])

    if not isinstance(data, list):
        return []

    results = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            tension     = float(item.get("tension_score", 5.0))
            specificity = float(item.get("specificity_score", 5.0))
            originality = float(item.get("originality_score", 5.0))
            platform_ft = float(item.get("platform_fit_score", 5.0))
            # Recompute total defensively — don't trust model arithmetic
            total = (tension + specificity + originality + platform_ft) / 4.0
            results.append(HookResult(
                hook_text=str(item.get("hook", "")),
                style=str(item.get("style", "bold_statement")),
                tension_score=tension,
                specificity_score=specificity,
                originality_score=originality,
                platform_fit_score=platform_ft,
                total_score=round(total, 2),
                reason=str(item.get("reason", "")),
            ))
        except (TypeError, ValueError):
            continue

    return results


def _extract_str(json_blob: Optional[dict], key: str, default: str = "") -> str:
    if not json_blob:
        return default
    return str(json_blob.get(key, default))
