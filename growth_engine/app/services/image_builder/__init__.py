"""
Image Builder package.

Deterministic Pillow-based template engine.
Entry point: image_pipeline.py (service layer above this package).

Template set v1:
  quote_card    — single headline on brand-colored canvas, logo anchored
  stat_card     — large quantified insight, supporting line, accent number
  carousel_5    — 5 x 1080×1080 slides, narrative arc (hook→problem→insight→framework→CTA)
  single_visual — topic + angle + core claim as a clean text graphic

All templates output PNG bytes.
All output is 1080×1080 (square — safe for LinkedIn, Instagram, Facebook).
"""
