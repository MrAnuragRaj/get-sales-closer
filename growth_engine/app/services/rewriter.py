"""
Rewriter service.

Called only when the critic returns decision='revise'.
The rewriter fixes exactly what was flagged — it does NOT rewrite from scratch.
It preserves: hook, angle, overall structure.
It fixes: flagged weaknesses, generic phrases, operator voice failures.

Max 2 rewrite attempts per draft. If the critic still returns 'revise' after
2 attempts, the variant is saved with critic_decision='revise' and the best
attempt is stored. The pipeline does not produce garbage — it produces the best
attempt the system could make, transparently marked as needing human review.

Pipeline caller (content_pipeline.py) controls retry logic and attempt counting.
"""

from __future__ import annotations

from typing import Optional

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import WRITER_MODEL, chat_completion
from app.prompts.critic_prompts import build_rewriter_prompt, build_rewriter_system_prompt

log = get_logger(__name__)


async def rewrite_draft(
    brand: BrandProfileOut,
    platform: str,
    original_draft: str,
    revision_brief: str,
    weaknesses: list[str],
    generic_phrases: list[str],
    angle_title: str,
    hook_text: str,
) -> Optional[str]:
    """
    Rewrite the draft based on targeted critic feedback.

    Returns the rewritten text, or None on empty response.
    The caller decides whether to run the critic again on the result.
    """
    tone_desc = _extract_str(brand.tone_json, "description", "direct and authoritative")

    prompt = build_rewriter_prompt(
        original_draft=original_draft,
        revision_brief=revision_brief,
        weaknesses=weaknesses,
        generic_phrases=generic_phrases,
        platform=platform,
        angle_title=angle_title,
        hook_text=hook_text,
        brand_tone=tone_desc,
    )

    log.info(
        "rewriter_started",
        platform=platform,
        brief=revision_brief[:80],
        generic_count=len(generic_phrases),
    )

    rewritten = await chat_completion(
        messages=[
            {"role": "system", "content": build_rewriter_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=WRITER_MODEL,
        temperature=0.65,   # slightly lower than writer — targeted fixes, not exploration
        max_tokens=600,
    )

    if not rewritten or not rewritten.strip():
        log.error("rewriter_empty_response", platform=platform)
        return None

    result = rewritten.strip()
    log.info("rewriter_completed", platform=platform, result_length=len(result))
    return result


def _extract_str(json_blob: Optional[dict], key: str, default: str = "") -> str:
    if not json_blob:
        return default
    return str(json_blob.get(key, default))
