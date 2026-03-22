"""
Image pipeline orchestrator.

For a given content variant, generates image text spec via LLM,
renders the appropriate template via Pillow, uploads to Supabase Storage,
and saves a record to growth.content_assets.

Template selection:
  The caller specifies which template to render.
  All templates for a variant can be requested in one call via run_all_templates().

  Templates per platform:
    linkedin:  quote_card, stat_card, single_visual
    instagram: quote_card, carousel_5, single_visual
    facebook:  quote_card, stat_card
    x:         single_visual (only when X is active)

  Caller can override this by requesting a specific template_name.

image_spec_json is saved to content_variants after generation so users can
edit the visual text before the image is rendered.

The render step can be re-run after a spec edit without re-running the LLM step.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.brand import BrandProfileOut
from app.openai_client import PLANNER_MODEL, chat_completion
from app.prompts.image_prompts import (
    build_carousel_prompt,
    build_image_system_prompt,
    build_quote_card_prompt,
    build_single_visual_prompt,
    build_stat_card_prompt,
)
from app.services.image_builder.asset_storage import upload_and_record
from app.services.image_builder.brand_palette import resolve_palette
from app.services.image_builder.carousel import render_carousel
from app.services.image_builder.quote_card import render_quote_card
from app.services.image_builder.single_visual import render_single_visual
from app.services.image_builder.stat_card import render_stat_card

log = get_logger(__name__)

# Templates available per platform (in preferred order)
PLATFORM_TEMPLATES: dict[str, list[str]] = {
    "linkedin":  ["quote_card", "stat_card", "single_visual"],
    "instagram": ["quote_card", "carousel_5", "single_visual"],
    "facebook":  ["quote_card", "stat_card"],
    "x":         ["single_visual"],
}


@dataclass
class AssetResult:
    asset_id: uuid.UUID
    public_url: str
    template_name: str
    asset_type: str
    variant_id: Optional[uuid.UUID]
    error: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        return self.error is None


async def run_image_pipeline(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    variant_id: uuid.UUID,
    template_name: str,
) -> AssetResult:
    """
    Generate image spec → render → upload → record for one template.

    Returns AssetResult. Never raises — errors are captured in result.error.
    """
    # Fetch variant for topic/angle/claim context
    variant = await _fetch_variant(pool, org_id, variant_id)
    if not variant:
        return _error_asset(variant_id, template_name, "variant_not_found")

    # Step 1: Generate text spec via LLM (or load existing spec if already set)
    spec = await _get_or_generate_spec(
        pool=pool,
        org_id=org_id,
        variant_id=variant_id,
        variant=variant,
        brand=brand,
        template_name=template_name,
    )
    if not spec:
        return _error_asset(variant_id, template_name, "spec_generation_failed")

    # Step 2: Render
    palette = resolve_palette(brand.tone_json, brand.offer_json)
    logo_url = _extract_logo_url(brand)

    try:
        png_bytes_list = await _render(
            template_name=template_name,
            spec=spec,
            brand=brand,
            palette=palette,
            logo_url=logo_url,
        )
    except Exception as exc:
        log.error("image_render_failed", template=template_name, error=str(exc))
        return _error_asset(variant_id, template_name, f"render_failed: {exc}")

    # Step 3: Upload + record (carousel = multiple assets)
    return await _store_assets(
        pool=pool,
        org_id=org_id,
        variant_id=variant_id,
        template_name=template_name,
        png_bytes_list=png_bytes_list,
        spec=spec,
    )


async def run_all_templates(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    brand: BrandProfileOut,
    variant_id: uuid.UUID,
    platform: str,
) -> list[AssetResult]:
    """
    Run all platform-appropriate templates for a variant.
    Returns one AssetResult per template (carousel counts as one result).
    """
    templates = PLATFORM_TEMPLATES.get(platform, ["single_visual"])
    results = []
    for template in templates:
        result = await run_image_pipeline(
            pool=pool,
            org_id=org_id,
            brand=brand,
            variant_id=variant_id,
            template_name=template,
        )
        results.append(result)
    return results


# ── Spec generation ────────────────────────────────────────────────────────────

async def _get_or_generate_spec(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    variant: dict,
    brand: BrandProfileOut,
    template_name: str,
) -> Optional[dict]:
    """
    Return existing image_spec_json[template_name] if present,
    otherwise call LLM to generate it, save to variant, and return.
    """
    existing = variant.get("image_spec_json") or {}
    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except Exception:
            existing = {}

    if template_name in existing:
        log.info("image_spec_cache_hit", variant_id=str(variant_id), template=template_name)
        return existing[template_name]

    # Generate
    spec = await _generate_spec(variant=variant, brand=brand, template_name=template_name)
    if not spec:
        return None

    # Save spec to variant
    existing[template_name] = spec
    await _save_image_spec(pool, variant_id, existing)
    return spec


async def _generate_spec(variant: dict, brand: BrandProfileOut, template_name: str) -> Optional[dict]:
    """Call LLM to generate image text spec for the given template."""
    topic       = variant.get("topic") or ""
    angle_title = variant.get("angle_title") or ""
    core_claim  = variant.get("core_claim") or ""
    proof_point = _extract_str(brand.proof_points_json, "primary", "")
    audience    = _extract_str(brand.audience_json, "description", "B2B decision makers")

    if template_name == "quote_card":
        prompt = build_quote_card_prompt(core_claim, angle_title, brand.brand_name)
    elif template_name == "stat_card":
        prompt = build_stat_card_prompt(topic, core_claim, proof_point)
    elif template_name == "carousel_5":
        prompt = build_carousel_prompt(topic, angle_title, core_claim, brand.brand_name, audience)
    elif template_name == "single_visual":
        prompt = build_single_visual_prompt(topic, angle_title, core_claim)
    else:
        log.error("unknown_template_name", template=template_name)
        return None

    log.info("image_spec_generate_started", template=template_name, topic=topic[:60])

    raw = await chat_completion(
        messages=[
            {"role": "system", "content": build_image_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        model=PLANNER_MODEL,
        temperature=0.5,    # low — image text should be consistent
        max_tokens=800,
    )

    return _parse_spec_json(raw, template_name)


def _parse_spec_json(raw: str, template_name: str) -> Optional[dict]:
    raw = raw.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    log.error("image_spec_parse_failed", template=template_name, raw=raw[:200])
    return None


# ── Rendering dispatch ─────────────────────────────────────────────────────────

async def _render(
    template_name: str,
    spec: dict,
    brand: BrandProfileOut,
    palette,
    logo_url: Optional[str],
) -> list[bytes]:
    """Render template and return list of PNG bytes (list of 1 for non-carousel)."""
    if template_name == "quote_card":
        png = await render_quote_card(
            headline_text=spec.get("headline_text", ""),
            brand_name=brand.brand_name,
            palette=palette,
            logo_url=logo_url,
            subtext=spec.get("subtext"),
        )
        return [png]

    elif template_name == "stat_card":
        png = await render_stat_card(
            headline_text=spec.get("headline_text", ""),
            brand_name=brand.brand_name,
            palette=palette,
            logo_url=logo_url,
            supporting_text=spec.get("supporting_text"),
        )
        return [png]

    elif template_name == "carousel_5":
        slides = spec.get("slides", [])
        return await render_carousel(
            slides=slides,
            brand_name=brand.brand_name,
            palette=palette,
            logo_url=logo_url,
        )

    elif template_name == "single_visual":
        png = await render_single_visual(
            topic=spec.get("topic_label", ""),
            headline=spec.get("headline", ""),
            core_claim=spec.get("core_claim_display", ""),
            brand_name=brand.brand_name,
            palette=palette,
            logo_url=logo_url,
        )
        return [png]

    else:
        raise ValueError(f"Unknown template: {template_name}")


# ── Storage ────────────────────────────────────────────────────────────────────

async def _store_assets(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    template_name: str,
    png_bytes_list: list[bytes],
    spec: dict,
) -> AssetResult:
    """
    Upload all rendered images and record them. Return result for first/primary.

    Path rule:
      Single-image: growth/{org_id}/{variant_id}/{template_name}/active.png
      Carousel:     growth/{org_id}/{variant_id}/{template_name}/slide_{n}.png

    is_active rule: prior rows for the same slot are deactivated before insert.
    """
    primary_asset_id = None
    primary_url = None
    is_carousel = len(png_bytes_list) > 1

    for i, png_bytes in enumerate(png_bytes_list):
        asset_type  = "carousel_slide" if is_carousel else template_name
        slide_index = (i + 1) if is_carousel else None
        meta        = {"spec": spec, "slide": slide_index} if is_carousel else {"spec": spec}

        asset_id, url = await upload_and_record(
            pool=pool,
            org_id=org_id,
            variant_id=variant_id,
            asset_type=asset_type,
            template_name=template_name,
            png_bytes=png_bytes,
            slide_index=slide_index,
            meta_json=meta,
        )
        if i == 0:
            primary_asset_id = asset_id
            primary_url = url

    return AssetResult(
        asset_id=primary_asset_id,
        public_url=primary_url,
        template_name=template_name,
        asset_type=template_name,
        variant_id=variant_id,
    )


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def _fetch_variant(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT cv.id, cv.platform, cv.body_text,
                   cv.angle_type, cv.angle_title, cv.core_claim,
                   cv.hook_text, cv.image_spec_json,
                   ci.topic, ci.pillar
            FROM growth.content_variants cv
            JOIN growth.content_ideas ci ON ci.id = cv.idea_id
            WHERE cv.id = $1 AND cv.org_id = $2
            """,
            variant_id,
            org_id,
        )
    return dict(row) if row else None


async def _save_image_spec(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    spec_dict: dict,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE growth.content_variants SET image_spec_json = $1::jsonb WHERE id = $2",
            json.dumps(spec_dict),
            variant_id,
        )


def _extract_str(json_blob: Optional[dict], key: str, default: str = "") -> str:
    if not json_blob:
        return default
    return str(json_blob.get(key, default))


def _extract_logo_url(brand: BrandProfileOut) -> Optional[str]:
    """Extract logo URL from brand keywords_json or offer_json if present."""
    for blob in [brand.offer_json, brand.keywords_json]:
        if blob and "logo_url" in blob:
            return str(blob["logo_url"])
    return None


def _error_asset(variant_id: Optional[uuid.UUID], template_name: str, error: str) -> AssetResult:
    return AssetResult(
        asset_id=uuid.uuid4(),
        public_url="",
        template_name=template_name,
        asset_type=template_name,
        variant_id=variant_id,
        error=error,
    )
