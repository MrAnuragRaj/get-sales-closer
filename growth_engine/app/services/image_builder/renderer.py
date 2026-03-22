"""
Base renderer and shared canvas utilities.

All templates inherit from or call these utilities.
Canvas is always 1080×1080 (square) for multi-platform compatibility.

Logo handling:
  - Logo URL stored in Supabase Storage (brand profile)
  - Fetched async via httpx, resized to fit logo_box, composited at anchor
  - If fetch fails, rendering continues without logo (non-fatal)
  - Logo is always placed bottom-right with a 40px margin

Gradient background:
  - Optional subtle gradient from primary (top) to secondary (bottom)
  - Falls back to solid primary if secondary is very similar
"""

from __future__ import annotations

import io
import math
from typing import Optional

import httpx
from PIL import Image, ImageDraw

from app.logging_config import get_logger
from app.services.image_builder.brand_palette import BrandPalette

log = get_logger(__name__)

CANVAS_SIZE = 1080          # square canvas (1080×1080)
PADDING     = 80            # outer padding in pixels
LOGO_MAX    = 80            # max logo dimension in pixels
LOGO_MARGIN = 40            # distance from canvas edge for logo placement


def create_canvas(palette: BrandPalette, gradient: bool = True) -> Image.Image:
    """
    Create a fresh 1080×1080 canvas with brand background.
    Applies a subtle top-to-bottom gradient if gradient=True and
    primary/secondary colors differ.
    """
    canvas = Image.new("RGB", (CANVAS_SIZE, CANVAS_SIZE), palette.primary)

    if gradient:
        pr, pg, pb = palette.primary
        sr, sg, sb = palette.secondary
        # Only apply gradient if colors differ meaningfully
        diff = math.sqrt((pr-sr)**2 + (pg-sg)**2 + (pb-sb)**2)
        if diff > 15:
            draw = ImageDraw.Draw(canvas)
            for y in range(CANVAS_SIZE):
                t = y / CANVAS_SIZE
                r = int(pr + (sr - pr) * t)
                g = int(pg + (sg - pg) * t)
                b = int(pb + (sb - pb) * t)
                draw.line([(0, y), (CANVAS_SIZE, y)], fill=(r, g, b))

    return canvas


def add_accent_bar(
    canvas: Image.Image,
    palette: BrandPalette,
    position: str = "top",
    thickness: int = 8,
) -> None:
    """Draw a thin accent-colored bar at top or bottom of canvas."""
    draw = ImageDraw.Draw(canvas)
    if position == "top":
        draw.rectangle([(0, 0), (CANVAS_SIZE, thickness)], fill=palette.accent)
    else:
        draw.rectangle(
            [(0, CANVAS_SIZE - thickness), (CANVAS_SIZE, CANVAS_SIZE)],
            fill=palette.accent,
        )


async def place_logo(
    canvas: Image.Image,
    logo_url: Optional[str],
    anchor: str = "bottom_right",
) -> None:
    """
    Fetch and composite logo onto canvas. Non-fatal on fetch failure.

    anchor: "bottom_right" | "bottom_left" | "bottom_center"
    """
    if not logo_url:
        return

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(logo_url)
            resp.raise_for_status()
            logo_data = resp.content
    except Exception as exc:
        log.warning("logo_fetch_failed", url=logo_url[:60], error=str(exc))
        return

    try:
        logo = Image.open(io.BytesIO(logo_data)).convert("RGBA")
    except Exception as exc:
        log.warning("logo_parse_failed", error=str(exc))
        return

    # Resize to fit within LOGO_MAX × LOGO_MAX, preserving aspect ratio
    logo.thumbnail((LOGO_MAX, LOGO_MAX), Image.LANCZOS)
    lw, lh = logo.size

    if anchor == "bottom_right":
        x = CANVAS_SIZE - lw - LOGO_MARGIN
        y = CANVAS_SIZE - lh - LOGO_MARGIN
    elif anchor == "bottom_left":
        x = LOGO_MARGIN
        y = CANVAS_SIZE - lh - LOGO_MARGIN
    else:  # bottom_center
        x = (CANVAS_SIZE - lw) // 2
        y = CANVAS_SIZE - lh - LOGO_MARGIN

    # Composite with alpha
    canvas.paste(logo, (x, y), mask=logo.split()[3] if logo.mode == "RGBA" else None)


def canvas_to_bytes(canvas: Image.Image, format: str = "PNG") -> bytes:
    """Render canvas to bytes. PNG is default (lossless)."""
    buf = io.BytesIO()
    canvas.save(buf, format=format, optimize=False)
    return buf.getvalue()


def draw_divider(
    canvas: Image.Image,
    y: int,
    palette: BrandPalette,
    x_margin: int = PADDING,
    thickness: int = 2,
    alpha: int = 80,
) -> None:
    """Draw a horizontal divider line."""
    draw = ImageDraw.Draw(canvas)
    r, g, b = palette.text_muted
    # Approximate alpha blending against primary
    pr, pg, pb = palette.primary
    t = alpha / 255
    color = (
        int(r * t + pr * (1 - t)),
        int(g * t + pg * (1 - t)),
        int(b * t + pb * (1 - t)),
    )
    draw.rectangle(
        [(x_margin, y), (CANVAS_SIZE - x_margin, y + thickness)],
        fill=color,
    )
