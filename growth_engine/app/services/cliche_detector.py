"""
Cliché detector — hard-ban phrase detection.

Any post containing a banned phrase fails the quality gate before
the LLM critic even runs. This is cheap (pure string matching) and
removes the most obvious AI-sounding content immediately.

The banned list is derived directly from critic.md and the build spec.
Additions should be conservative — only add phrases that are genuinely
never appropriate in B2B operator content.
"""

from __future__ import annotations

import re

# Hard-ban phrases (from critic.md + spec §3.1)
# These phrases signal AI-generated / low-trust SaaS content.
# Case-insensitive match. Partial word matches are intentional
# (e.g., "revolutionize" catches "revolutionizes", "revolutionizing").
BANNED_PHRASES: list[str] = [
    "in today's fast-paced world",
    "in today's fast paced world",
    "game changer",
    "game-changer",
    "revolutionize",
    "unlock your potential",
    "unlock their potential",
    "take your business to the next level",
    "take their business to the next level",
    "cutting edge",
    "cutting-edge",
    "industry leading",
    "industry-leading",
    "synergy",
    "leverage synergies",
    "thought leader",
    "thought leadership",
    "disrupting the industry",
    "disruptive innovation",
    "move the needle",
    "circle back",
    "boil the ocean",
    "low-hanging fruit",
    "at the end of the day",
    "it is what it is",
    "paradigm shift",
    "value proposition",
    "actionable insights",
    "dive deep",
    "deep dive",
    "peel back the layers",
    "seamlessly",
    "robust solution",
    "comprehensive solution",
    "best-in-class",
    "world-class",
    "empower",
    "empowering businesses",
    "transform your business",
    "transform your sales",
    "supercharge",
    "skyrocket",
]

# Pre-compiled patterns for performance
_COMPILED: list[re.Pattern] = [
    re.compile(re.escape(phrase), re.IGNORECASE)
    for phrase in BANNED_PHRASES
]


def detect_cliches(text: str) -> list[str]:
    """
    Scan text for banned phrases. Returns list of matched phrases found.
    Empty list = clean.

    Args:
        text: Post text to scan (body_text, hook_text, caption, etc.)

    Returns:
        List of banned phrases found in the text. May contain duplicates
        if a phrase appears multiple times (caller can deduplicate if needed).
    """
    found: list[str] = []
    for pattern, phrase in zip(_COMPILED, BANNED_PHRASES):
        if pattern.search(text):
            found.append(phrase)
    return found


def is_clean(text: str) -> bool:
    """Return True if no banned phrases are found."""
    return len(detect_cliches(text)) == 0


def get_banned_phrases() -> list[str]:
    """Return the full ban list (for prompt injection, logging, etc.)."""
    return list(BANNED_PHRASES)
