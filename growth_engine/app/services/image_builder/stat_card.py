"""
Stat card template — 1080×1080.

Layout (split: top 55% for stat, bottom 45% for context):
  ┌──────────────────────────────────────────────────────┐
  │ ████ accent bar (top, 8px)                           │
  │                                                      │
  │    [HEADLINE TEXT — large, accent color for          │
  │     numbers/key phrase, white for rest]              │
  │                                                      │
  │ ──── divider ────                                     │
  │                                                      │
  │    [supporting_text — medium, muted white]           │
  │                                                      │
  │  [brand_name, small, muted]           [logo]         │
  └──────────────────────────────────────────────────────┘

The headline renderer highlights the FIRST token that looks like a number
or percentage in accent color. All other words remain text_light.

Input spec (from image_spec_json):
  headline_text:    str   — main stat or insight phrase (max 18 words)
  supporting_text:  str   — optional context line (1 sentence)
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


async def render_stat_card(
    headline_text: str,
    brand_name: str,
    palette: BrandPalette,
    logo_url: Optional[str] = None,
    supporting_text: Optional[str] = None,
) -> bytes:
    """
    Render a stat card and return PNG bytes.

    Args:
        headline_text:   Stat or insight (max 18 words; numbers get accent color)
        brand_name:      Footer label
        palette:         Resolved brand palette
        logo_url:        Optional logo URL
        supporting_text: Optional 1-sentence context

    Returns:
        PNG bytes (1080×1080)
    """
    canvas = create_canvas(palette, gradient=True)
    draw = ImageDraw.Draw(canvas)

    add_accent_bar(canvas, palette, position="top", thickness=8)

    # ── Headline zone: upper 55% of canvas ──────────────────────────────────
    headline_zone_h = int(CANVAS_SIZE * 0.52)
    max_w = CANVAS_SIZE - (PADDING * 2)

    headline_font, headline_lines = scale_font_to_fit(
        text=headline_text,
        max_width=max_w,
        max_height=headline_zone_h - PADDING,
        bold=True,
        max_size=96,
        min_size=32,
    )

    _, block_h = measure_block(headline_lines, headline_font)
    y_start = max(PADDING + 40, (headline_zone_h - block_h) // 2)

    # Render headline — accent-highlight first numeric token
    y_after = _draw_headline_with_accent(
        draw=draw,
        lines=headline_lines,
        font=headline_font,
        palette=palette,
        canvas_width=CANVAS_SIZE,
        y_start=y_start,
    )

    # ── Divider ───────────────────────────────────────────────────────────────
    divider_y = max(y_after + 30, headline_zone_h + 20)
    draw_divider(canvas, y=divider_y, palette=palette, x_margin=PADDING)

    # ── Supporting text ────────────────────────────────────────────────────────
    if supporting_text:
        sup_font = get_font(size=34, bold=False)
        sup_lines = wrap_text(supporting_text, sup_font, max_width=max_w)
        y_after_sup = draw_text_block(
            draw=draw,
            lines=sup_lines[:3],
            font=sup_font,
            color=palette.text_muted,
            canvas_width=CANVAS_SIZE,
            y_start=divider_y + 28,
            align="center",
            line_spacing=1.35,
        )
    else:
        y_after_sup = divider_y + 40

    # ── Brand name footer ─────────────────────────────────────────────────────
    brand_font = get_font(size=24, bold=False)
    brand_lines = wrap_text(brand_name, brand_font, max_width=max_w)
    draw_text_block(
        draw=draw,
        lines=brand_lines[:1],
        font=brand_font,
        color=palette.text_muted,
        canvas_width=CANVAS_SIZE,
        y_start=CANVAS_SIZE - 80,
        align="center",
    )

    await place_logo(canvas, logo_url, anchor="bottom_right")

    return canvas_to_bytes(canvas)


# ── Accent highlighting helper ─────────────────────────────────────────────────

def _draw_headline_with_accent(
    draw: ImageDraw.Draw,
    lines: list[str],
    font,
    palette: BrandPalette,
    canvas_width: int,
    y_start: int,
    line_spacing: float = 1.25,
) -> int:
    """
    Draw headline lines. The first token that looks like a number/% gets
    accent color; all other tokens get text_light.

    Returns y after the last line.
    """
    import re
    from app.services.image_builder.text_engine import measure_line

    _, line_h = measure_line("Hy", font)
    step = int(line_h * line_spacing)
    y = y_start

    # Find which line/word contains the first number token
    accent_applied = False
    number_pattern = re.compile(r"^[\d,.$%+\-]+[\d%]?$")

    for line in lines:
        words = line.split()
        if not words:
            y += step
            continue

        # Measure total line width for centering
        line_w, _ = measure_line(line, font)
        x = (canvas_width - line_w) // 2

        for word in words:
            w, _ = measure_line(word, font)
            color = palette.text_light
            if not accent_applied and number_pattern.match(word.strip(".,;:")):
                color = palette.accent
                accent_applied = True
            draw.text((x, y), word, font=font, fill=color)
            space_w, _ = measure_line(" ", font)
            x += w + space_w

        y += step

    return y
