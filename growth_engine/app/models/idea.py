"""
Pydantic models for content ideas and authority ladders.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

IdeaStatus = Literal[
    "generated", "ready", "queued", "published",
    "rejected", "archived", "needs_review", "failed",
]


class ContentIdeaOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    source: str
    pillar: str
    topic: str
    angle: str
    hook_seed: str
    score: float
    status: IdeaStatus
    planned_for: Optional[date]
    authority_ladder_id: Optional[uuid.UUID]
    ladder_level: Optional[int]
    hook_candidates_json: Optional[Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class ContentIdeaListResponse(BaseModel):
    ideas: list[ContentIdeaOut]
    total: int


class GenerateIdeasRequest(BaseModel):
    n: int = Field(default=10, ge=1, le=30)
    planned_for: Optional[date] = None


class GenerateVariantsRequest(BaseModel):
    """Trigger pipeline generation for a specific idea."""
    prompt_version: str = Field(default="v1", max_length=20)


# ── Authority Ladder models ────────────────────────────────────────────────────

LadderStatus = Literal["active", "paused", "completed", "archived"]


class AuthorityLadderCreate(BaseModel):
    theme: str = Field(..., min_length=3, max_length=200)


class AuthorityLadderOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    theme: str
    current_level: int
    completed_levels: list[int]
    status: LadderStatus
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GenerateLadderLevelRequest(BaseModel):
    planned_for: Optional[date] = None
