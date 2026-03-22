"""
Growth Radar — computed intelligence snapshot.

Aggregates signals from A–E into a single strategic digest per org.
No LLM calls. No external API calls. Pure SQL aggregation over existing tables.

Signals computed:
  top_authors        — top 10 influencer nodes by relationship strength
                       (engaged_count * 5 + seen_count DESC)
  top_angles         — top content angles by usage + avg hook score (last 30d)
  engagement_health  — execution volume, success rate, auto-approval rate,
                       avg confidence score (last 30d)
  attribution_summary — total revenue attributions + high-confidence count

Called by:
  POST /internal/run-radar  (secret-gated; recommended: daily or weekly cron)
"""

from __future__ import annotations

import json
import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)

PERIOD_DAYS = 30
TOP_AUTHORS_LIMIT = 10
TOP_ANGLES_LIMIT  = 5


async def compute_radar(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    period_days: int = PERIOD_DAYS,
) -> dict:
    """
    Compute the full radar snapshot for one org and persist it.

    Returns the snapshot dict that was written.
    """
    top_authors       = await _compute_top_authors(pool, org_id)
    top_angles        = await _compute_top_angles(pool, org_id, period_days)
    engagement_health = await _compute_engagement_health(pool, org_id, period_days)
    attribution_summary = await _compute_attribution_summary(pool, org_id)

    snapshot = {
        "period_days":          period_days,
        "top_authors":          top_authors,
        "top_angles":           top_angles,
        "engagement_health":    engagement_health,
        "attribution_summary":  attribution_summary,
    }

    await _upsert_snapshot(pool, org_id, snapshot)

    log.info(
        "radar_computed",
        org_id=str(org_id),
        period_days=period_days,
        top_authors_count=len(top_authors),
        top_angles_count=len(top_angles),
        total_executed=engagement_health.get("total_executed", 0),
        total_attributed=attribution_summary.get("total_attributed", 0),
    )

    return snapshot


async def get_snapshot(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> Optional[dict]:
    """
    Return the latest radar snapshot for this org, or None if not yet computed.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT period_days, top_authors, top_angles,
                   engagement_health, attribution_summary, computed_at
            FROM growth.radar_snapshots
            WHERE org_id = $1
            """,
            org_id,
        )
    if not row:
        return None

    return {
        "period_days":         row["period_days"],
        "top_authors":         row["top_authors"],
        "top_angles":          row["top_angles"],
        "engagement_health":   row["engagement_health"],
        "attribution_summary": row["attribution_summary"],
        "computed_at":         row["computed_at"].isoformat(),
    }


# ── Signal aggregators ────────────────────────────────────────────────────────

async def _compute_top_authors(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> list[dict]:
    """Top 10 influencer nodes by relationship strength (engaged * 5 + seen)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                author_name,
                platform,
                seen_count,
                engaged_count,
                last_engaged_at,
                (engaged_count * 5 + seen_count) AS relationship_score
            FROM growth.influencer_nodes
            WHERE org_id = $1
              AND engaged_count > 0
            ORDER BY relationship_score DESC
            LIMIT $2
            """,
            org_id, TOP_AUTHORS_LIMIT,
        )
    return [
        {
            "author_name":        r["author_name"],
            "platform":           r["platform"],
            "seen_count":         r["seen_count"],
            "engaged_count":      r["engaged_count"],
            "last_engaged_at":    r["last_engaged_at"].isoformat() if r["last_engaged_at"] else None,
            "relationship_score": r["relationship_score"],
        }
        for r in rows
    ]


async def _compute_top_angles(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    period_days: int,
) -> list[dict]:
    """Top content angles by variant count and avg hook score over period."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                angle_type,
                COUNT(*)               AS variant_count,
                AVG(hook_rank)         AS avg_hook_score
            FROM growth.content_variants
            WHERE org_id     = $1
              AND angle_type IS NOT NULL
              AND created_at > NOW() - ($2 || ' days')::interval
            GROUP BY angle_type
            ORDER BY variant_count DESC, avg_hook_score DESC NULLS LAST
            LIMIT $3
            """,
            org_id, str(period_days), TOP_ANGLES_LIMIT,
        )
    return [
        {
            "angle_type":    r["angle_type"],
            "variant_count": r["variant_count"],
            "avg_hook_score": round(float(r["avg_hook_score"]), 3) if r["avg_hook_score"] else None,
        }
        for r in rows
    ]


async def _compute_engagement_health(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    period_days: int,
) -> dict:
    """Execution volume, success/auto-approval rates, avg confidence over period."""
    async with pool.acquire() as conn:
        action_stats = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                        AS total_executed,
                COUNT(*) FILTER (WHERE status = 'success')     AS total_success,
                AVG(confidence_score)                          AS avg_confidence
            FROM growth.engagement_actions
            WHERE org_id     = $1
              AND executed_at > NOW() - ($2 || ' days')::interval
            """,
            org_id, str(period_days),
        )

        auto_approval_stats = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                                  AS total_executed_opps,
                COUNT(*) FILTER (WHERE approved_by IS NULL
                                   AND status = 'executed')               AS auto_approved_count
            FROM growth.engagement_opportunities
            WHERE org_id       = $1
              AND executed_at  > NOW() - ($2 || ' days')::interval
            """,
            org_id, str(period_days),
        )

    total    = int(action_stats["total_executed"] or 0)
    success  = int(action_stats["total_success"]  or 0)
    avg_conf = float(action_stats["avg_confidence"] or 0.0)

    total_opps   = int(auto_approval_stats["total_executed_opps"] or 0)
    auto_count   = int(auto_approval_stats["auto_approved_count"]  or 0)

    return {
        "total_executed":     total,
        "success_rate":       round(success / total, 4) if total else None,
        "auto_approval_rate": round(auto_count / total_opps, 4) if total_opps else None,
        "avg_confidence":     round(avg_conf, 3) if avg_conf else None,
        "period_days":        period_days,
    }


async def _compute_attribution_summary(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> dict:
    """Total revenue attributions + high-confidence (≥0.85) count."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                              AS total_attributed,
                COUNT(*) FILTER (WHERE attribution_score >= 0.85)    AS high_confidence_count
            FROM growth.revenue_attributions
            WHERE org_id = $1
            """,
            org_id,
        )
    return {
        "total_attributed":      int(row["total_attributed"]      or 0),
        "high_confidence_count": int(row["high_confidence_count"] or 0),
    }


# ── Persistence ───────────────────────────────────────────────────────────────

async def _upsert_snapshot(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    snapshot: dict,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.radar_snapshots
                (org_id, period_days, top_authors, top_angles,
                 engagement_health, attribution_summary, computed_at)
            VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
            ON CONFLICT (org_id) DO UPDATE
                SET period_days         = EXCLUDED.period_days,
                    top_authors         = EXCLUDED.top_authors,
                    top_angles          = EXCLUDED.top_angles,
                    engagement_health   = EXCLUDED.engagement_health,
                    attribution_summary = EXCLUDED.attribution_summary,
                    computed_at         = EXCLUDED.computed_at
            """,
            org_id,
            snapshot["period_days"],
            json.dumps(snapshot["top_authors"]),
            json.dumps(snapshot["top_angles"]),
            json.dumps(snapshot["engagement_health"]),
            json.dumps(snapshot["attribution_summary"]),
        )
