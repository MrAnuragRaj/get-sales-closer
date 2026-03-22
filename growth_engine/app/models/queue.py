"""
Pydantic models for the publish queue and publish logs.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel

QueueStatus = Literal[
    "pending", "locked", "published", "failed",
    "blocked_quota", "blocked_auth", "blocked_approval", "cancelled",
]

Platform = Literal["linkedin", "facebook", "instagram", "x"]


class QueueItemOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    platform: Platform
    variant_id: uuid.UUID
    asset_id: Optional[uuid.UUID]
    idempotency_key: str
    status: QueueStatus
    attempt_count: int
    max_attempts: int
    scheduled_for: datetime
    locked_by: Optional[str]
    locked_until: Optional[datetime]
    last_error: Optional[str]
    published_platform_id: Optional[str]
    published_url: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class QueueListResponse(BaseModel):
    items: list[QueueItemOut]
    total: int


class EnqueueRequest(BaseModel):
    """
    Enqueue a variant for publishing.

    scheduled_for defaults to NOW() if not provided (immediate).
    max_attempts defaults to 5.
    asset_id is optional — publish queue will auto-select active asset if omitted.
    """
    variant_id: uuid.UUID
    platform: Platform
    scheduled_for: Optional[datetime] = None
    max_attempts: int = 5
    asset_id: Optional[uuid.UUID] = None


class PublishLogOut(BaseModel):
    id: uuid.UUID
    queue_id: uuid.UUID
    org_id: uuid.UUID
    platform: str
    http_status: Optional[int]
    success: bool
    request_json: Optional[Any]
    response_json: Optional[Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class PublishLogListResponse(BaseModel):
    logs: list[PublishLogOut]
    total: int
