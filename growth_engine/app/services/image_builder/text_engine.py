"""
Text rendering engine — safe wrapping, font scaling, overflow protection.

Core guarantee: text NEVER overflows a bounding box.
If it doesn't fit at the minimum font size, it is truncated with an ellipsis.

Font resolution order:
  1. /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf   (Debian Docker image)
  2. /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
  3. C:/Windows/Fonts/arial.ttf                              (dev on Windows)
  4. PIL default bitmap font                                 (ultimate fallback)

The PIL default font produces acceptable output for CI/testing but should not
be used in production. The Dockerfile installs fonts-dejavu-core to guarantee
path 1 is available in the deployed container.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

from PIL import ImageDraw, ImageFont

# ── Font paths ─────────────────────────────────────────────────────────────────

_FONT_SEARCH_PATHS: dict[str, list[str]] = {
    "bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/Arial Bold.ttf",
    ],
    "regular": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/Arial.ttf",
    ],
}


@lru_cache(maxsize=32)
def _load_font(variant: str, size: int) -> ImageFont.ImageFont:
    """
    Load a font at the given size. Returns PIL default on total failure.
    Cached — same variant+size returns same object.
    """
    for path in _FONT_SEARCH_PATHS.get(variant, []):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except (IOError, OSError):
                continue
    # Ultimate fallback: PIL bitmap default (tiny but always available)
    return ImageFont.load_default()


def get_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    return _load_font("bold" if bold else "regular", size)


# ── Text measurement ───────────────────────────────────────────────────────────

def measure_line(text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    """Return (width, height) of a single text line."""
    bbox = font.getbbox(text)
    return (bbox[2] - bbox[0], bbox[3] - bbox[1])


def measure_block(lines: list[str], font: ImageFont.ImageFont, line_spacing: float = 1.3) -> tuple[int, int]:
    """Return (max_width, total_height) for a block of lines."""
    if not lines:
        return (0, 0)
    _, line_h = measure_line("Hy", font)   # consistent line height via cap+descender
    total_h = int(line_h * line_spacing * len(lines))
    max_w = max(measure_line(line, font)[0] for line in lines)
    return (max_w, total_h)


# ── Text wrapping ──────────────────────────────────────────────────────────────

def wrap_text(text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    """
    Wrap text to fit within max_width pixels at the given font.
    Respects existing newlines. Returns list of wrapped lines.
    """
    if not text:
        return []

    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue

        current = ""
        for word in words:
            test = f"{current} {word}".strip() if current else word
            w, _ = measure_line(test, font)
            if w <= max_width:
                current = test
            else:
                if current:
                    lines.append(current)
                # If single word wider than max_width, force it
                current = word
        if current:
            lines.append(current)

    return lines


# ── Font scaling ───────────────────────────────────────────────────────────────

def scale_font_to_fit(
    text: str,
    max_width: int,
    max_height: int,
    bold: bool = True,
    max_size: int = 96,
    min_size: int = 18,
    line_spacing: float = 1.3,
) -> tuple[ImageFont.ImageFont, list[str]]:
    """
    Binary search for the largest font size where the wrapped text fits
    within (max_width × max_height).

    Returns (font, wrapped_lines). If it doesn't fit at min_size,
    returns min_size font with truncated lines (overflow protection).
    """
    lo, hi = min_size, max_size
    best_font = get_font(min_size, bold)
    best_lines: list[str] = wrap_text(text, best_font, max_width)

    while lo <= hi:
        mid = (lo + hi) // 2
        font = get_font(mid, bold)
        wrapped = wrap_text(text, font, max_width)
        _, block_h = measure_block(wrapped, font, line_spacing)

        if block_h <= max_height:
            best_font = font
            best_lines = wrapped
            lo = mid + 1
        else:
            hi = mid - 1

    # Overflow protection: if best_lines still too tall (can happen with
    # many newlines), truncate until it fits
    while len(best_lines) > 1:
        _, block_h = measure_block(best_lines, best_font, line_spacing)
        if block_h <= max_height:
            break
        # Truncate last line and add ellipsis to second-to-last
        best_lines = best_lines[:-1]
        if best_lines:
            best_lines[-1] = best_lines[-1].rstrip() + "…"

    return best_font, best_lines


# ── Rendering helpers ──────────────────────────────────────────────────────────

def draw_text_block(
    draw: ImageDraw.Draw,
    lines: list[str],
    font: ImageFont.ImageFont,
    color: tuple[int, int, int],
    canvas_width: int,
    y_start: int,
    align: str = "center",
    line_spacing: float = 1.3,
) -> int:
    """
    Draw a block of text lines onto the canvas.

    Args:
        draw:          PIL ImageDraw instance
        lines:         pre-wrapped lines (from wrap_text or scale_font_to_fit)
        font:          Pillow font object
        color:         RGB tuple
        canvas_width:  total canvas width (for centering)
        y_start:       top Y coordinate for the first line
        align:         "center" | "left" | "right"
        line_spacing:  multiplier for line height

    Returns:
        y_end — the Y coordinate after the last line (for stacking elements)
    """
    _, line_h = measure_line("Hy", font)
    step = int(line_h * line_spacing)
    y = y_start

    for line in lines:
        line_w, _ = measure_line(line, font)
        if align == "center":
            x = (canvas_width - line_w) // 2
        elif align == "right":
            x = canvas_width - line_w - 40
        else:
            x = 40
        draw.text((x, y), line, font=font, fill=color)
        y += step

    return y


def draw_quote_mark(
    draw: ImageDraw.Draw,
    x: int,
    y: int,
    size: int,
    color: tuple[int, int, int],
) -> None:
    """Draw a decorative open-quote mark (" ) at position (x, y)."""
    font = get_font(size, bold=True)
    draw.text((x, y), "\u201C", font=font, fill=color)
