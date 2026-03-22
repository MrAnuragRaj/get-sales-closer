"""
Analytics API — Phase 7.

Routes:
  POST /growth/analytics/metrics/ingest       — ingest raw platform metrics
  GET  /growth/analytics/variants/{id}/metrics — all snapshots for a variant
  GET  /growth/analytics/overview             — org-level platform summary
  GET  /growth/analytics/top-content         — top variants by engagement_rate
  GET  /growth/analytics/roi                 — engagement ROI attribution
  GET  /growth/analytics/intelligence        — latest growth intelligence summary
  POST /growth/analytics/intelligence/generate — trigger new summary generation

Access control:
  All routes require valid JWT (require_auth).
  No plan gate — analytics are available to all authenticated org members.
  The /intelligence/generate route is available to all but rate-limited by
  virtue of the expensive LLM call (callers should call at most once/day).
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.analytics import (
    AnalyticsOverviewResponse,
    ContentMetricsListResponse,
    GrowthIntelligenceSummaryOut,
    MetricsIngestRequest,
    MetricsIngestResponse,
    ROIAttributionResponse,
    TopContentResponse,
)
from app.services.analytics import metrics_store, roi_attribution
from app.services.analytics.intelligence import build_intelligence_summary, get_latest_summary
from app.services.analytics.normalizer import normalize
from app.services.rate_limiter import check_rate_limit

router = APIRouter(prefix="/analytics", tags=["analytics"])


# ── Metrics ingestion ─────────────────────────────────────────────────────────

@router.post("/metrics/ingest", response_model=MetricsIngestResponse)
async def ingest_metrics(
    body: MetricsIngestRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Ingest raw platform metrics for a published variant.

    Accepts the native format from any supported platform (LinkedIn, X,
    Facebook, Instagram) or a manual import in the normalized format.
    Normalizes and upserts into content_metrics.
    """
    allowed, _, _ = await check_rate_limit(pool, auth.org_id, "growth:metrics:ingest", 100, "hour")
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="rate_limit_exceeded:growth:metrics:ingest:100/hr")

    # Verify variant belongs to org
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            body.variant_id, auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="variant_not_found")

    snapshot_id, normalized = await metrics_store.ingest_metrics(
        pool=pool,
        org_id=auth.org_id,
        variant_id=body.variant_id,
        platform=body.platform,
        snapshot_date=body.snapshot_date,
        raw_metrics=body.raw_metrics,
        source=body.source,
        platform_post_id=body.platform_post_id,
    )

    # Build response
    normalized_dict = {
        "id": snapshot_id,  # placeholder; real id comes from content_metrics row
        "org_id": auth.org_id,
        "variant_id": body.variant_id,
        "platform": body.platform,
        "snapshot_date": body.snapshot_date,
        "snapshot_id": snapshot_id,
        "created_at": date.today(),
        "updated_at": date.today(),
        **normalized.to_dict(),
    }

    return {
        "snapshot_id":   snapshot_id,
        "variant_id":    body.variant_id,
        "platform":      body.platform,
        "snapshot_date": body.snapshot_date,
        "normalized":    normalized_dict,
    }


# ── Variant metrics ───────────────────────────────────────────────────────────

@router.get("/variants/{variant_id}/metrics", response_model=ContentMetricsListResponse)
async def get_variant_metrics(
    variant_id: uuid.UUID,
    limit: int = Query(30, ge=1, le=90),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    rows = await metrics_store.get_variant_metrics(pool, auth.org_id, variant_id, limit=limit)
    return {"metrics": rows, "total": len(rows)}


# ── Org overview ──────────────────────────────────────────────────────────────

@router.get("/overview", response_model=AnalyticsOverviewResponse)
async def get_overview(
    period_days: int = Query(30, ge=7, le=90, description="Lookback window in days"),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Aggregate metrics by platform for the last N days."""
    period_end   = date.today()
    period_start = period_end - timedelta(days=period_days - 1)

    platform_rows = await metrics_store.get_org_overview(pool, auth.org_id, period_start, period_end)

    total_posts       = sum(r["posts_published"] for r in platform_rows)
    total_impressions = sum(r["total_impressions"] for r in platform_rows)
    avg_er = (
        sum(float(r["avg_engagement_rate"] or 0) for r in platform_rows) / len(platform_rows)
        if platform_rows else 0.0
    )

    return {
        "org_id":             auth.org_id,
        "period_start":       period_start,
        "period_end":         period_end,
        "platforms":          platform_rows,
        "total_posts":        total_posts,
        "total_impressions":  total_impressions,
        "avg_engagement_rate": round(avg_er, 4),
    }


# ── Top content ───────────────────────────────────────────────────────────────

@router.get("/top-content", response_model=TopContentResponse)
async def get_top_content(
    platform: Optional[str] = Query(None),
    period_days: int = Query(30, ge=7, le=90),
    limit: int = Query(20, ge=1, le=50),
    ranking_basis: str = Query("engagement_rate",
        description="Rank by: engagement_rate (default) | impressions | clicks | shares"),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Returns top-performing variants. ranked_by field on each item
    confirms the ranking basis used — always explicit, never implied.
    """
    period_end   = date.today()
    period_start = period_end - timedelta(days=period_days - 1)

    rows = await metrics_store.get_top_content(
        pool, auth.org_id, platform, period_start, period_end,
        limit=limit, ranking_basis=ranking_basis,
    )
    return {"items": rows, "total": len(rows)}


# ── ROI attribution ───────────────────────────────────────────────────────────

@router.get("/roi", response_model=ROIAttributionResponse)
async def get_roi_attribution(
    period_days: int = Query(30, ge=7, le=90),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Engagement ROI summary for the period."""
    period_end   = date.today()
    period_start = period_end - timedelta(days=period_days - 1)

    summary = await roi_attribution.get_engagement_roi_summary(
        pool, auth.org_id, period_start, period_end
    )

    return {
        "period_start":                period_start,
        "period_end":                  period_end,
        "engagement_roi":              summary,
        "attribution_events":          summary.get("attribution_events", 0),
        "avg_attribution_confidence":  summary.get("avg_attribution_confidence", 0.0),
    }


# ── Growth Intelligence ───────────────────────────────────────────────────────

@router.get("/intelligence", response_model=GrowthIntelligenceSummaryOut)
async def get_intelligence_summary(
    period_type: str = Query("weekly", pattern="^(weekly|monthly)$"),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Return the most recently generated intelligence summary."""
    row = await get_latest_summary(pool, auth.org_id, period_type)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="no_intelligence_summary_available — call POST /intelligence/generate first",
        )
    return row


@router.post("/intelligence/generate")
async def generate_intelligence_summary(
    period_type: str = Query("weekly", pattern="^(weekly|monthly)$"),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Generate (or regenerate) a growth intelligence summary for the org.

    For weekly: covers the last 7 days.
    For monthly: covers the last 30 days.

    This is an LLM-backed operation — rate limited to 5 calls/org/day.
    The result is stored and served by GET /intelligence.
    """
    allowed, _, _ = await check_rate_limit(pool, auth.org_id, "growth:intelligence:gen", 5, "day")
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="rate_limit_exceeded:growth:intelligence:gen:5/day")

    today        = date.today()
    period_end   = today
    period_start = today - timedelta(days=6 if period_type == "weekly" else 29)

    summary = await build_intelligence_summary(
        pool=pool,
        org_id=auth.org_id,
        period_type=period_type,
        period_start=period_start,
        period_end=period_end,
    )

    return {
        "period_type":    period_type,
        "period_start":   period_start.isoformat(),
        "period_end":     period_end.isoformat(),
        "health_score":   summary.get("health_score", 0),
        "recommendations_count": len(summary.get("recommendations", [])),
        "platforms_analyzed": len(summary.get("platform_trends", [])),
    }
