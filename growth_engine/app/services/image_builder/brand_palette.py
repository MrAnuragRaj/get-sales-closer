"""
Brand palette extraction.

Reads brand colors from the brand profile's tone_json or offer_json.
Falls back to a high-contrast dark navy palette if none specified.

Expected brand profile key (optional):
  tone_json.palette = {
    "primary":    "#1a2332",   — main background
    "secondary":  "#243447",   — secondary background / card accent
    "accent":     "#4A9EFF",   — highlight color (numbers, accents)
    "text_light": "#FFFFFF",   — primary text on dark backgrounds
    "text_dark":  "#1a2332",   — text on light backgrounds
  }

If palette is absent or keys are missing, defaults are used.
All values are returned as RGB tuples for Pillow.
"""

from __future__ import annotations

from typing import Optional


# Default dark navy palette — professional B2B aesthetic
_DEFAULTS: dict[str, str] = {
    "primary":    "#1A2332",
    "secondary":  "#243447",
    "accent":     "#4A9EFF",
    "text_light": "#FFFFFF",
    "text_muted": "#B0BEC5",
    "text_dark":  "#1A2332",
}


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Convert #RRGGBB to (R, G, B). Raises ValueError on bad input."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"Invalid hex color: {hex_color}")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


class BrandPalette:
    """Immutable color set resolved from brand profile + defaults."""

    def __init__(
        self,
        primary: tuple[int, int, int],
        secondary: tuple[int, int, int],
        accent: tuple[int, int, int],
        text_light: tuple[int, int, int],
        text_muted: tuple[int, int, int],
        text_dark: tuple[int, int, int],
    ):
        self.primary    = primary
        self.secondary  = secondary
        self.accent     = accent
        self.text_light = text_light
        self.text_muted = text_muted
        self.text_dark  = text_dark


def resolve_palette(
    tone_json: Optional[dict],
    offer_json: Optional[dict] = None,
) -> BrandPalette:
    """
    Build a BrandPalette from brand JSONB blobs.
    Precedence: tone_json.palette > offer_json.colors > defaults.
    """
    raw: dict[str, str] = {}

    # Check offer_json.colors first (lower priority)
    if offer_json:
        raw.update(offer_json.get("colors", {}))

    # tone_json.palette overrides
    if tone_json:
        raw.update(tone_json.get("palette", {}))

    def get_rgb(key: str) -> tuple[int, int, int]:
        hex_val = raw.get(key, _DEFAULTS[key])
        try:
            return _hex_to_rgb(hex_val)
        except ValueError:
            return _hex_to_rgb(_DEFAULTS[key])

    return BrandPalette(
        primary   = get_rgb("primary"),
        secondary = get_rgb("secondary"),
        accent    = get_rgb("accent"),
        text_light= get_rgb("text_light"),
        text_muted= get_rgb("text_muted"),
        text_dark = get_rgb("text_dark"),
    )
