"""
Pydantic models for the Engagement Engine (Phase 6).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

TargetType = Literal["profile", "company", "hashtag", "keyword"]
OpportunityType = Literal["comment", "reply"]  # likes/reposts disabled in v1
OpportunityStatus = Literal[
    "pending_review", "approved", "auto_approved",
    "rejected", "executed", "failed", "expired",
]
ActionStatus = Literal["success", "failed"]
EngagementPlan = Literal["engagement_starter", "engagement_pro", "none"]


# ── Engagement Targets ──────────────────────────────────────────────────────

class EngagementTargetCreate(BaseModel):
    platform: str
    target_type: TargetType
    target_identifier: str = Field(..., min_length=1, max_length=200)
    target_name: Optional[str] = None
    description: Optional[str] = None

    @field_validator("platform")
    @classmethod
    def validate_platform(cls, v: str) -> str:
        if v not in ("linkedin", "x", "instagram", "facebook"):
            raise ValueError(f"unsupported platform: {v}")
        return v


class EngagementTargetUpdate(BaseModel):
    target_name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class EngagementTargetOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    platform: str
    target_type: TargetType
    target_identifier: str
    target_name: Optional[str]
    description: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EngagementTargetListResponse(BaseModel):
    targets: list[EngagementTargetOut]
    total: int


# ── Engagement Opportunities ────────────────────────────────────────────────

class DiscoverRequest(BaseModel):
    """
    Request body for POST /engagement/targets/{id}/discover.

    In production this would trigger a platform API scan. For now it accepts
    a list of pre-fetched posts (e.g. from a webhook or a manual feed import).
    """
    posts: list[DiscoveredPost]


class DiscoveredPost(BaseModel):
    """Raw post data from a platform API or feed."""
    post_platform_id: str
    post_url: Optional[str] = None
    post_body: str
    author_platform_id: Optional[str] = None
    author_name: Optional[str] = None
    opportunity_type: OpportunityType = "comment"


class EngagementOpportunityOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    target_id: uuid.UUID
    platform: str
    opportunity_type: OpportunityType
    post_platform_id: str
    post_url: Optional[str]
    post_body_snippet: Optional[str]
    author_platform_id: Optional[str]
    author_name: Optional[str]
    confidence_score: float
    risk_score: float
    relevance_score: float
    status: OpportunityStatus
    rejection_reason: Optional[str]
    generated_action_text: Optional[str]
    generation_model: Optional[str]
    approved_by: Optional[uuid.UUID]
    approved_at: Optional[datetime]
    discovered_at: datetime
    scheduled_for: Optional[datetime]
    executed_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OpportunityListResponse(BaseModel):
    opportunities: list[EngagementOpportunityOut]
    total: int


class OpportunityApproveRequest(BaseModel):
    scheduled_for: Optional[datetime] = None


# ── Engagement Actions ──────────────────────────────────────────────────────

class EngagementActionOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    opportunity_id: uuid.UUID
    platform: str
    action_type: str
    action_text: Optional[str]
    platform_action_id: Optional[str]
    # Scores at execution time (denormalized for analytics)
    confidence_score: Optional[float]
    risk_score: Optional[float]
    # Approval context
    approval_status: Optional[str]   # auto_approved | human_approved
    actor_user_id: Optional[uuid.UUID]
    # Result
    status: ActionStatus
    http_status: Optional[int]
    error_message: Optional[str]
    executed_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


class ActionListResponse(BaseModel):
    actions: list[EngagementActionOut]
    total: int


# ── Daily Cap Status ────────────────────────────────────────────────────────

class CommercialCapStatus(BaseModel):
    used: int
    limit: int
    remaining: int


class SafetyCapStatus(BaseModel):
    platform: str
    action_type: str
    used: int
    limit: int
    remaining: int


class DailyCapsResponse(BaseModel):
    plan: EngagementPlan
    date: str
    commercial: CommercialCapStatus
    platform_safety: list[SafetyCapStatus]


# ── Scoring ─────────────────────────────────────────────────────────────────

class ScoringResult(BaseModel):
    confidence_score: float = Field(..., ge=0.0, le=1.0)
    risk_score: float = Field(..., ge=0.0, le=1.0)
    relevance_score: float = Field(..., ge=0.0, le=1.0)
    generated_action_text: str
    generation_model: str
