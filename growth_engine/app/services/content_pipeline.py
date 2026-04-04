"""
Content pipeline orchestrator.

Executes the full mandatory pipeline for a single content piece:

  Brand Context
    → Angle Generator        (pick best angle for topic)
    → Hook Tournament        (12 candidates → top hook)
    → Draft Writer           (first draft from full brief)
    → Critic (attempt 1)     (quality gate — approve or revise)
    → Rewriter (if revise)   (targeted fix, preserves hook/angle)
    → Critic (attempt 2)     (final gate)
    → Save                   (variant + piece + lineage columns)

Rules (locked):
  - No draft is saved to DB without passing through the critic at least once
  - Max 2 critic attempts; 3rd save is best-effort with critic_decision='revise'
  - Hook is NEVER modified after tournament — writer receives it as-is
  - original_body_text on the variant = the first writer output (unmodified)
  - Each platform variant for the same idea = separate pipeline invocation
  - Quota is checked BEFORE pipeline starts (caller's responsibility)
  - Quota is NOT refunded on failure — the generation attempt consumed resources

Entry points:
  run_pipeline_for_idea()   — generate all enabled-platform variants for an idea
  run_pipeline_for_variant() — generate one variant for a specific platform

Called by:
  - Worker jobs (async background)
  - API route POST /growth/ideas/{id}/generate (immediate, small n)
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Literal, Optional

import asyncpg

from app.config import settings
from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.services.angle_generator import AngleResult, generate_angle
from app.services.approval_engine import get_posting_mode, handle_pipeline_completion
from app.services.critic import CriticResult, run_critic
from app.services.hook_generator import HookResult, get_all_hooks_json, run_hook_tournament
from app.services.rewriter import rewrite_draft
from app.services.writer import write_draft

log = get_logger(__name__)

MAX_CRITIC_ATTEMPTS = 2

VariantStatus = Literal["draft", "approved", "needs_review"]


@dataclass
class PipelineResult:
    idea_id: uuid.UUID
    platform: str
    variant_id: Optional[uuid.UUID]
    status: VariantStatus
    critic_decision: Optional[str]
    generation_attempts: int
    angle_type: str
    angle_title: str
    hook_text: str
    hook_score: float
    error: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        return self.variant_id is not None


async def run_pipeline_for_idea(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    idea_id: uuid.UUID,
    prompt_version: str = "v1",
) -> list[PipelineResult]:
    """
    Run the full pipeline for all enabled platforms for a content idea.
    Returns one PipelineResult per platform attempted.
    """
    idea = await _fetch_idea(pool, org_id, idea_id)
    if not idea:
        log.error("pipeline_idea_not_found", idea_id=str(idea_id))
        return []

    # Fetch posting_mode once per idea (same for all platforms)
    posting_mode = await get_posting_mode(pool, org_id)

    platforms = settings.enabled_platforms()
    results = []

    for platform in platforms:
        result = await run_pipeline_for_variant(
            pool=pool,
            org_id=org_id,
            brand=brand,
            idea_id=idea_id,
            platform=platform,
            topic=idea["topic"],
            pillar=idea["pillar"],
            hook_seed=idea["hook_seed"] or idea["topic"],
            prompt_version=prompt_version,
            posting_mode=posting_mode,
        )
        results.append(result)

    # Update idea status based on results
    any_approved = any(r.status in ("approved", "queued") for r in results)
    all_failed = all(not r.succeeded for r in results)
    new_status = "ready" if any_approved else ("failed" if all_failed else "needs_review")
    await _update_idea_status(pool, idea_id, new_status)

    return results


async def run_pipeline_for_variant(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    idea_id: uuid.UUID,
    platform: str,
    topic: str,
    pillar: str,
    hook_seed: str,
    prompt_version: str = "v1",
    posting_mode: Optional[str] = None,
) -> PipelineResult:
    """
    Run the full pipeline for a single platform variant.
    """
    log.info(
        "pipeline_started",
        org_id=str(org_id),
        idea_id=str(idea_id),
        platform=platform,
        topic=topic[:60],
    )

    # ── Step 1: Angle ──────────────────────────────────────────────────────────
    angle = await generate_angle(
        pool=pool,
        org_id=org_id,
        brand=brand,
        topic=topic,
        hook_seed=hook_seed,
        pillar=pillar,
    )
    if not angle:
        return _error_result(idea_id, platform, "angle_generator_failed")

    # ── Step 2: Hook Tournament ────────────────────────────────────────────────
    hook = await run_hook_tournament(
        brand=brand,
        topic=topic,
        angle_title=angle.angle_title,
        core_claim=angle.core_claim,
        platform=platform,
    )
    if not hook:
        return _error_result(idea_id, platform, "hook_tournament_failed", angle=angle)

    # Store all hook candidates on the idea for analysis
    await _save_hook_candidates(pool, idea_id, hook, platform)

    # ── Step 3: Writer (first draft) ───────────────────────────────────────────
    draft = await write_draft(
        pool=pool,
        org_id=org_id,
        brand=brand,
        platform=platform,
        topic=topic,
        pillar=pillar,
        angle_title=angle.angle_title,
        angle_type=angle.angle_type,
        core_claim=angle.core_claim,
        hook_text=hook.hook_text,
    )
    if not draft:
        return _error_result(idea_id, platform, "writer_failed", angle=angle, hook=hook)

    original_body_text = draft   # preserved regardless of rewrites

    # ── Steps 4–5: Critic + Rewrite Loop ──────────────────────────────────────
    current_text = draft
    last_critic: Optional[CriticResult] = None
    attempt = 0

    for attempt in range(1, MAX_CRITIC_ATTEMPTS + 1):
        critic_result = await run_critic(
            brand=brand,
            platform=platform,
            draft_text=current_text,
        )
        last_critic = critic_result

        if critic_result.passed:
            log.info(
                "pipeline_critic_approved",
                idea_id=str(idea_id),
                platform=platform,
                attempt=attempt,
            )
            break

        # Did not pass — rewrite if we have attempts left
        if attempt < MAX_CRITIC_ATTEMPTS:
            log.info(
                "pipeline_critic_revise",
                idea_id=str(idea_id),
                platform=platform,
                attempt=attempt,
                failed=critic_result.failed_thresholds,
            )
            rewritten = await rewrite_draft(
                brand=brand,
                platform=platform,
                original_draft=current_text,
                revision_brief=critic_result.revision_brief or "Improve quality.",
                weaknesses=critic_result.weaknesses,
                generic_phrases=critic_result.generic_phrases_found,
                angle_title=angle.angle_title,
                hook_text=hook.hook_text,
            )
            if rewritten:
                current_text = rewritten
            # If rewriter failed, keep current_text and let critic run again
        else:
            log.warning(
                "pipeline_max_attempts_reached",
                idea_id=str(idea_id),
                platform=platform,
                failed=critic_result.failed_thresholds,
            )

    # ── Step 6: Save variant ───────────────────────────────────────────────────
    final_text = current_text
    critic_passed = last_critic is not None and last_critic.passed
    critic_decision = "approve" if critic_passed else "revise"

    # suggestion_only → always save as 'draft'; other modes follow critic result
    if posting_mode is None:
        posting_mode = await get_posting_mode(pool, org_id)

    if posting_mode == "suggestion_only":
        save_status = "draft"
    else:
        save_status = "approved" if critic_passed else "draft"

    variant_id = await _save_variant(
        pool=pool,
        org_id=org_id,
        idea_id=idea_id,
        platform=platform,
        body_text=final_text,
        original_body_text=original_body_text,
        angle=angle,
        hook=hook,
        critic_result=last_critic,
        critic_decision=critic_decision,
        save_status=save_status,
        generation_attempt=attempt,
        prompt_version=prompt_version,
    )

    # ── Decision attribution ──────────────────────────────────────────────────
    from app.services.decision_logger import log_content_generated
    await log_content_generated(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        platform=platform,
        angle_type=angle.angle_type,
        hook_score=hook.total_score,
        critic_decision=critic_decision,
        generation_attempts=attempt,
        posting_mode=posting_mode,
    )

    log.info(
        "pipeline_completed",
        org_id=str(org_id),
        idea_id=str(idea_id),
        platform=platform,
        variant_id=str(variant_id),
        critic_decision=critic_decision,
        posting_mode=posting_mode,
        attempts=attempt,
    )

    # ── Step 7: Mode-aware post-pipeline action ────────────────────────────────
    await handle_pipeline_completion(
        pool=pool,
        org_id=org_id,
        variant_id=variant_id,
        critic_passed=critic_passed,
        platform=platform,
        posting_mode=posting_mode,
    )

    return PipelineResult(
        idea_id=idea_id,
        platform=platform,
        variant_id=variant_id,
        status=save_status,
        critic_decision=critic_decision,
        generation_attempts=attempt,
        angle_type=angle.angle_type,
        angle_title=angle.angle_title,
        hook_text=hook.hook_text,
        hook_score=hook.total_score,
    )


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def _fetch_idea(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    idea_id: uuid.UUID,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, topic, pillar, angle, hook_seed, score,
                   authority_ladder_id, ladder_level
            FROM growth.content_ideas
            WHERE id = $1 AND org_id = $2
            """,
            idea_id,
            org_id,
        )
    return dict(row) if row else None


_PLATFORM_FORMAT = {
    "linkedin":  "post",
    "facebook":  "post",
    "instagram": "image_caption",
    "x":         "post",
}


async def _save_variant(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    idea_id: uuid.UUID,
    platform: str,
    body_text: str,
    original_body_text: str,
    angle: AngleResult,
    hook: HookResult,
    critic_result: Optional[CriticResult],
    critic_decision: str,
    save_status: str,
    generation_attempt: int,
    prompt_version: str,
) -> uuid.UUID:
    """
    Insert variant with full lineage columns. Returns variant ID.
    save_status is determined by the caller (mode-aware).
    """
    critic_scores_json = None
    revision_brief = None
    if critic_result:
        critic_scores_json = json.dumps(critic_result.scores)
        revision_brief = critic_result.revision_brief

    fmt = _PLATFORM_FORMAT.get(platform, "post")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.content_variants (
                org_id, idea_id, platform, status, format,
                body_text, original_body_text,
                angle_type, angle_title, core_claim,
                hook_text, hook_rank,
                prompt_version, generation_attempt,
                critic_decision, critic_scores_json, revision_brief,
                is_user_edited
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7,
                $8, $9, $10,
                $11, $12,
                $13, $14,
                $15, $16::jsonb, $17,
                false
            )
            RETURNING id
            """,
            org_id,
            idea_id,
            platform,
            save_status,
            fmt,
            body_text,
            original_body_text,
            angle.angle_type,
            angle.angle_title,
            angle.core_claim,
            hook.hook_text,
            hook.rank,
            prompt_version,
            generation_attempt,
            critic_decision,
            critic_scores_json,
            revision_brief,
        )
    return row["id"]


async def _save_hook_candidates(
    pool: asyncpg.Pool,
    idea_id: uuid.UUID,
    hook_winner: HookResult,
    platform: str,
) -> None:
    """
    Update the idea row with hook_candidates_json if not already set.
    We do not overwrite existing candidates (first platform wins for the idea).
    """
    # Only the hook winner is available here — full tournament list is not
    # returned from run_hook_tournament(). We store what we have.
    candidates = [{
        "rank": hook_winner.rank,
        "hook": hook_winner.hook_text,
        "style": hook_winner.style,
        "total_score": hook_winner.total_score,
        "platform": platform,
    }]
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.content_ideas
            SET hook_candidates_json = COALESCE(
                hook_candidates_json,
                $1::jsonb
            )
            WHERE id = $2
            """,
            json.dumps(candidates),
            idea_id,
        )


async def _update_idea_status(
    pool: asyncpg.Pool,
    idea_id: uuid.UUID,
    status: str,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE growth.content_ideas SET status = $1 WHERE id = $2",
            status,
            idea_id,
        )


def _error_result(
    idea_id: uuid.UUID,
    platform: str,
    error: str,
    angle: Optional[AngleResult] = None,
    hook: Optional[HookResult] = None,
) -> PipelineResult:
    return PipelineResult(
        idea_id=idea_id,
        platform=platform,
        variant_id=None,
        status="needs_review",
        critic_decision=None,
        generation_attempts=0,
        angle_type=angle.angle_type if angle else "",
        angle_title=angle.angle_title if angle else "",
        hook_text=hook.hook_text if hook else "",
        hook_score=hook.total_score if hook else 0.0,
        error=error,
    )
