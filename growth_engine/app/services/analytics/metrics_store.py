"""
Metrics storage — ingest raw snapshots and upsert normalized content_metrics.
"""

from __future__ import annotations

import json
import uuid
from datetime import date

import asyncpg

from app.logging_config import get_logger
from app.services.analytics.normalizer import NormalizedMetrics, normalize

log = get_logger(__name__)


async def _get_platform_post_id(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    platform: str,
) -> str | None:
    """Look up the platform-native post ID from publish_queue for this variant."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT published_platform_id FROM growth.publish_queue
            WHERE variant_id = $1 AND platform = $2
              AND status = 'published'
              AND published_platform_id IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            variant_id, platform,
        )
    return row["published_platform_id"] if row else None


async def ingest_metrics(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    platform: str,
    snapshot_date: date,
    raw_metrics: dict,
    source: str = "api",
    platform_post_id: str | None = None,
) -> tuple[uuid.UUID, NormalizedMetrics]:
    """
    Store raw snapshot and upsert normalized metrics for a variant.

    platform_post_id: if not provided, auto-resolved from publish_queue.
    Returns (snapshot_id, normalized_metrics).
    """
    # ── Resolve platform_post_id if not supplied ──────────────────────────────
    if not platform_post_id:
        platform_post_id = await _get_platform_post_id(pool, variant_id, platform)

    # ── Store raw snapshot ────────────────────────────────────────────────────
    async with pool.acquire() as conn:
        snapshot_row = await conn.fetchrow(
            """
            INSERT INTO growth.platform_metric_snapshots
                (org_id, variant_id, platform, snapshot_date, raw_metrics, source)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            ON CONFLICT (variant_id, platform, snapshot_date, source)
            DO UPDATE SET raw_metrics = EXCLUDED.raw_metrics,
                          created_at  = NOW()
            RETURNING id
            """,
            org_id,
            variant_id,
            platform,
            snapshot_date,
            json.dumps(raw_metrics),
            source,
        )
    snapshot_id = snapshot_row["id"]

    # ── Normalize ─────────────────────────────────────────────────────────────
    normalized = normalize(platform, raw_metrics)

    # ── Upsert content_metrics ────────────────────────────────────────────────
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.content_metrics (
                org_id, variant_id, platform, snapshot_date,
                platform_post_id,
                impressions, reach, clicks, reactions,
                comments_received, shares, video_views,
                engagement_rate, snapshot_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (variant_id, platform, snapshot_date)
            DO UPDATE SET
                platform_post_id  = COALESCE(EXCLUDED.platform_post_id, growth.content_metrics.platform_post_id),
                impressions       = EXCLUDED.impressions,
                reach             = EXCLUDED.reach,
                clicks            = EXCLUDED.clicks,
                reactions         = EXCLUDED.reactions,
                comments_received = EXCLUDED.comments_received,
                shares            = EXCLUDED.shares,
                video_views       = EXCLUDED.video_views,
                engagement_rate   = EXCLUDED.engagement_rate,
                snapshot_id       = EXCLUDED.snapshot_id,
                updated_at        = NOW()
            """,
            org_id, variant_id, platform, snapshot_date,
            platform_post_id,
            normalized.impressions, normalized.reach, normalized.clicks,
            normalized.reactions, normalized.comments_received,
            normalized.shares, normalized.video_views,
            normalized.engagement_rate, snapshot_id,
        )

    log.info(
        "metrics_ingested",
        org_id=str(org_id), variant_id=str(variant_id),
        platform=platform, snapshot_date=snapshot_date.isoformat(),
        impressions=normalized.impressions, engagement_rate=normalized.engagement_rate,
    )
    return snapshot_id, normalized


async def get_variant_metrics(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    limit: int = 30,
) -> list[dict]:
    """Return all metric snapshots for a variant, newest first."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, org_id, variant_id, platform, snapshot_date,
                   platform_post_id,
                   impressions, reach, clicks, reactions,
                   comments_received, shares, video_views,
                   engagement_rate, snapshot_id, created_at, updated_at
            FROM growth.content_metrics
            WHERE variant_id = $1 AND org_id = $2
            ORDER BY snapshot_date DESC
            LIMIT $3
            """,
            variant_id, org_id, limit,
        )
    return [dict(r) for r in rows]


async def get_org_overview(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    period_start: date,
    period_end: date,
) -> list[dict]:
    """
    Aggregate metrics by platform for the given period.
    Returns one row per platform with totals and averages.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                m.platform,
                COUNT(DISTINCT m.variant_id)                    AS posts_published,
                COALESCE(SUM(m.impressions), 0)                 AS total_impressions,
                COALESCE(SUM(m.reactions), 0)                   AS total_reactions,
                COALESCE(SUM(m.comments_received), 0)           AS total_comments,
                COALESCE(SUM(m.shares), 0)                      AS total_shares,
                COALESCE(AVG(m.engagement_rate) FILTER (WHERE m.impressions > 0), 0)
                                                                AS avg_engagement_rate,
                (
                    SELECT variant_id
                    FROM growth.content_metrics
                    WHERE org_id = $1
                      AND platform = m.platform
                      AND snapshot_date BETWEEN $2 AND $3
                      AND impressions > 0
                    ORDER BY engagement_rate DESC
                    LIMIT 1
                )                                               AS top_variant_id,
                (
                    SELECT engagement_rate
                    FROM growth.content_metrics
                    WHERE org_id = $1
                      AND platform = m.platform
                      AND snapshot_date BETWEEN $2 AND $3
                      AND impressions > 0
                    ORDER BY engagement_rate DESC
                    LIMIT 1
                )                                               AS top_variant_engagement_rate
            FROM growth.content_metrics m
            WHERE m.org_id = $1
              AND m.snapshot_date BETWEEN $2 AND $3
            GROUP BY m.platform
            ORDER BY total_impressions DESC
            """,
            org_id, period_start, period_end,
        )
    return [dict(r) for r in rows]


_VALID_RANKING_BASES = frozenset({"engagement_rate", "impressions", "clicks", "shares"})


async def get_top_content(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str | None,
    period_start: date,
    period_end: date,
    limit: int = 20,
    ranking_basis: str = "engagement_rate",
) -> list[dict]:
    """
    Return top-performing variants ranked by `ranking_basis` in the period.

    ranking_basis options: engagement_rate (default) | impressions | clicks | shares
    The ranking basis is always included in the response so callers know what
    "top performer" means — never implied.

    Joins content_metrics → content_variants → publish_queue for URL.
    """
    if ranking_basis not in _VALID_RANKING_BASES:
        ranking_basis = "engagement_rate"

    # Only engagement_rate and impressions require the impressions > 0 filter
    # to be meaningful; others can include zero-impression rows for completeness
    impressions_filter = "AND m.impressions > 0" if ranking_basis == "engagement_rate" else ""
    platform_filter    = "AND m.platform = $5" if platform else ""
    order_col          = f"m.{ranking_basis}"

    params = [org_id, period_start, period_end, limit]
    if platform:
        params.append(platform)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                m.variant_id,
                m.platform,
                m.platform_post_id,
                LEFT(v.body_text, 200)       AS body_text_snippet,
                v.angle_type,
                m.impressions,
                m.engagement_rate,
                m.reactions,
                m.comments_received,
                m.shares,
                m.clicks,
                m.snapshot_date,
                pq.published_url,
                '{ranking_basis}'            AS ranked_by
            FROM growth.content_metrics m
            JOIN growth.content_variants v ON v.id = m.variant_id
            LEFT JOIN growth.publish_queue pq
                ON pq.variant_id = m.variant_id AND pq.platform = m.platform
               AND pq.status = 'published'
            WHERE m.org_id = $1
              AND m.snapshot_date BETWEEN $2 AND $3
              {impressions_filter}
              {platform_filter}
            ORDER BY {order_col} DESC NULLS LAST, m.impressions DESC
            LIMIT $4
            """,
            *params,
        )
    return [dict(r) for r in rows]
