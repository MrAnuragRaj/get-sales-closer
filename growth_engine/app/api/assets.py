"""
Assets API — image generation and asset management.

Routes:
  GET    /growth/assets                          — list assets for the org
  GET    /growth/assets/{id}                     — fetch a single asset
  POST   /growth/drafts/{variant_id}/assets      — generate image for variant
  POST   /growth/drafts/{variant_id}/assets/all  — generate all platform templates
  PATCH  /growth/drafts/{variant_id}/image-spec  — edit image text spec
  DELETE /growth/assets/{id}                     — delete asset record + storage

The generate routes are mounted under /drafts (not /assets) because they are
operations on a specific variant — this keeps the URL hierarchy logical:
  /growth/drafts/{id}/assets  → generate assets for this draft
  /growth/assets/{id}         → manage an already-rendered asset
"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status

import asyncpg

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.asset import (
    AssetListResponse,
    AssetResultOut,
    ContentAssetOut,
    GenerateAllAssetsRequest,
    GenerateAssetRequest,
    ImageSpecEditRequest,
)
from app.services import brand_brain
from app.services.image_pipeline import run_all_templates, run_image_pipeline

router = APIRouter(tags=["assets"])
variant_asset_router = APIRouter(tags=["assets"])


# ── Asset management routes ────────────────────────────────────────────────────

@router.get("/assets", response_model=AssetListResponse)
async def list_assets(
    variant_id: uuid.UUID | None = None,
    asset_type: str | None = None,
    active_only: bool = True,
    limit: int = 50,
    offset: int = 0,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    where = "WHERE org_id = $1"
    params: list = [auth.org_id]

    if variant_id:
        where += f" AND variant_id = ${len(params)+1}"
        params.append(variant_id)
    if asset_type:
        where += f" AND asset_type = ${len(params)+1}"
        params.append(asset_type)
    if active_only:
        where += " AND is_active = true"

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, org_id, variant_id, asset_type, storage_path,
                   mime_type, width, height, template_name,
                   slide_index, is_active, meta_json, created_at
            FROM growth.content_assets
            {where}
            ORDER BY created_at DESC
            LIMIT ${len(params)+1} OFFSET ${len(params)+2}
            """,
            *params,
            limit,
            offset,
        )
        count_row = await conn.fetchrow(
            f"SELECT COUNT(*) FROM growth.content_assets {where}",
            *params,
        )

    assets = [ContentAssetOut.model_validate(dict(r)) for r in rows]
    return AssetListResponse(assets=assets, total=count_row["count"])


@router.get("/assets/{asset_id}", response_model=ContentAssetOut)
async def get_asset(
    asset_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, variant_id, asset_type, storage_path,
                   mime_type, width, height, template_name,
                   slide_index, is_active, meta_json, created_at
            FROM growth.content_assets
            WHERE id = $1 AND org_id = $2
            """,
            asset_id,
            auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return ContentAssetOut.model_validate(dict(row))


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Delete the DB record. Storage file cleanup is handled by a separate sweep job."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM growth.content_assets WHERE id = $1 AND org_id = $2",
            asset_id,
            auth.org_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Asset not found")


# ── Generation routes (mounted under /drafts/{variant_id}) ─────────────────────

@variant_asset_router.post(
    "/drafts/{variant_id}/assets",
    response_model=AssetResultOut,
    status_code=status.HTTP_201_CREATED,
)
async def generate_asset(
    variant_id: uuid.UUID,
    body: GenerateAssetRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Generate one image template for a variant.
    Saves image_spec_json to variant and returns the asset URL.
    """
    brand = await brand_brain.get_brand_profile(pool, auth.org_id)
    if not brand:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Brand profile required. POST /growth/brand first.",
        )

    # If force_regenerate, clear the existing spec entry for this template
    if body.force_regenerate:
        await _clear_spec_entry(pool, variant_id, body.template_name)

    result = await run_image_pipeline(
        pool=pool,
        org_id=auth.org_id,
        brand=brand,
        variant_id=variant_id,
        template_name=body.template_name,
    )

    return AssetResultOut(
        asset_id=result.asset_id,
        public_url=result.public_url,
        template_name=result.template_name,
        asset_type=result.asset_type,
        variant_id=result.variant_id,
        error=result.error,
        succeeded=result.succeeded,
    )


@variant_asset_router.post(
    "/drafts/{variant_id}/assets/all",
    response_model=list[AssetResultOut],
    status_code=status.HTTP_201_CREATED,
)
async def generate_all_assets(
    variant_id: uuid.UUID,
    body: GenerateAllAssetsRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Generate all platform-appropriate templates for this variant.
    Returns one AssetResultOut per template.
    """
    brand = await brand_brain.get_brand_profile(pool, auth.org_id)
    if not brand:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Brand profile required. POST /growth/brand first.",
        )

    results = await run_all_templates(
        pool=pool,
        org_id=auth.org_id,
        brand=brand,
        variant_id=variant_id,
        platform=body.platform,
    )

    return [
        AssetResultOut(
            asset_id=r.asset_id,
            public_url=r.public_url,
            template_name=r.template_name,
            asset_type=r.asset_type,
            variant_id=r.variant_id,
            error=r.error,
            succeeded=r.succeeded,
        )
        for r in results
    ]


@variant_asset_router.patch("/drafts/{variant_id}/image-spec", response_model=dict)
async def edit_image_spec(
    variant_id: uuid.UUID,
    body: ImageSpecEditRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Update the image text spec for a specific template on a variant.
    After editing, re-call POST /drafts/{id}/assets to re-render.
    Returns the updated full image_spec_json.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT image_spec_json FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id,
            auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Variant not found")

    existing = row["image_spec_json"] or {}
    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except Exception:
            existing = {}

    existing[body.template_name] = body.spec

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE growth.content_variants SET image_spec_json = $1::jsonb WHERE id = $2",
            json.dumps(existing),
            variant_id,
        )

    return existing


# ── Helper ─────────────────────────────────────────────────────────────────────

async def _clear_spec_entry(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    template_name: str,
) -> None:
    """Remove a template entry from image_spec_json so it is regenerated."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.content_variants
            SET image_spec_json = image_spec_json - $1
            WHERE id = $2
            """,
            template_name,
            variant_id,
        )
