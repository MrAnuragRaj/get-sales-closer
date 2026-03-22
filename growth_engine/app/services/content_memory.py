"""
Content memory — last N published/drafted posts for de-duplication.

The planner and writer consult this before generating to avoid:
  - Repeating the same hook style too soon
  - Repeating the same angle
  - Repeating the same CTA
  - Covering the same topic too recently

Per critic.md: check last 30 posts.

This is a read-only module. It does not modify any records.
"""

from __future__ import annotations

import uuid

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)

MEMORY_WINDOW = 30   # number of recent posts to check


async def get_recent_topics(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    limit: int = MEMORY_WINDOW,
) -> list[str]:
    """
    Return topics from the last N content ideas for this org.
    Used by the planner to avoid repeating recent topics.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT topic
            FROM growth.content_ideas
            WHERE org_id = $1
              AND status NOT IN ('rejected', 'archived')
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
    return [row["topic"] for row in rows]


async def get_recent_angles(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    limit: int = MEMORY_WINDOW,
) -> list[str]:
    """
    Return angle_title values from recent variants.
    Used by the angle generator to avoid repeating recent angles.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT cv.angle_title
            FROM growth.content_variants cv
            WHERE cv.org_id = $1
              AND cv.angle_title IS NOT NULL
              AND cv.status NOT IN ('rejected', 'failed')
            ORDER BY cv.angle_title
            LIMIT $2
            """,
            org_id,
            limit,
        )
    return [row["angle_title"] for row in rows if row["angle_title"]]


async def get_recent_content_summary(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    limit: int = MEMORY_WINDOW,
) -> str:
    """
    Return a compact summary of recent posts for a given platform.
    Passed to the writer as context to avoid repetition.

    Returns a multi-line string: "topic | angle | hook" per row.
    Empty string if no recent content.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                ci.topic,
                cv.angle_title,
                cv.hook_text
            FROM growth.content_variants cv
            JOIN growth.content_ideas ci ON ci.id = cv.idea_id
            WHERE cv.org_id = $1
              AND cv.platform = $2
              AND cv.status NOT IN ('rejected', 'failed')
              AND cv.finalized_at IS NOT NULL
            ORDER BY cv.finalized_at DESC
            LIMIT $3
            """,
            org_id,
            platform,
            limit,
        )

    if not rows:
        return ""

    lines = []
    for row in rows:
        topic = row["topic"] or ""
        angle = row["angle_title"] or ""
        hook = row["hook_text"] or ""
        lines.append(f"{topic} | {angle} | {hook[:60]}")

    return "\n".join(lines)


async def get_recent_hook_styles(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    limit: int = 10,
) -> list[str]:
    """
    Return hook styles used recently on a platform.
    Used by the hook generator to ensure style variety.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ce.experiment_value as hook_style
            FROM growth.content_experiments ce
            JOIN growth.content_variants cv ON cv.id = ce.variant_id
            WHERE ce.org_id = $1
              AND ce.experiment_type = 'hook_style'
              AND cv.platform = $2
            ORDER BY ce.created_at DESC
            LIMIT $3
            """,
            org_id,
            platform,
            limit,
        )
    return [row["hook_style"] for row in rows]
