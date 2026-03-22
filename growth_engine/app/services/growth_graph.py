"""
Growth Graph service.

Tracks influencer nodes — unique authors observed across engagement opportunities.
Provides two signals that make the system feel relationship-aware:

  seen_count    — how many times we've seen this author's posts
  engaged_count — how many times we've successfully engaged with them

Relationship strength (derived): engaged_count * 5 + seen_count
This prevents high-seen / never-engaged authors from dominating.

All functions are fire-and-forget:
  - exceptions are caught and structured-logged
  - primary flows always continue

Called by:
  discovery.py   → upsert_influencer_node()  (every new post ingested)
  executor.py    → record_engagement()        (every successful execution)
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


async def upsert_influencer_node(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    author_platform_id: str,
    author_name: Optional[str],
) -> Optional[uuid.UUID]:
    """
    Upsert an influencer node for this author.

    On first sight: inserts with seen_count=1.
    On repeat: increments seen_count and refreshes last_seen_at and author_name.

    Returns the node UUID, or None on error.
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO growth.influencer_nodes (
                    org_id, platform, author_platform_id, author_name,
                    seen_count, last_seen_at
                ) VALUES ($1, $2, $3, $4, 1, NOW())
                ON CONFLICT (org_id, platform, author_platform_id) DO UPDATE
                    SET seen_count   = growth.influencer_nodes.seen_count + 1,
                        last_seen_at = NOW(),
                        author_name  = COALESCE(EXCLUDED.author_name,
                                                growth.influencer_nodes.author_name),
                        updated_at   = NOW()
                RETURNING id
                """,
                org_id, platform, author_platform_id, author_name,
            )
        return row["id"] if row else None
    except Exception as exc:
        log.error(
            "growth_graph_upsert_node_failed",
            org_id=str(org_id),
            platform=platform,
            author_platform_id=author_platform_id,
            error=str(exc),
        )
        return None


async def record_engagement(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    node_id: uuid.UUID,
) -> None:
    """
    Increment the engaged_count for a node after a successful platform execution.

    Only called on success — failed or cap-blocked executions do not count.
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE growth.influencer_nodes
                SET engaged_count   = engaged_count + 1,
                    last_engaged_at = NOW(),
                    updated_at      = NOW()
                WHERE id = $1 AND org_id = $2
                """,
                node_id, org_id,
            )
    except Exception as exc:
        log.error(
            "growth_graph_record_engagement_failed",
            org_id=str(org_id),
            node_id=str(node_id),
            error=str(exc),
        )
