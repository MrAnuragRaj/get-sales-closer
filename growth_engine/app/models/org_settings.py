"""
Pydantic models for Org Growth Settings API.

OrgGrowthSettingsCreate  — POST body
OrgGrowthSettingsUpdate  — PUT body (partial)
OrgGrowthSettingsOut     — Response

posting_mode values: auto | approval | suggestion_only
plan_key values:     free | starter | growth | scale
engagement_plan_key: engagement_starter | engagement_pro | None
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

PostingMode = Literal["auto", "approval", "suggestion_only"]
ContentPlanKey = Literal["free", "starter", "growth", "scale"]
EngagementPlanKey = Literal["engagement_starter", "engagement_pro"]


class OrgGrowthSettingsCreate(BaseModel):
    posting_mode: PostingMode = "suggestion_only"
    approval_required: bool = True
    daily_content_piece_limit: int = Field(0, ge=0)
    daily_engagement_limit: int = Field(0, ge=0)
    max_connected_platforms: int = Field(5, ge=1, le=10)
    plan_key: ContentPlanKey = "free"
    engagement_plan_key: Optional[EngagementPlanKey] = None
    timezone: str = Field("UTC", max_length=64)

    # Optional config blobs
    posting_windows_json: Optional[dict[str, Any]] = None
    platform_distribution_json: Optional[dict[str, Any]] = None
    engagement_targets_json: Optional[dict[str, Any]] = None

    auto_engagement_enabled: bool = False
    auto_safe_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    risk_block_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)


class OrgGrowthSettingsUpdate(BaseModel):
    posting_mode: Optional[PostingMode] = None
    approval_required: Optional[bool] = None
    daily_content_piece_limit: Optional[int] = Field(None, ge=0)
    daily_engagement_limit: Optional[int] = Field(None, ge=0)
    max_connected_platforms: Optional[int] = Field(None, ge=1, le=10)
    plan_key: Optional[ContentPlanKey] = None
    engagement_plan_key: Optional[EngagementPlanKey] = None
    timezone: Optional[str] = Field(None, max_length=64)
    posting_windows_json: Optional[dict[str, Any]] = None
    platform_distribution_json: Optional[dict[str, Any]] = None
    engagement_targets_json: Optional[dict[str, Any]] = None
    auto_engagement_enabled: Optional[bool] = None
    auto_safe_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    risk_block_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)


class OrgGrowthSettingsOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    posting_mode: str
    approval_required: bool
    daily_content_piece_limit: int
    daily_engagement_limit: int
    free_post_generations_used: int
    free_image_generations_used: int
    free_generation_period_month: Optional[datetime]
    max_connected_platforms: int
    plan_key: str
    engagement_plan_key: Optional[str]
    timezone: str
    posting_windows_json: Optional[dict[str, Any]]
    platform_distribution_json: Optional[dict[str, Any]]
    engagement_targets_json: Optional[dict[str, Any]]
    auto_engagement_enabled: bool
    auto_safe_threshold: Optional[float]
    risk_block_threshold: Optional[float]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
