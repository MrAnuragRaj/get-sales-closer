"""
Quote card template — 1080×1080.

Layout:
  ┌──────────────────────────────────────────────────────┐
  │ ████ accent bar (top, 8px)                           │
  │                                                      │
  │ "  (decorative open quote, top-left, muted)          │
  │                                                      │
  │       [HEADLINE TEXT — max 14 words, large bold]     │
  │              centered vertically in upper 70%        │
  │                                                      │
  │ ──── divider ────                                     │
  │                                                      │
  │       [subtext — optional, smaller, muted]           │
  │                                                      │
  │                                           [logo]     │
  └──────────────────────────────────────────────────────┘

Input spec (from image_spec_json / LLM output):
  headline_text: str   — main quote/claim (max 14 words)
  subtext: str | None  — optional attribution or supporting line
  brand_name: str      — shown as caption if no subtext
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
    draw_quote_mark,
    draw_text_block,
    scale_font_to_fit,
    get_font,
)


async def render_quote_card(
    headline_text: str,
    brand_name: str,
    palette: BrandPalette,
    logo_url: Optional[str] = None,
    subtext: Optional[str] = None,
) -> bytes:
    """
    Render a quote card and return PNG bytes.

    Args:
        headline_text: Main quote (should be ≤14 words — enforced by caller/LLM)
        brand_name:    Shown as footer if subtext is absent
        palette:       Resolved brand palette
        logo_url:      Optional URL for logo compositing
        subtext:       Optional attribution or supporting line

    Returns:
        PNG bytes (1080×1080)
    """
    canvas = create_canvas(palette, gradient=True)
    draw = ImageDraw.Draw(canvas)

    # Accent bar top
    add_accent_bar(canvas, palette, position="top", thickness=8)

    # Decorative open quote mark (top-left, large, muted)
    draw_quote_mark(draw, x=PADDING - 10, y=PADDING + 20, size=120, color=palette.text_muted)

    # ── Headline ──────────────────────────────────────────────────────────────
    # Available area: full width minus padding, upper 65% of canvas
    max_w = CANVAS_SIZE - (PADDING * 2)
    max_h = int(CANVAS_SIZE * 0.55)
    headline_font, headline_lines = scale_font_to_fit(
        text=headline_text,
        max_width=max_w,
        max_height=max_h,
        bold=True,
        max_size=88,
        min_size=28,
    )

    # Center the text block vertically in the upper 70%
    from app.services.image_builder.text_engine import measure_block
    _, block_h = measure_block(headline_lines, headline_font)
    y_center_zone = int(CANVAS_SIZE * 0.68)  # top 68% is the headline zone
    y_start = max(PADDING + 80, (y_center_zone - block_h) // 2)

    y_after_headline = draw_text_block(
        draw=draw,
        lines=headline_lines,
        font=headline_font,
        color=palette.text_light,
        canvas_width=CANVAS_SIZE,
        y_start=y_start,
        align="center",
        line_spacing=1.25,
    )

    # ── Divider ───────────────────────────────────────────────────────────────
    divider_y = max(y_after_headline + 30, int(CANVAS_SIZE * 0.72))
    draw_divider(canvas, y=divider_y, palette=palette, x_margin=PADDING * 2)

    # ── Subtext / brand name ──────────────────────────────────────────────────
    footer_text = subtext or brand_name
    footer_font = get_font(size=28, bold=False)
    from app.services.image_builder.text_engine import wrap_text
    footer_lines = wrap_text(footer_text, footer_font, max_width=CANVAS_SIZE - (PADDING * 3))
    draw_text_block(
        draw=draw,
        lines=footer_lines[:2],   # max 2 lines for footer
        font=footer_font,
        color=palette.text_muted,
        canvas_width=CANVAS_SIZE,
        y_start=divider_y + 24,
        align="center",
        line_spacing=1.3,
    )

    # ── Logo ──────────────────────────────────────────────────────────────────
    await place_logo(canvas, logo_url, anchor="bottom_right")

    return canvas_to_bytes(canvas)
