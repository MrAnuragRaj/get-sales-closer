"""
Asset storage — Supabase Storage upload + growth.content_assets DB record.

Storage path format (deterministic, locked):
  growth/{org_id}/{variant_id}/{template_name}/{filename}.png

  Single-image templates (quote_card, stat_card, single_visual):
    growth/{org_id}/{variant_id}/{template_name}/active.png

  Carousel slides:
    growth/{org_id}/{variant_id}/carousel_5/slide_{n}.png

  Using a deterministic path (not UUID-based) means:
    - x-upsert:true on Supabase Storage overwrites the previous file
    - Re-renders replace the old file in-place
    - The storage path doubles as a stable reference for caching/CDN

is_active rule (locked):
  On every upload_and_record():
    1. All existing rows for (variant_id, template_name, slide_index) are
       set is_active=false
    2. New row is inserted with is_active=true

  This guarantees: at most ONE is_active=true row per (variant_id, template_name, slide_index).

  Active asset query:
    SELECT * FROM growth.content_assets
    WHERE variant_id = $1 AND template_name = $2 AND is_active = true
    ORDER BY created_at DESC LIMIT 1

Public URL policy:
  All assets are public-read (no PII in social content images).
  public_url() returns .../storage/v1/object/public/... — no token required.
  Decision is intentional for v1.

Bucket: growth-assets
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg
import httpx

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

STORAGE_BUCKET = "growth-assets"
MIME_PNG = "image/png"


def build_storage_path(
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    template_name: str,
    slide_index: Optional[int] = None,
) -> str:
    """
    Build the deterministic storage path for an asset.

    Single-image:  growth/{org_id}/{variant_id}/{template_name}/active.png
    Carousel slide: growth/{org_id}/{variant_id}/{template_name}/slide_{n}.png
    """
    if slide_index is not None:
        filename = f"slide_{slide_index}.png"
    else:
        filename = "active.png"
    return f"growth/{org_id}/{variant_id}/{template_name}/{filename}"


def public_url(storage_path: str) -> str:
    """
    Return the Supabase public URL for a storage path.

    These URLs are publicly accessible (no auth token required).
    Policy: intentional for v1 — social content images contain no PII.
    """
    return (
        f"{settings.supabase_url}/storage/v1/object/public/"
        f"{STORAGE_BUCKET}/{storage_path}"
    )


async def upload_asset(
    storage_path: str,
    png_bytes: bytes,
) -> None:
    """
    Upload PNG bytes to Supabase Storage at the given path.
    Uses x-upsert:true — overwrites if the path already exists.
    Raises on HTTP error.
    """
    url = f"{settings.supabase_url}/storage/v1/object/{STORAGE_BUCKET}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type":  MIME_PNG,
        "x-upsert":      "true",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, content=png_bytes, headers=headers)

    if resp.status_code not in (200, 201):
        log.error(
            "asset_upload_failed",
            status=resp.status_code,
            path=storage_path,
            body=resp.text[:200],
        )
        resp.raise_for_status()

    log.info("asset_uploaded", path=storage_path, size_bytes=len(png_bytes))


async def upload_and_record(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: Optional[uuid.UUID],
    asset_type: str,
    template_name: str,
    png_bytes: bytes,
    slide_index: Optional[int] = None,
    meta_json: Optional[dict] = None,
) -> tuple[uuid.UUID, str]:
    """
    Upload PNG and create an is_active=true asset record.

    Before inserting, deactivates all prior rows for the same
    (variant_id, template_name, slide_index). This enforces the
    single-active-asset-per-slot invariant.

    Returns (asset_id, public_url).
    """
    if variant_id is None:
        raise ValueError("variant_id is required for asset storage")

    storage_path = build_storage_path(org_id, variant_id, template_name, slide_index)

    # 1. Upload to storage (overwrites previous file at same path)
    await upload_asset(storage_path, png_bytes)

    # 2. Deactivate old records for this slot, then insert new active record
    import json
    meta_str = json.dumps(meta_json) if meta_json else None

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Deactivate all prior rows for this slot
            await conn.execute(
                """
                UPDATE growth.content_assets
                SET is_active = false
                WHERE variant_id   = $1
                  AND template_name = $2
                  AND (slide_index IS NOT DISTINCT FROM $3)
                  AND is_active = true
                """,
                variant_id,
                template_name,
                slide_index,
            )

            # Insert new active record
            row = await conn.fetchrow(
                """
                INSERT INTO growth.content_assets (
                    org_id, variant_id, asset_type, storage_path,
                    mime_type, width, height, template_name,
                    slide_index, is_active, meta_json
                ) VALUES (
                    $1, $2, $3, $4,
                    $5, $6, $7, $8,
                    $9, true, $10::jsonb
                )
                RETURNING id
                """,
                org_id,
                variant_id,
                asset_type,
                storage_path,
                MIME_PNG,
                1080,
                1080,
                template_name,
                slide_index,
                meta_str,
            )

    asset_id = row["id"]
    asset_url = public_url(storage_path)
    log.info(
        "asset_record_saved",
        asset_id=str(asset_id),
        variant_id=str(variant_id),
        template=template_name,
        slide=slide_index,
        path=storage_path,
    )
    return asset_id, asset_url


async def get_active_asset(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    template_name: str,
    slide_index: Optional[int] = None,
) -> Optional[dict]:
    """
    Return the current active asset for a variant+template+slot, or None.
    Used by publish_queue to look up the asset to attach.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, variant_id, asset_type, storage_path,
                   mime_type, width, height, template_name,
                   slide_index, is_active, meta_json, created_at
            FROM growth.content_assets
            WHERE variant_id    = $1
              AND template_name  = $2
              AND (slide_index IS NOT DISTINCT FROM $3)
              AND is_active = true
            ORDER BY created_at DESC
            LIMIT 1
            """,
            variant_id,
            template_name,
            slide_index,
        )
    return dict(row) if row else None
