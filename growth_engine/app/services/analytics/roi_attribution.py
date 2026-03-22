"""
ROI attribution — links engagement actions to measurable metric outcomes.

The attribution model is simple and conservative:
  - After each engagement action, we expect a follow-up metric snapshot
    within a configurable window (default 24h for profile views, 48h for followers)
  - We compute deltas: metric_after - metric_before
  - Attribution confidence is based on time proximity and signal strength,
    not causal inference. We never claim causation, only correlation.

In Phase 7 we implement:
  1. get_engagement_roi_summary() — aggregate view over engagement_actions
  2. record_roi_event() — store a measured delta (called by a cron or webhook)
  3. get_roi_attribution_report() — full ROI attribution response for the API

Phase 8+ will add: A/B test support, control groups, Bayesian attribution.
"""

from __future__ import annotations

import uuid
from datetime import date

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


async def get_engagement_roi_summary(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    period_start: date,
    period_end: date,
) -> dict:
    """
    Aggregate engagement actions for the period.
    Returns totals, success rates, approval breakdown, platform breakdown.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                            AS total_engagements,
                COUNT(*) FILTER (WHERE status = 'success')         AS successful_engagements,
                COUNT(*) FILTER (WHERE approval_status = 'auto_approved')
                                                                    AS auto_approved_count,
                COUNT(*) FILTER (WHERE approval_status = 'human_approved')
                                                                    AS human_approved_count,
                COALESCE(AVG(confidence_score) FILTER (WHERE confidence_score IS NOT NULL), 0)
                                                                    AS avg_confidence_score,
                COALESCE(AVG(risk_score) FILTER (WHERE risk_score IS NOT NULL), 0)
                                                                    AS avg_risk_score
            FROM growth.engagement_actions
            WHERE org_id = $1
              AND executed_at::date BETWEEN $2 AND $3
            """,
            org_id, period_start, period_end,
        )

        platform_rows = await conn.fetch(
            """
            SELECT
                platform,
                COUNT(*)                                        AS action_count,
                COUNT(*) FILTER (WHERE status = 'success')     AS success_count
            FROM growth.engagement_actions
            WHERE org_id = $1
              AND executed_at::date BETWEEN $2 AND $3
            GROUP BY platform
            ORDER BY action_count DESC
            """,
            org_id, period_start, period_end,
        )

        roi_event_count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM growth.engagement_roi_events
            WHERE org_id = $1
              AND measured_at::date BETWEEN $2 AND $3
            """,
            org_id, period_start, period_end,
        )

        avg_attribution_conf = await conn.fetchval(
            """
            SELECT COALESCE(AVG(attribution_confidence), 0)
            FROM growth.engagement_roi_events
            WHERE org_id = $1
              AND measured_at::date BETWEEN $2 AND $3
            """,
            org_id, period_start, period_end,
        )

    platforms = []
    for pr in platform_rows:
        total = pr["action_count"]
        succ  = pr["success_count"]
        platforms.append({
            "platform": pr["platform"],
            "action_count": total,
            "success_rate": round(succ / total, 3) if total else 0.0,
        })

    return {
        "total_engagements":        row["total_engagements"],
        "successful_engagements":   row["successful_engagements"],
        "auto_approved_count":      row["auto_approved_count"],
        "human_approved_count":     row["human_approved_count"],
        "avg_confidence_score":     round(float(row["avg_confidence_score"]), 3),
        "avg_risk_score":           round(float(row["avg_risk_score"]), 3),
        "platforms":                platforms,
        "attribution_events":       roi_event_count,
        "avg_attribution_confidence": round(float(avg_attribution_conf), 3),
    }


async def record_roi_event(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    action_id: uuid.UUID,
    target_platform_id: str,
    platform: str,
    profile_views_delta: int | None = None,
    follower_delta: int | None = None,
    connection_requests: int | None = None,
    post_clicks_delta: int | None = None,
    attribution_confidence: float = 0.0,
    measurement_window_hours: int = 24,
    notes: str | None = None,
) -> uuid.UUID:
    """Record a measured engagement ROI event. Returns new event id."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.engagement_roi_events (
                org_id, action_id, target_platform_id, platform,
                profile_views_delta, follower_delta, connection_requests,
                post_clicks_delta, attribution_confidence,
                measurement_window_hours, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
            """,
            org_id, action_id, target_platform_id, platform,
            profile_views_delta, follower_delta, connection_requests,
            post_clicks_delta, attribution_confidence,
            measurement_window_hours, notes,
        )
    log.info("roi_event_recorded", org_id=str(org_id), action_id=str(action_id),
             attribution_confidence=attribution_confidence)
    return row["id"]
