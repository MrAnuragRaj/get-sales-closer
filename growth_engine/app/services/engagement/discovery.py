"""
Engagement opportunity discovery.

process_discovered_post() takes one post from any source (platform API,
webhook, manual import) and:
  1. Deduplicates against existing opportunities (post_platform_id + type)
  2. Inserts the opportunity with status='pending_score'

Scoring (LLM call) is NOT done here.  It is deferred to the scoring worker
(services/engagement/scoring_worker.py) which is triggered by cron via
POST /internal/run-scoring-worker.

This makes the discovery handler fast (<5ms DB round-trip) and ensures
the request path is never blocked by an LLM call regardless of how many
posts are submitted in a single batch.

Status flow after this module:
  pending_score  →  (scoring worker)  →  pending_review | auto_approved | failed

post_body_snippet stores up to 2000 characters — enough for the scoring
worker to reconstruct full scoring context from the LLM prompt.
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.engagement import DiscoveredPost

log = get_logger(__name__)

# Snippet length stored for the scoring worker's LLM prompt.
# 2000 chars gives the scorer enough context without bloating the row.
_SNIPPET_MAX = 2000

_OPP_COLS = """
    id, org_id, target_id, platform, opportunity_type,
    post_platform_id, post_url, post_body_snippet,
    author_platform_id, author_name,
    confidence_score, risk_score, relevance_score,
    status, rejection_reason,
    generated_action_text, generation_model,
    approved_by, approved_at,
    discovered_at, scheduled_for, executed_at,
    created_at, updated_at
"""


async def process_discovered_post(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    target: dict,                # engagement_targets row
    post: DiscoveredPost,
) -> Optional[dict]:
    """
    Ingest one discovered post as a pending_score opportunity.

    Returns the new opportunity row dict (status='pending_score'),
    or None if the post was already seen (duplicate).

    No LLM call.  Returns in < 5ms.
    """
    platform  = target["platform"]
    target_id = target["id"]
    opp_type  = post.opportunity_type

    # ── Dedup check ───────────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT id FROM growth.engagement_opportunities
            WHERE org_id = $1 AND platform = $2
              AND post_platform_id = $3 AND opportunity_type = $4
            """,
            org_id, platform, post.post_platform_id, opp_type,
        )
    if existing:
        log.debug("opportunity_duplicate_skipped",
                  post_id=post.post_platform_id, existing_id=str(existing["id"]))
        return None

    # ── Insert as pending_score ───────────────────────────────────────────────
    snippet = (post.post_body or "")[:_SNIPPET_MAX]

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            INSERT INTO growth.engagement_opportunities (
                org_id, target_id, platform, opportunity_type,
                post_platform_id, post_url, post_body_snippet,
                author_platform_id, author_name,
                status
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7,
                $8, $9,
                'pending_score'
            )
            ON CONFLICT (org_id, platform, post_platform_id, opportunity_type) DO NOTHING
            RETURNING {_OPP_COLS}
            """,
            org_id, target_id, platform, opp_type,
            post.post_platform_id, post.post_url, snippet,
            post.author_platform_id, post.author_name,
        )

    if not row:
        return None  # Race-condition duplicate (concurrent request)

    # ── Growth Graph: upsert author node + attach to opportunity ──────────────
    if post.author_platform_id:
        from app.services.growth_graph import upsert_influencer_node
        node_id = await upsert_influencer_node(
            pool=pool,
            org_id=org_id,
            platform=platform,
            author_platform_id=post.author_platform_id,
            author_name=post.author_name,
        )
        if node_id:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE growth.engagement_opportunities
                    SET influencer_node_id = $1
                    WHERE id = $2
                    """,
                    node_id, row["id"],
                )

    log.info(
        "opportunity_queued",
        org_id=str(org_id), platform=platform,
        opp_id=str(row["id"]), opp_type=opp_type,
    )
    return dict(row)


async def process_post_batch(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    target: dict,
    posts: list[DiscoveredPost],
) -> list[dict]:
    """
    Ingest a batch of discovered posts.

    Returns list of created (pending_score) opportunities.
    Duplicates are silently skipped.
    """
    results = []
    for post in posts:
        opp = await process_discovered_post(pool, org_id, target, post)
        if opp:
            results.append(opp)

    log.info(
        "discovery_batch_complete",
        org_id=str(org_id), target_id=str(target["id"]),
        submitted=len(posts), queued=len(results),
    )
    return results
