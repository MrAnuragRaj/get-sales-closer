"""
Draft writer service.

Writes the first draft of a platform-native post from a fully specified brief:
  - topic + pillar (from planner)
  - angle_type + angle_title + core_claim (from angle generator)
  - hook_text (tournament winner — immutable, do not modify)
  - platform-specific formatting rules
  - brand tone + audience + forbidden phrases
  - recent content summary (content memory — prevent repetition)

The draft is NOT the final post. It is the input to the mandatory critic loop.
The writer does not know whether its output passes or fails — that is the critic's job.

X thread format:
  Single post if content fits (default). Thread if explicitly requested.
  X is config-inactive in v1 (PLATFORM_X_ENABLED=false).
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import WRITER_MODEL, chat_completion
from app.prompts.writer_prompts import build_writer_prompt, build_writer_system_prompt
from app.services import content_memory
from app.services.cliche_detector import get_banned_phrases

log = get_logger(__name__)


async def write_draft(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    platform: str,
    topic: str,
    pillar: str,
    angle_title: str,
    angle_type: str,
    core_claim: str,
    hook_text: str,
) -> Optional[str]:
    """
    Generate a first draft for the given platform and brief.

    Returns the raw draft text, or None on failure.
    The draft is not saved to DB — the caller (content_pipeline) handles persistence.
    """
    tone_desc   = _extract_str(brand.tone_json, "description", "direct and authoritative")
    audience    = _extract_str(brand.audience_json, "description", "B2B decision makers")
    cta_instr   = _extract_str(brand.cta_rules_json, "instruction", None)

    # Forbidden phrases = hard-ban list + brand-specific forbidden claims
    forbidden = get_banned_phrases()
    brand_forbidden = _extract_list(brand.forbidden_claims_json, "claims")
    forbidden = forbidden + brand_forbidden

    recent_summary = await content_memory.get_recent_content_summary(
        pool, org_id, platform
    )

    prompt = build_writer_prompt(
        platform=platform,
        topic=topic,
        angle_title=angle_title,
        core_claim=core_claim,
        hook_text=hook_text,
        brand_name=brand.brand_name,
        brand_tone=tone_desc,
        audience_description=audience,
        cta_instruction=cta_instr if cta_instr else None,
        forbidden_phrases=forbidden[:20],   # cap at 20 to avoid token bloat
        recent_content_summary=recent_summary,
    )

    log.info(
        "writer_draft_started",
        org_id=str(org_id),
        platform=platform,
        angle_type=angle_type,
        topic=topic[:60],
    )

    draft = await chat_completion(
        messages=[
            {"role": "system", "content": build_writer_system_prompt(platform)},
            {"role": "user",   "content": prompt},
        ],
        model=WRITER_MODEL,
        temperature=0.75,
        max_tokens=900,
    )

    if not draft or not draft.strip():
        log.error("writer_empty_response", org_id=str(org_id), platform=platform)
        return None

    log.info(
        "writer_draft_completed",
        org_id=str(org_id),
        platform=platform,
        draft_length=len(draft),
    )
    return draft.strip()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_str(json_blob: Optional[dict], key: str, default=None) -> Optional[str]:
    if not json_blob:
        return default
    val = json_blob.get(key, default)
    return str(val) if val is not None else default


def _extract_list(json_blob: Optional[dict], key: str) -> list[str]:
    if not json_blob:
        return []
    value = json_blob.get(key, [])
    if isinstance(value, list):
        return [str(v) for v in value]
    return []
