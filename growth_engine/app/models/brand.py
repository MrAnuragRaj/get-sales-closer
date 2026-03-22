"""
Pydantic models for Brand Profile API.

BrandProfileCreate  — POST body (create)
BrandProfileUpdate  — PUT body (partial update — all fields optional)
BrandProfileOut     — Response shape (no internal IDs exposed beyond org_id)

JSONB fields (tone_json, audience_json, etc.) are typed as dict[str, Any]
to allow flexible schema evolution without migration per field change.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class BrandProfileCreate(BaseModel):
    brand_name: str = Field(..., min_length=1, max_length=120)
    product_name: Optional[str] = None
    positioning: Optional[str] = None
    brand_summary: Optional[str] = None

    # JSONB bags — caller provides structured dicts
    tone_json: Optional[dict[str, Any]] = None
    audience_json: Optional[dict[str, Any]] = None
    offer_json: Optional[dict[str, Any]] = None
    cta_rules_json: Optional[dict[str, Any]] = None
    content_pillars_json: Optional[dict[str, Any]] = None
    forbidden_claims_json: Optional[dict[str, Any]] = None
    proof_points_json: Optional[dict[str, Any]] = None
    keywords_json: Optional[dict[str, Any]] = None
    competitors_json: Optional[dict[str, Any]] = None
    landing_pages_json: Optional[dict[str, Any]] = None

    default_timezone: str = Field("UTC", max_length=64)


class BrandProfileUpdate(BaseModel):
    """All fields optional — only provided fields are updated."""
    brand_name: Optional[str] = Field(None, min_length=1, max_length=120)
    product_name: Optional[str] = None
    positioning: Optional[str] = None
    brand_summary: Optional[str] = None
    tone_json: Optional[dict[str, Any]] = None
    audience_json: Optional[dict[str, Any]] = None
    offer_json: Optional[dict[str, Any]] = None
    cta_rules_json: Optional[dict[str, Any]] = None
    content_pillars_json: Optional[dict[str, Any]] = None
    forbidden_claims_json: Optional[dict[str, Any]] = None
    proof_points_json: Optional[dict[str, Any]] = None
    keywords_json: Optional[dict[str, Any]] = None
    competitors_json: Optional[dict[str, Any]] = None
    landing_pages_json: Optional[dict[str, Any]] = None
    default_timezone: Optional[str] = Field(None, max_length=64)


class BrandProfileOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    brand_name: str
    product_name: Optional[str]
    positioning: Optional[str]
    brand_summary: Optional[str]
    tone_json: Optional[dict[str, Any]]
    audience_json: Optional[dict[str, Any]]
    offer_json: Optional[dict[str, Any]]
    cta_rules_json: Optional[dict[str, Any]]
    content_pillars_json: Optional[dict[str, Any]]
    forbidden_claims_json: Optional[dict[str, Any]]
    proof_points_json: Optional[dict[str, Any]]
    keywords_json: Optional[dict[str, Any]]
    competitors_json: Optional[dict[str, Any]]
    landing_pages_json: Optional[dict[str, Any]]
    default_timezone: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
