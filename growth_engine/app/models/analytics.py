"""
Pydantic models for Phase 7 — Platform Metrics + Growth Intelligence.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ── Metric ingestion ─────────────────────────────────────────────────────────

class MetricsIngestRequest(BaseModel):
    """
    Ingest raw platform metrics for a published variant.
    Called by a cron job, webhook, or manual import.

    platform_post_id: optional — if omitted, auto-resolved from publish_queue.
    Stored on content_metrics so analytics survive re-queuing or platform ID changes.
    """
    variant_id: uuid.UUID
    platform: str
    snapshot_date: date
    raw_metrics: dict[str, Any]   # platform-native format
    source: str = "api"
    platform_post_id: Optional[str] = None


class MetricsIngestResponse(BaseModel):
    snapshot_id: uuid.UUID
    variant_id: uuid.UUID
    platform: str
    snapshot_date: date
    normalized: "ContentMetricsOut"


# ── Normalized metrics ───────────────────────────────────────────────────────

class ContentMetricsOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    variant_id: uuid.UUID
    platform: str
    snapshot_date: date
    platform_post_id: Optional[str]   # platform-native post ID; preserved for cross-ref
    impressions: int
    reach: int
    clicks: int
    reactions: int
    comments_received: int
    shares: int
    video_views: int
    engagement_rate: float
    snapshot_id: Optional[uuid.UUID]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ContentMetricsListResponse(BaseModel):
    metrics: list[ContentMetricsOut]
    total: int


# ── Analytics overview ───────────────────────────────────────────────────────

class PlatformSummary(BaseModel):
    platform: str
    posts_published: int
    total_impressions: int
    total_reactions: int
    total_comments: int
    total_shares: int
    avg_engagement_rate: float
    top_variant_id: Optional[uuid.UUID]
    top_variant_engagement_rate: Optional[float]


class AnalyticsOverviewResponse(BaseModel):
    org_id: uuid.UUID
    period_start: date
    period_end: date
    platforms: list[PlatformSummary]
    total_posts: int
    total_impressions: int
    avg_engagement_rate: float


# ── Top content ──────────────────────────────────────────────────────────────

class TopContentItem(BaseModel):
    variant_id: uuid.UUID
    platform: str
    platform_post_id: Optional[str]
    body_text_snippet: str
    angle_type: Optional[str]
    impressions: int
    engagement_rate: float
    reactions: int
    comments_received: int
    shares: int
    clicks: int
    snapshot_date: date
    published_url: Optional[str]
    ranked_by: str          # always explicit: engagement_rate | impressions | clicks | shares


class TopContentResponse(BaseModel):
    items: list[TopContentItem]
    total: int


# ── ROI summary ──────────────────────────────────────────────────────────────

class EngagementROISummary(BaseModel):
    total_engagements: int
    successful_engagements: int
    auto_approved_count: int
    human_approved_count: int
    avg_confidence_score: float
    avg_risk_score: float
    platforms: list[dict]         # {platform, action_count, success_rate}


class ROIAttributionResponse(BaseModel):
    period_start: date
    period_end: date
    engagement_roi: EngagementROISummary
    attribution_events: int
    avg_attribution_confidence: float


# ── Growth Intelligence ───────────────────────────────────────────────────────

class IntelligenceRecommendation(BaseModel):
    priority: Literal["high", "medium", "low"]
    category: str     # e.g. "posting_frequency", "content_type", "platform_mix"
    action: str       # e.g. "Increase LinkedIn posting from 2x to 4x per week"
    reason: str       # data-backed reason


class GrowthIntelligenceSummaryOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    period_type: Literal["weekly", "monthly"]
    period_start: date
    period_end: date
    summary_json: dict[str, Any]
    health_score: float = Field(default=0.0)
    generated_at: datetime
    variants_analyzed: int

    model_config = {"from_attributes": True}

    @property
    def recommendations(self) -> list[IntelligenceRecommendation]:
        raw = self.summary_json.get("recommendations", [])
        return [IntelligenceRecommendation(**r) for r in raw if isinstance(r, dict)]
