"""
Carousel template — 5 × 1080×1080 slides.

Narrative structure (from roadmap spec §3.10):
  Slide 1 — hook           (opening statement / tension)
  Slide 2 — problem        (why this matters / what breaks)
  Slide 3 — insight        (key operational observation)
  Slide 4 — framework      (concrete application / framework)
  Slide 5 — takeaway + CTA (actionable close)

Each slide:
  ┌──────────────────────────────────────────────────────┐
  │  [slide_number / 5]  accent color, top-right         │
  │                                                      │
  │  [slide_label] — small ALL CAPS, muted, top-left     │
  │                                                      │
  │  [HEADLINE] — large bold, centered vertically        │
  │                                                      │
  │  [body text] — medium, muted, below headline         │
  │                                                      │
  │                                          [logo]      │
  └──────────────────────────────────────────────────────┘

Slide 1 also has an accent bar at top for visual entry point.

Input spec (from image_spec_json.slides):
  List of 5 dicts: {slide_no, headline, body}
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
    place_logo,
)
from app.services.image_builder.text_engine import (
    draw_text_block,
    get_font,
    measure_block,
    scale_font_to_fit,
    wrap_text,
)

SLIDE_LABELS = {
    1: "HOOK",
    2: "PROBLEM",
    3: "INSIGHT",
    4: "FRAMEWORK",
    5: "TAKEAWAY",
}

TOTAL_SLIDES = 5


async def render_carousel(
    slides: list[dict],
    brand_name: str,
    palette: BrandPalette,
    logo_url: Optional[str] = None,
) -> list[bytes]:
    """
    Render all 5 carousel slides and return list of PNG bytes.

    Args:
        slides:     List of {slide_no, headline, body} dicts (exactly 5)
        brand_name: Used as footer text
        palette:    Resolved brand palette
        logo_url:   Optional logo URL (composited bottom-right)

    Returns:
        List of 5 PNG bytes (same order as input slides)
    """
    # Normalise — ensure exactly 5 slides in order
    slide_map: dict[int, dict] = {}
    for s in slides:
        n = int(s.get("slide_no", 0))
        if 1 <= n <= TOTAL_SLIDES:
            slide_map[n] = s

    result: list[bytes] = []
    for i in range(1, TOTAL_SLIDES + 1):
        slide_data = slide_map.get(i, {"slide_no": i, "headline": "", "body": ""})
        slide_bytes = await _render_slide(
            slide_no=i,
            headline=str(slide_data.get("headline", "")),
            body=str(slide_data.get("body", "")),
            brand_name=brand_name,
            palette=palette,
            logo_url=logo_url if i == TOTAL_SLIDES else None,  # logo only on last slide
        )
        result.append(slide_bytes)

    return result


async def _render_slide(
    slide_no: int,
    headline: str,
    body: str,
    brand_name: str,
    palette: BrandPalette,
    logo_url: Optional[str],
) -> bytes:
    canvas = create_canvas(palette, gradient=True)
    draw = ImageDraw.Draw(canvas)

    if slide_no == 1:
        add_accent_bar(canvas, palette, position="top", thickness=8)

    # ── Slide number counter (top-right) ────────────────────────────────────
    counter_font = get_font(size=28, bold=True)
    counter_text = f"{slide_no}/{TOTAL_SLIDES}"
    draw.text(
        (CANVAS_SIZE - PADDING - 80, PADDING),
        counter_text,
        font=counter_font,
        fill=palette.accent,
    )

    # ── Slide label (top-left, small ALL CAPS) ───────────────────────────────
    label = SLIDE_LABELS.get(slide_no, "")
    if label:
        label_font = get_font(size=22, bold=False)
        draw.text((PADDING, PADDING + 10), label, font=label_font, fill=palette.text_muted)

    # ── Headline — centered in upper 55% ─────────────────────────────────────
    max_w = CANVAS_SIZE - (PADDING * 2)
    headline_zone_top    = PADDING + 80
    headline_zone_bottom = int(CANVAS_SIZE * 0.58)
    headline_max_h       = headline_zone_bottom - headline_zone_top

    headline_font, headline_lines = scale_font_to_fit(
        text=headline or label,
        max_width=max_w,
        max_height=headline_max_h,
        bold=True,
        max_size=72,
        min_size=28,
    )

    _, block_h = measure_block(headline_lines, headline_font)
    y_headline = headline_zone_top + (headline_max_h - block_h) // 2

    y_after_headline = draw_text_block(
        draw=draw,
        lines=headline_lines,
        font=headline_font,
        color=palette.text_light,
        canvas_width=CANVAS_SIZE,
        y_start=y_headline,
        align="center",
        line_spacing=1.2,
    )

    # ── Body text — below headline ────────────────────────────────────────────
    if body:
        body_top = max(y_after_headline + 30, int(CANVAS_SIZE * 0.60))
        body_max_h = CANVAS_SIZE - body_top - 100
        body_font = get_font(size=34, bold=False)
        body_lines = wrap_text(body, body_font, max_width=max_w)

        # Truncate if body is too long for the space
        while body_lines:
            _, bh = measure_block(body_lines, body_font)
            if bh <= body_max_h:
                break
            body_lines = body_lines[:-1]
            if body_lines:
                body_lines[-1] = body_lines[-1].rstrip() + "…"

        draw_text_block(
            draw=draw,
            lines=body_lines,
            font=body_font,
            color=palette.text_muted,
            canvas_width=CANVAS_SIZE,
            y_start=body_top,
            align="center",
            line_spacing=1.35,
        )

    # ── Brand name (bottom, small) ────────────────────────────────────────────
    brand_font = get_font(size=22, bold=False)
    brand_lines = wrap_text(brand_name, brand_font, max_width=max_w)
    draw_text_block(
        draw=draw,
        lines=brand_lines[:1],
        font=brand_font,
        color=palette.text_muted,
        canvas_width=CANVAS_SIZE,
        y_start=CANVAS_SIZE - 65,
        align="center",
    )

    await place_logo(canvas, logo_url, anchor="bottom_right")

    return canvas_to_bytes(canvas)
