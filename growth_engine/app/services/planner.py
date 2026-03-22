"""
Topic Planner service.

Generates content idea briefs from brand context.
Ideas are the source of the full pipeline — one idea → one content piece.

Two modes:
  regular        — generates N independent ideas covering all pillars
  authority_ladder — generates one idea for a specific ladder level + theme

Output is saved to growth.content_ideas.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import PLANNER_MODEL, chat_completion
from app.prompts.planner_prompts import (
    build_ladder_planner_prompt,
    build_planner_system_prompt,
    build_regular_planner_prompt,
)
from app.services import content_memory

log = get_logger(__name__)


@dataclass
class IdeaBrief:
    pillar: str
    topic: str
    angle: str
    hook_seed: str
    score: float
    ladder_level: Optional[int] = None
    ladder_level_name: Optional[str] = None


async def run_regular_planner(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    n: int = 10,
    planned_for: Optional[date] = None,
) -> list[uuid.UUID]:
    """
    Generate N content ideas for the org and save them to DB.

    Returns list of created content_idea IDs.
    """
    recent_topics = await content_memory.get_recent_topics(pool, org_id)

    # Build brand context strings from JSONB blobs
    pillars = _extract_list(brand.content_pillars_json, "pillars")
    audience_desc = _extract_str(brand.audience_json, "description", "B2B decision makers")
    tone_desc = _extract_str(brand.tone_json, "description", "direct and authoritative")

    prompt = build_regular_planner_prompt(
        brand_name=brand.brand_name,
        brand_summary=brand.brand_summary or brand.positioning or brand.brand_name,
        content_pillars=pillars,
        audience_description=audience_desc,
        tone_description=tone_desc,
        recent_topics=recent_topics,
        n=n,
    )

    log.info("planner_run_started", org_id=str(org_id), mode="regular", n=n)

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_planner_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=PLANNER_MODEL,
        temperature=0.8,
        max_tokens=2000,
        response_format={"type": "json_object"} if False else None,
        # Note: we ask for a JSON array, which GPT-4o-mini returns cleanly
        # without needing json_object mode (that mode requires object, not array)
    )

    ideas = _parse_ideas_json(raw)
    if not ideas:
        log.error("planner_empty_response", org_id=str(org_id))
        return []

    idea_ids = await _save_ideas(pool, org_id, ideas, planned_for, source="planner_regular")
    log.info("planner_run_completed", org_id=str(org_id), ideas_created=len(idea_ids))
    return idea_ids


async def run_ladder_planner(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    ladder_id: uuid.UUID,
    theme: str,
    ladder_level: int,
    completed_briefs: list[str],
    planned_for: Optional[date] = None,
) -> Optional[uuid.UUID]:
    """
    Generate one content idea for a specific authority ladder level.

    Returns the created content_idea ID, or None on failure.
    """
    tone_desc = _extract_str(brand.tone_json, "description", "direct and authoritative")

    prompt = build_ladder_planner_prompt(
        brand_name=brand.brand_name,
        brand_summary=brand.brand_summary or brand.positioning or brand.brand_name,
        theme=theme,
        ladder_level=ladder_level,
        completed_briefs=completed_briefs,
        tone_description=tone_desc,
    )

    log.info(
        "planner_run_started",
        org_id=str(org_id),
        mode="authority_ladder",
        theme=theme,
        level=ladder_level,
    )

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_planner_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=PLANNER_MODEL,
        temperature=0.7,
        max_tokens=600,
    )

    try:
        brief_data = json.loads(raw.strip())
    except json.JSONDecodeError:
        log.error("planner_ladder_parse_failed", org_id=str(org_id), raw=raw[:200])
        return None

    brief = IdeaBrief(
        pillar=brief_data.get("pillar", "general"),
        topic=brief_data.get("topic", ""),
        angle=brief_data.get("angle", ""),
        hook_seed=brief_data.get("hook_seed", ""),
        score=float(brief_data.get("score", 7.0)),
        ladder_level=brief_data.get("ladder_level", ladder_level),
        ladder_level_name=brief_data.get("ladder_level_name"),
    )

    ids = await _save_ideas(
        pool, org_id, [brief], planned_for, source="planner_ladder",
        ladder_id=ladder_id,
    )
    result = ids[0] if ids else None
    log.info("planner_ladder_completed", org_id=str(org_id), idea_id=str(result))
    return result


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def _save_ideas(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    ideas: list[IdeaBrief],
    planned_for: Optional[date],
    source: str,
    ladder_id: Optional[uuid.UUID] = None,
) -> list[uuid.UUID]:
    ids = []
    async with pool.acquire() as conn:
        for idea in ideas:
            row = await conn.fetchrow(
                """
                INSERT INTO growth.content_ideas (
                    org_id, source, pillar, topic, angle, hook_seed,
                    score, status, planned_for, created_by,
                    authority_ladder_id, ladder_level
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, 'generated', $8, $9,
                    $10, $11
                )
                RETURNING id
                """,
                org_id,
                source,
                idea.pillar,
                idea.topic,
                idea.angle,
                idea.hook_seed,
                idea.score,
                planned_for,
                source,
                ladder_id,
                idea.ladder_level,
            )
            ids.append(row["id"])
    return ids


def _parse_ideas_json(raw: str) -> list[IdeaBrief]:
    """Parse GPT response into IdeaBrief list. Handles array or wrapped object."""
    raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Try extracting JSON array from text
        import re
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if not match:
            return []
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError:
            return []

    # Handle {"ideas": [...]} wrapper
    if isinstance(data, dict):
        data = data.get("ideas", list(data.values())[0] if data else [])

    if not isinstance(data, list):
        return []

    briefs = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            briefs.append(IdeaBrief(
                pillar=str(item.get("pillar", "general")),
                topic=str(item.get("topic", "")),
                angle=str(item.get("angle", "")),
                hook_seed=str(item.get("hook_seed", "")),
                score=float(item.get("score", 7.0)),
            ))
        except (TypeError, ValueError):
            continue

    return briefs


def _extract_list(json_blob: Optional[dict], key: str) -> list[str]:
    """Extract a list of strings from a JSONB blob."""
    if not json_blob:
        return []
    value = json_blob.get(key, [])
    if isinstance(value, list):
        return [str(v) for v in value]
    return []


def _extract_str(json_blob: Optional[dict], key: str, default: str = "") -> str:
    """Extract a string from a JSONB blob."""
    if not json_blob:
        return default
    return str(json_blob.get(key, default))
