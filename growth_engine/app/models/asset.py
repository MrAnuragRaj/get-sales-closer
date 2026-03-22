"""
Pydantic models for content assets (rendered images).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

AssetType = Literal[
    "quote_card", "stat_card", "carousel_slide",
    "single_visual", "thumbnail",
]

TemplateName = Literal["quote_card", "stat_card", "carousel_5", "single_visual"]


class ContentAssetOut(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    variant_id: Optional[uuid.UUID]
    asset_type: str
    storage_path: str
    mime_type: str
    width: Optional[int]
    height: Optional[int]
    template_name: Optional[str]
    slide_index: Optional[int]       # None for single-image; 1–5 for carousel
    is_active: bool                  # True = current rendition for this slot
    meta_json: Optional[Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class AssetListResponse(BaseModel):
    assets: list[ContentAssetOut]
    total: int


class GenerateAssetRequest(BaseModel):
    """Trigger image generation for a variant."""
    template_name: TemplateName
    force_regenerate: bool = Field(
        default=False,
        description="If True, regenerate spec even if image_spec_json already has this template",
    )


class GenerateAllAssetsRequest(BaseModel):
    """Generate all platform-appropriate templates for a variant."""
    platform: str = Field(..., description="Platform determines which templates to render")


class ImageSpecEditRequest(BaseModel):
    """
    User edit of the image text spec before re-rendering.
    Only the provided template_name sub-object is updated.
    """
    template_name: TemplateName
    spec: dict = Field(..., description="Updated spec dict for this template")


class AssetResultOut(BaseModel):
    asset_id: uuid.UUID
    public_url: str
    template_name: str
    asset_type: str
    variant_id: Optional[uuid.UUID]
    error: Optional[str]
    succeeded: bool
