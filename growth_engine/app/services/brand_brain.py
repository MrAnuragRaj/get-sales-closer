"""
Brand Brain service — CRUD operations for growth.brand_profiles.

One brand profile per org (unique constraint on org_id).
The brand profile is the canonical identity used by all content generation
in Phase 2+. It must be set up before any content can be generated.

All DB access is raw asyncpg — no ORM.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileCreate, BrandProfileOut, BrandProfileUpdate

log = get_logger(__name__)


def _row_to_out(row: asyncpg.Record) -> BrandProfileOut:
    """Convert asyncpg Record to BrandProfileOut, parsing JSONB strings if needed."""
    data = dict(row)
    # asyncpg returns JSONB columns as already-parsed dicts in most drivers,
    # but handle string case defensively.
    jsonb_fields = [
        "tone_json", "audience_json", "offer_json", "cta_rules_json",
        "content_pillars_json", "forbidden_claims_json", "proof_points_json",
        "keywords_json", "competitors_json", "landing_pages_json",
    ]
    for field in jsonb_fields:
        val = data.get(field)
        if isinstance(val, str):
            data[field] = json.loads(val)

    return BrandProfileOut(**data)


async def get_brand_profile(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> Optional[BrandProfileOut]:
    """Return brand profile for org, or None if not yet created."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM growth.brand_profiles WHERE org_id = $1",
            org_id,
        )
    if row is None:
        return None
    return _row_to_out(row)


async def create_brand_profile(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    data: BrandProfileCreate,
) -> BrandProfileOut:
    """
    Create brand profile for org.
    Raises asyncpg.UniqueViolationError if one already exists.
    Caller (API layer) should catch and return HTTP 409.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.brand_profiles (
                org_id, brand_name, product_name, positioning, brand_summary,
                tone_json, audience_json, offer_json, cta_rules_json,
                content_pillars_json, forbidden_claims_json, proof_points_json,
                keywords_json, competitors_json, landing_pages_json,
                default_timezone
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
                $10::jsonb, $11::jsonb, $12::jsonb,
                $13::jsonb, $14::jsonb, $15::jsonb,
                $16
            )
            RETURNING *
            """,
            org_id,
            data.brand_name,
            data.product_name,
            data.positioning,
            data.brand_summary,
            json.dumps(data.tone_json) if data.tone_json is not None else None,
            json.dumps(data.audience_json) if data.audience_json is not None else None,
            json.dumps(data.offer_json) if data.offer_json is not None else None,
            json.dumps(data.cta_rules_json) if data.cta_rules_json is not None else None,
            json.dumps(data.content_pillars_json) if data.content_pillars_json is not None else None,
            json.dumps(data.forbidden_claims_json) if data.forbidden_claims_json is not None else None,
            json.dumps(data.proof_points_json) if data.proof_points_json is not None else None,
            json.dumps(data.keywords_json) if data.keywords_json is not None else None,
            json.dumps(data.competitors_json) if data.competitors_json is not None else None,
            json.dumps(data.landing_pages_json) if data.landing_pages_json is not None else None,
            data.default_timezone,
        )

    log.info("brand_profile_created", org_id=str(org_id))
    return _row_to_out(row)


async def update_brand_profile(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    data: BrandProfileUpdate,
) -> Optional[BrandProfileOut]:
    """
    Partial update of brand profile.
    Only fields explicitly set in data are updated.
    Returns None if no profile exists yet for the org.
    """
    # Build dynamic SET clause from non-None fields only
    updates: list[str] = []
    values: list[Any] = []
    idx = 1

    field_map: dict[str, tuple[str, bool]] = {
        # field_name: (column_name, is_jsonb)
        "brand_name":             ("brand_name", False),
        "product_name":           ("product_name", False),
        "positioning":            ("positioning", False),
        "brand_summary":          ("brand_summary", False),
        "tone_json":              ("tone_json", True),
        "audience_json":          ("audience_json", True),
        "offer_json":             ("offer_json", True),
        "cta_rules_json":         ("cta_rules_json", True),
        "content_pillars_json":   ("content_pillars_json", True),
        "forbidden_claims_json":  ("forbidden_claims_json", True),
        "proof_points_json":      ("proof_points_json", True),
        "keywords_json":          ("keywords_json", True),
        "competitors_json":       ("competitors_json", True),
        "landing_pages_json":     ("landing_pages_json", True),
        "default_timezone":       ("default_timezone", False),
    }

    for field_name, (col_name, is_jsonb) in field_map.items():
        val = getattr(data, field_name, None)
        if val is not None:
            if is_jsonb:
                updates.append(f"{col_name} = ${idx}::jsonb")
                values.append(json.dumps(val))
            else:
                updates.append(f"{col_name} = ${idx}")
                values.append(val)
            idx += 1

    if not updates:
        # Nothing to update — return current state
        return await get_brand_profile(pool, org_id)

    updates.append(f"updated_at = now()")
    values.append(org_id)

    query = f"""
        UPDATE growth.brand_profiles
        SET {', '.join(updates)}
        WHERE org_id = ${idx}
        RETURNING *
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *values)

    if row is None:
        return None

    log.info("brand_profile_updated", org_id=str(org_id), fields_updated=list(updates[:-1]))
    return _row_to_out(row)
