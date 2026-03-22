"""
Pydantic models for content variants (drafts) and pipeline results.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel

VariantStatus = Literal[
    "draft", "approved", "needs_review",
    "queued", "published", "rejected", "failed",
]

CriticDecision = Literal["approve", "revise", "force_approved"]

PostingMode = Literal["auto", "approval", "suggestion_only"]

ApprovalEventType = Literal[
    "auto_queued", "human_approved", "force_approved",
    "human_queued", "rejected", "edited",
    "queue_cancelled", "mode_snapshot",
]


class ContentVariantOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    idea_id: uuid.UUID
    platform: str
    status: VariantStatus
    body_text: str
    original_body_text: Optional[str]

    # Lineage columns
    angle_type: Optional[str]
    angle_title: Optional[str]
    core_claim: Optional[str]
    hook_text: Optional[str]
    hook_rank: Optional[int]
    prompt_version: Optional[str]
    generation_attempt: int

    # Critic output
    critic_decision: Optional[CriticDecision]
    critic_scores_json: Optional[Any]
    revision_brief: Optional[str]

    # Approval tracking (Phase 5)
    approved_by: Optional[uuid.UUID]
    approved_at: Optional[datetime]
    queued_at: Optional[datetime]
    scheduled_publish_at: Optional[datetime]

    is_user_edited: bool
    finalized_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


class ApprovalEventOut(BaseModel):
    """One entry in the approval audit trail for a variant."""
    id: uuid.UUID
    variant_id: uuid.UUID
    org_id: uuid.UUID
    event_type: ApprovalEventType
    actor_user_id: Optional[uuid.UUID]
    mode_at_event: PostingMode
    variant_status_before: Optional[str]
    variant_status_after: Optional[str]
    notes: Optional[str]
    metadata: Optional[Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class ContentVariantListResponse(BaseModel):
    variants: list[ContentVariantOut]
    total: int


class PipelineResultOut(BaseModel):
    """API response shape for a pipeline run result."""
    idea_id: uuid.UUID
    platform: str
    variant_id: Optional[uuid.UUID]
    status: str
    critic_decision: Optional[str]
    generation_attempts: int
    angle_type: str
    angle_title: str
    hook_text: str
    hook_score: float
    error: Optional[str]
    succeeded: bool


class VariantApproveRequest(BaseModel):
    """Force-approve a variant that is in needs_review state."""
    pass   # no body required — the action is in the URL


class VariantEditRequest(BaseModel):
    """User edit of a variant body."""
    body_text: str
