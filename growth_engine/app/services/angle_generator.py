"""
Angle generator service.

Generates 3 candidate angles for a content idea, then returns the top-ranked
one (priority 1) for the hook tournament. The angle is the specific perspective
applied to the topic — same topic, different angles = completely different posts.

Output feeds directly into hook_generator.py.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import PLANNER_MODEL, chat_completion
from app.prompts.angle_prompts import (
    build_angle_generator_prompt,
    build_angle_system_prompt,
)
from app.services import content_memory

log = get_logger(__name__)


@dataclass
class AngleResult:
    angle_type: str
    angle_title: str
    core_claim: str
    recommended_priority: int
    rationale: str


async def generate_angle(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    topic: str,
    hook_seed: str,
    pillar: str,
) -> Optional[AngleResult]:
    """
    Generate 3 candidate angles for the given topic and return the top-ranked one.

    Returns None on parse failure (caller should abort pipeline run for this idea).
    """
    audience_desc = _extract_str(brand.audience_json, "description", "B2B decision makers")
    brand_summary = brand.brand_summary or brand.positioning or brand.brand_name

    recent_angles = await content_memory.get_recent_angles(pool, org_id)

    prompt = build_angle_generator_prompt(
        topic=topic,
        hook_seed=hook_seed,
        brand_name=brand.brand_name,
        brand_summary=brand_summary,
        content_pillar=pillar,
        audience_description=audience_desc,
        recent_angles=recent_angles,
    )

    log.info("angle_generator_started", org_id=str(org_id), topic=topic[:80])

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_angle_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=PLANNER_MODEL,
        temperature=0.75,
        max_tokens=800,
    )

    angles = _parse_angles(raw)
    if not angles:
        log.error("angle_generator_parse_failed", org_id=str(org_id), raw=raw[:200])
        return None

    # Return priority 1 (already sorted by recommended_priority in prompt)
    top = min(angles, key=lambda a: a.recommended_priority)
    log.info(
        "angle_generator_completed",
        org_id=str(org_id),
        angle_type=top.angle_type,
        priority=top.recommended_priority,
    )
    return top


# ── Parsing ────────────────────────────────────────────────────────────────────

def _parse_angles(raw: str) -> list[AngleResult]:
    """Parse GPT response into AngleResult list. Handles array or wrapped object."""
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
        data = data.get("angles", list(data.values())[0] if data else [])

    if not isinstance(data, list):
        return []

    results = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            results.append(AngleResult(
                angle_type=str(item.get("angle_type", "operational")),
                angle_title=str(item.get("angle_title", "")),
                core_claim=str(item.get("core_claim", "")),
                recommended_priority=int(item.get("recommended_priority", 3)),
                rationale=str(item.get("rationale", "")),
            ))
        except (TypeError, ValueError):
            continue

    return results


def _extract_str(json_blob: Optional[dict], key: str, default: str = "") -> str:
    if not json_blob:
        return default
    return str(json_blob.get(key, default))
