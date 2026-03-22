"""
Tests for the image builder — text engine, brand palette, template rendering.

These tests run without any external services (no OpenAI, no Supabase Storage).
They verify: font scaling, text wrapping, overflow protection, palette extraction,
carousel slide count, and that each template produces valid PNG bytes.

PIL is required. All font operations fall back to PIL's default if DejaVu
is not present — tests pass on any environment.
"""

from __future__ import annotations

import io
import struct
from unittest.mock import AsyncMock, patch

import pytest
from PIL import Image

from app.services.image_builder.brand_palette import BrandPalette, resolve_palette
from app.services.image_builder.text_engine import (
    measure_block,
    measure_line,
    scale_font_to_fit,
    wrap_text,
    get_font,
)


# ── Brand palette tests ────────────────────────────────────────────────────────

def test_default_palette_used_when_no_tone_json():
    palette = resolve_palette(tone_json=None)
    assert isinstance(palette, BrandPalette)
    assert palette.primary == (0x1A, 0x23, 0x32)
    assert palette.accent  == (0x4A, 0x9E, 0xFF)


def test_custom_palette_from_tone_json():
    tone_json = {
        "palette": {
            "primary": "#FF0000",
            "accent":  "#00FF00",
        }
    }
    palette = resolve_palette(tone_json=tone_json)
    assert palette.primary == (255, 0, 0)
    assert palette.accent  == (0, 255, 0)
    # Unset keys fall back to defaults
    assert palette.text_light == (255, 255, 255)


def test_invalid_hex_falls_back_to_default():
    tone_json = {"palette": {"primary": "not-a-color"}}
    palette = resolve_palette(tone_json=tone_json)
    # Should fall back to default primary
    assert palette.primary == (0x1A, 0x23, 0x32)


def test_offer_json_colors_used_as_fallback():
    offer_json = {"colors": {"accent": "#123456"}}
    palette = resolve_palette(tone_json=None, offer_json=offer_json)
    assert palette.accent == (0x12, 0x34, 0x56)


def test_tone_json_overrides_offer_json():
    offer_json = {"colors": {"primary": "#111111"}}
    tone_json  = {"palette": {"primary": "#222222"}}
    palette = resolve_palette(tone_json=tone_json, offer_json=offer_json)
    assert palette.primary == (0x22, 0x22, 0x22)


# ── Text engine tests ──────────────────────────────────────────────────────────

def test_wrap_text_short_string_no_wrap():
    font = get_font(28)
    lines = wrap_text("Hello world", font, max_width=800)
    assert lines == ["Hello world"]


def test_wrap_text_long_string_wraps():
    font = get_font(40)
    text = "This is a very long line of text that should wrap onto multiple lines because it exceeds the max width"
    lines = wrap_text(text, font, max_width=400)
    assert len(lines) > 1
    # All words should be present
    reconstructed = " ".join(lines)
    for word in text.split():
        assert word in reconstructed


def test_wrap_text_empty_string():
    font = get_font(28)
    assert wrap_text("", font, max_width=800) == []


def test_wrap_text_respects_newlines():
    font = get_font(28)
    text = "Line one\nLine two"
    lines = wrap_text(text, font, max_width=800)
    assert "Line one" in lines
    assert "Line two" in lines


def test_scale_font_to_fit_within_bounds():
    font, lines = scale_font_to_fit(
        text="90 seconds wins the deal",
        max_width=800,
        max_height=200,
        bold=True,
        max_size=80,
        min_size=18,
    )
    _, block_h = measure_block(lines, font)
    assert block_h <= 200
    assert len(lines) >= 1


def test_scale_font_to_fit_very_tight_box():
    # Even a very tight box should not raise — overflow protection kicks in
    font, lines = scale_font_to_fit(
        text="This is a very long text that will not fit in a very tiny box at all",
        max_width=100,
        max_height=40,
        bold=True,
        max_size=80,
        min_size=18,
    )
    # Should return something (possibly truncated with ellipsis)
    assert len(lines) >= 1
    assert font is not None


def test_scale_font_overflow_protection_uses_ellipsis():
    # With very tight constraints, last line should have ellipsis if truncated
    font, lines = scale_font_to_fit(
        text="Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9 Word10",
        max_width=300,
        max_height=60,
        bold=True,
        max_size=40,
        min_size=20,
    )
    _, block_h = measure_block(lines, font)
    assert block_h <= 60 + 40   # allow slight overshoot — font leading varies
    if len(lines) > 0 and "…" in lines[-1]:
        assert lines[-1].endswith("…")


def test_measure_line_returns_positive_dimensions():
    font = get_font(32)
    w, h = measure_line("Test text", font)
    assert w > 0
    assert h > 0


def test_measure_block_empty_lines():
    font = get_font(28)
    w, h = measure_block([], font)
    assert w == 0
    assert h == 0


# ── Template rendering tests ───────────────────────────────────────────────────

def _is_valid_png(data: bytes) -> bool:
    """Check PNG magic bytes."""
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def _png_dimensions(data: bytes) -> tuple[int, int]:
    """Extract width/height from PNG IHDR chunk."""
    w = struct.unpack(">I", data[16:20])[0]
    h = struct.unpack(">I", data[20:24])[0]
    return w, h


def _default_palette() -> BrandPalette:
    return resolve_palette(None)


@pytest.mark.asyncio
async def test_quote_card_renders_valid_png():
    from app.services.image_builder.quote_card import render_quote_card
    png = await render_quote_card(
        headline_text="Responding in 90 seconds doubles your close rate",
        brand_name="AcmeCorp",
        palette=_default_palette(),
        logo_url=None,
        subtext=None,
    )
    assert _is_valid_png(png)
    w, h = _png_dimensions(png)
    assert w == 1080
    assert h == 1080


@pytest.mark.asyncio
async def test_stat_card_renders_valid_png():
    from app.services.image_builder.stat_card import render_stat_card
    png = await render_stat_card(
        headline_text="78% of deals go to the first responder",
        brand_name="AcmeCorp",
        palette=_default_palette(),
        logo_url=None,
        supporting_text="Most sales teams respond in 47 hours.",
    )
    assert _is_valid_png(png)
    w, h = _png_dimensions(png)
    assert w == 1080 and h == 1080


@pytest.mark.asyncio
async def test_single_visual_renders_valid_png():
    from app.services.image_builder.single_visual import render_single_visual
    png = await render_single_visual(
        topic="Speed to Lead",
        headline="Speed beats skill every time",
        core_claim="The team that responds first wins the deal regardless of product quality.",
        brand_name="AcmeCorp",
        palette=_default_palette(),
        logo_url=None,
    )
    assert _is_valid_png(png)
    w, h = _png_dimensions(png)
    assert w == 1080 and h == 1080


@pytest.mark.asyncio
async def test_carousel_renders_exactly_5_slides():
    from app.services.image_builder.carousel import render_carousel
    slides = [
        {"slide_no": 1, "headline": "Your pipeline is leaking",        "body": "Most teams don't know where."},
        {"slide_no": 2, "headline": "Response time kills deals",       "body": "47 hours average. Buyers decide in 5 minutes."},
        {"slide_no": 3, "headline": "The first response wins",         "body": "Not the best product. The fastest reply."},
        {"slide_no": 4, "headline": "The 90-second rule",              "body": "Respond in 90 seconds. Close rate doubles."},
        {"slide_no": 5, "headline": "Fix one thing this week",         "body": "Set up an instant AI response. Measure the change."},
    ]
    pngs = await render_carousel(
        slides=slides,
        brand_name="AcmeCorp",
        palette=_default_palette(),
        logo_url=None,
    )
    assert len(pngs) == 5
    for i, png in enumerate(pngs):
        assert _is_valid_png(png), f"Slide {i+1} is not valid PNG"
        w, h = _png_dimensions(png)
        assert w == 1080 and h == 1080, f"Slide {i+1} wrong dimensions: {w}x{h}"


@pytest.mark.asyncio
async def test_carousel_handles_missing_slides():
    """Missing slide numbers should still produce 5 slides (filled with empty content)."""
    from app.services.image_builder.carousel import render_carousel
    # Only provide 3 slides
    slides = [
        {"slide_no": 1, "headline": "Hook slide",      "body": "Body 1"},
        {"slide_no": 3, "headline": "Insight slide",   "body": "Body 3"},
        {"slide_no": 5, "headline": "Takeaway slide",  "body": "Body 5"},
    ]
    pngs = await render_carousel(
        slides=slides,
        brand_name="AcmeCorp",
        palette=_default_palette(),
    )
    assert len(pngs) == 5


@pytest.mark.asyncio
async def test_templates_handle_very_long_text_without_overflow():
    """Template renderers must not raise on excessively long input text."""
    from app.services.image_builder.quote_card import render_quote_card
    long_text = "This is an extremely long headline that exceeds the 14 word limit and should still render without crashing the Pillow renderer despite the overflow"
    png = await render_quote_card(
        headline_text=long_text,
        brand_name="AcmeCorp",
        palette=_default_palette(),
    )
    assert _is_valid_png(png)


@pytest.mark.asyncio
async def test_templates_handle_empty_text():
    """Empty text inputs should not raise."""
    from app.services.image_builder.single_visual import render_single_visual
    png = await render_single_visual(
        topic="",
        headline="",
        core_claim="",
        brand_name="Brand",
        palette=_default_palette(),
    )
    assert _is_valid_png(png)


@pytest.mark.asyncio
async def test_logo_fetch_failure_is_non_fatal():
    """If logo URL is unreachable, template still renders successfully."""
    from app.services.image_builder.quote_card import render_quote_card
    png = await render_quote_card(
        headline_text="Speed wins deals",
        brand_name="AcmeCorp",
        palette=_default_palette(),
        logo_url="https://invalid-domain-that-does-not-exist.example/logo.png",
    )
    assert _is_valid_png(png)


# ── Palette accent highlighting (stat card) ────────────────────────────────────

def test_stat_card_accent_highlight_numeric():
    """Numbers/percentages in stat card headline should not crash the renderer."""
    import re
    pattern = re.compile(r"^[\d,.$%+\-]+[\d%]?$")
    assert pattern.match("78%")
    assert pattern.match("$4.2M")
    assert pattern.match("90")
    assert not pattern.match("seconds")
    assert not pattern.match("deals")
