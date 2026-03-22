"""
Authority Ladder service.

Manages 7-level content ladders that build a brand's authority on a theme:
  Level 1 — observation         (noticing something)
  Level 2 — pattern_recognition (seeing it repeatedly)
  Level 3 — operational_insight (understanding why)
  Level 4 — framework           (a repeatable model)
  Level 5 — authority_position  (a defined stance)
  Level 6 — evidence            (results proving the stance)
  Level 7 — movement            (inviting others in)

One ladder = one theme. Levels must be published in order.
Each level generates one content idea via run_ladder_planner().

When a level is completed (variant finalized), the ladder advances
by calling advance_ladder_level(). When level 7 completes, the ladder
status becomes 'completed'.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.services.planner import run_ladder_planner

log = get_logger(__name__)

LADDER_MAX_LEVEL = 7

LADDER_LEVEL_NAMES = {
    1: "observation",
    2: "pattern_recognition",
    3: "operational_insight",
    4: "framework",
    5: "authority_position",
    6: "evidence",
    7: "movement",
}


async def create_ladder(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    theme: str,
) -> uuid.UUID:
    """
    Create a new authority ladder for the given theme.
    Returns the new ladder ID.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.authority_ladders (org_id, theme, current_level, status)
            VALUES ($1, $2, 1, 'active')
            RETURNING id
            """,
            org_id,
            theme,
        )
    ladder_id = row["id"]
    log.info("ladder_created", org_id=str(org_id), theme=theme, ladder_id=str(ladder_id))
    return ladder_id


async def get_ladder(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    ladder_id: uuid.UUID,
) -> Optional[dict]:
    """
    Fetch a ladder row. Returns None if not found or belongs to different org.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, theme, current_level, completed_levels, status,
                   created_at, updated_at
            FROM growth.authority_ladders
            WHERE id = $1 AND org_id = $2
            """,
            ladder_id,
            org_id,
        )
    if not row:
        return None
    return dict(row)


async def list_ladders(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> list[dict]:
    """Return all ladders for the org, newest first."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, theme, current_level, completed_levels, status,
                   created_at, updated_at
            FROM growth.authority_ladders
            WHERE org_id = $1
            ORDER BY created_at DESC
            """,
            org_id,
        )
    return [dict(r) for r in rows]


async def generate_next_level(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    ladder_id: uuid.UUID,
    planned_for: Optional[date] = None,
) -> Optional[uuid.UUID]:
    """
    Generate a content idea for the next pending level of a ladder.

    Returns the new content_idea ID, or None if:
      - Ladder not found
      - Ladder is already completed
      - All levels done
    """
    ladder = await get_ladder(pool, org_id, ladder_id)
    if not ladder:
        log.warning("ladder_not_found", ladder_id=str(ladder_id))
        return None

    if ladder["status"] == "completed":
        log.info("ladder_already_completed", ladder_id=str(ladder_id))
        return None

    current_level = ladder["current_level"]
    if current_level > LADDER_MAX_LEVEL:
        log.info("ladder_all_levels_done", ladder_id=str(ladder_id))
        return None

    # Build list of completed briefs for context (avoid repetition)
    completed_briefs = await _get_completed_briefs(pool, org_id, ladder_id)

    idea_id = await run_ladder_planner(
        pool=pool,
        org_id=org_id,
        brand=brand,
        ladder_id=ladder_id,
        theme=ladder["theme"],
        ladder_level=current_level,
        completed_briefs=completed_briefs,
        planned_for=planned_for,
    )

    if idea_id:
        log.info(
            "ladder_level_idea_generated",
            ladder_id=str(ladder_id),
            level=current_level,
            level_name=LADDER_LEVEL_NAMES.get(current_level, "unknown"),
            idea_id=str(idea_id),
        )

    return idea_id


async def advance_ladder_level(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    ladder_id: uuid.UUID,
    completed_level: int,
) -> bool:
    """
    Mark a level as completed and advance the ladder's current_level.
    Called when a variant at this level is finalized (published or approved).

    Returns True if advanced, False if level was already completed.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT current_level, completed_levels, status
            FROM growth.authority_ladders
            WHERE id = $1 AND org_id = $2
            FOR UPDATE
            """,
            ladder_id,
            org_id,
        )
        if not row:
            return False

        completed_levels = list(row["completed_levels"] or [])
        if completed_level in completed_levels:
            return False   # idempotent — already advanced

        completed_levels.append(completed_level)
        next_level = completed_level + 1
        new_status = "completed" if completed_level >= LADDER_MAX_LEVEL else "active"

        await conn.execute(
            """
            UPDATE growth.authority_ladders
            SET current_level    = $1,
                completed_levels = $2,
                status           = $3,
                updated_at       = NOW()
            WHERE id = $4 AND org_id = $5
            """,
            next_level,
            completed_levels,
            new_status,
            ladder_id,
            org_id,
        )

    log.info(
        "ladder_advanced",
        ladder_id=str(ladder_id),
        completed_level=completed_level,
        next_level=next_level,
        status=new_status,
    )
    return True


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_completed_briefs(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    ladder_id: uuid.UUID,
) -> list[str]:
    """
    Return brief descriptions of already-completed ladder ideas.
    Passed to the planner as context to avoid repetition across levels.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT topic, angle
            FROM growth.content_ideas
            WHERE org_id = $1
              AND authority_ladder_id = $2
              AND status NOT IN ('rejected', 'archived')
            ORDER BY ladder_level ASC
            """,
            org_id,
            ladder_id,
        )
    return [f"Level {i+1}: {r['topic']} — {r['angle']}" for i, r in enumerate(rows)]
