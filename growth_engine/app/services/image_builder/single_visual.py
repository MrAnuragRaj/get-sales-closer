"""
Single visual template — 1080×1080.

A clean text-heavy graphic for a single insight. Designed for posts where
the text IS the visual — no stock photo, no decorative noise.

Layout:
  ┌──────────────────────────────────────────────────────┐
  │ ████ accent bar (top, 8px)                           │
  │                                                      │
  │  [PILLAR / TOPIC LABEL] — small, accent, top-left    │
  │                                                      │
  │                                                      │
  │       [HEADLINE — angle_title, large bold]           │
  │             centered, upper-mid area                 │
  │                                                      │
  │  ──── divider ────                                    │
  │                                                      │
  │       [core claim — medium, muted, italics-feel]     │
  │                                                      │
  │  [brand_name, small, muted]            [logo]        │
  └──────────────────────────────────────────────────────┘

Input spec (from image_spec_json):
  topic:       str   — displayed as small label top-left
  headline:    str   — angle_title or post headline (max ~10 words)
  core_claim:  str   — 1-sentence core claim (displayed smaller below divider)
"""

from __future__ import annotations

from typing import Optional

from PIL import ImageDraw

from app.services.image_builder.brand_palette import BrandPalette
from app.services.image_builder.renderer import (
    CANVAS_SIZE,
    PADDING,
    add_accent_bar,
    canvas_to_bytes,
    create_canvas,
    draw_divider,
    place_logo,
)
from app.services.image_builder.text_engine import (
    draw_text_block,
    get_font,
    measure_block,
    scale_font_to_fit,
    wrap_text,
)


async def render_single_visual(
    topic: str,
    headline: str,
    core_claim: str,
    brand_name: str,
    palette: BrandPalette,
    logo_url: Optional[str] = None,
) -> bytes:
    """
    Render a single visual card and return PNG bytes.

    Args:
        topic:       Pillar / topic label (e.g. "Speed to Lead")
        headline:    Angle title — the main visual statement
        core_claim:  Supporting claim shown below divider
        brand_name:  Footer label
        palette:     Resolved brand palette
        logo_url:    Optional logo URL

    Returns:
        PNG bytes (1080×1080)
    """
    canvas = create_canvas(palette, gradient=True)
    draw = ImageDraw.Draw(canvas)

    add_accent_bar(canvas, palette, position="top", thickness=8)

    # ── Topic label (top-left, small, accent) ─────────────────────────────────
    topic_font = get_font(size=24, bold=True)
    topic_upper = topic.upper()
    draw.text((PADDING, PADDING + 30), topic_upper, font=topic_font, fill=palette.accent)

    # ── Headline (centered, large) ─────────────────────────────────────────────
    max_w = CANVAS_SIZE - (PADDING * 2)
    headline_zone_top    = PADDING + 100
    headline_zone_bottom = int(CANVAS_SIZE * 0.60)
    headline_max_h       = headline_zone_bottom - headline_zone_top

    headline_font, headline_lines = scale_font_to_fit(
        text=headline,
        max_width=max_w,
        max_height=headline_max_h,
        bold=True,
        max_size=80,
        min_size=28,
    )

    _, block_h = measure_block(headline_lines, headline_font)
    y_headline = headline_zone_top + (headline_max_h - block_h) // 2

    y_after = draw_text_block(
        draw=draw,
        lines=headline_lines,
        font=headline_font,
        color=palette.text_light,
        canvas_width=CANVAS_SIZE,
        y_start=y_headline,
        align="center",
        line_spacing=1.2,
    )

    # ── Divider ───────────────────────────────────────────────────────────────
    divider_y = max(y_after + 30, int(CANVAS_SIZE * 0.63))
    draw_divider(canvas, y=divider_y, palette=palette, x_margin=PADDING * 2)

    # ── Core claim ─────────────────────────────────────────────────────────────
    if core_claim:
        claim_zone_h = CANVAS_SIZE - divider_y - 100
        claim_font, claim_lines = scale_font_to_fit(
            text=core_claim,
            max_width=max_w,
            max_height=claim_zone_h,
            bold=False,
            max_size=36,
            min_size=22,
        )
        draw_text_block(
            draw=draw,
            lines=claim_lines,
            font=claim_font,
            color=palette.text_muted,
            canvas_width=CANVAS_SIZE,
            y_start=divider_y + 28,
            align="center",
            line_spacing=1.4,
        )

    # ── Brand name footer ─────────────────────────────────────────────────────
    brand_font = get_font(size=22, bold=False)
    brand_lines = wrap_text(brand_name, brand_font, max_width=max_w)
    draw_text_block(
        draw=draw,
        lines=brand_lines[:1],
        font=brand_font,
        color=palette.text_muted,
        canvas_width=CANVAS_SIZE,
        y_start=CANVAS_SIZE - 65,
        align="left",
    )

    await place_logo(canvas, logo_url, anchor="bottom_right")

    return canvas_to_bytes(canvas)
