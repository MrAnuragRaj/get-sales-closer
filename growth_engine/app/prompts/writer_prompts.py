"""
Platform-specific writer prompts.

Each platform has a distinct voice, format, and length expectation.
The writer receives the same core brief (topic + angle + hook + claim)
but produces platform-native output — NOT the same text copy-pasted.

Platform formats:
  LinkedIn  — long-form narrative: hook → insight → story/evidence → takeaway → soft CTA
  X         — short or thread: contrarian take, compact, punchy
  Facebook  — conversational, slightly broader readability, visual-friendly
  Instagram — caption-focused, short and punchy, visually complementary

X (Twitter) notes:
  Architecture is complete. Prompts are present.
  X is config-inactive in v1 (PLATFORM_X_ENABLED=false).
  When X is activated: change config, no code changes needed.
"""

from __future__ import annotations

from typing import Optional


PLATFORM_WORD_TARGETS = {
    "linkedin":  (150, 280),
    "x":         (30,  100),  # single post; thread handled separately
    "facebook":  (80,  200),
    "instagram": (50,  150),
}


def build_writer_system_prompt(platform: str) -> str:
    guides = {
        "linkedin": (
            "You write LinkedIn posts for B2B founders and operators. "
            "Your posts feel like they come from someone with hard-won business experience. "
            "Structure: hook → short narrative → concrete insight → takeaway → soft CTA. "
            "No bullet spam. No corporate language. No 'I am excited to share'. "
            "Sound like a real person who has done the work."
        ),
        "x": (
            "You write X (Twitter) posts for B2B operators. "
            "Short, sharp, and direct. Every word earns its place. "
            "No hashtag stuffing. No empty motivational filler. "
            "If it is a thread, each tweet must stand alone AND advance the argument."
        ),
        "facebook": (
            "You write Facebook posts for business owners and decision-makers. "
            "Conversational tone — slightly warmer than LinkedIn. "
            "Can include a question to drive comments. "
            "Still grounded in real business insights, not generic inspiration."
        ),
        "instagram": (
            "You write Instagram captions for B2B brands. "
            "Short, punchy, and visually complementary. "
            "The caption supports the image — does not repeat it. "
            "End with a clear call to action or engagement prompt."
        ),
    }
    return guides.get(platform, "You write clear, concise social media posts for B2B audiences.")


def build_writer_prompt(
    platform: str,
    topic: str,
    angle_title: str,
    core_claim: str,
    hook_text: str,
    brand_name: str,
    brand_tone: str,
    audience_description: str,
    cta_instruction: Optional[str],
    forbidden_phrases: list[str],
    recent_content_summary: str,
) -> str:
    word_min, word_max = PLATFORM_WORD_TARGETS.get(platform, (100, 200))
    forbidden_str = "\n".join(f"- {p}" for p in forbidden_phrases) if forbidden_phrases else "None"

    cta_line = (
        f"\nCall to action: {cta_instruction}" if cta_instruction else
        "\nCall to action: subtle — invite reflection or a follow, no hard sell"
    )

    platform_specific = {
        "linkedin": (
            f"Format: narrative prose. {word_min}–{word_max} words. "
            "Start with the hook. Develop with 1–2 concrete insights. "
            "End with takeaway + soft CTA. No bullet points unless listing 3+ specifics."
        ),
        "x": (
            f"Format: single post OR thread (your choice). {word_min}–{word_max} words for single. "
            "If thread: max 5 tweets, each under 280 characters, numbered (1/5, 2/5 etc). "
            "Start with the hook tweet. Each tweet must stand alone."
        ),
        "facebook": (
            f"Format: conversational. {word_min}–{word_max} words. "
            "Can end with a question to drive comments. Warmer tone than LinkedIn."
        ),
        "instagram": (
            f"Format: caption. {word_min}–{word_max} words. "
            "Assumes a visual is paired with this text. "
            "3–5 relevant hashtags at the end (not more)."
        ),
    }.get(platform, f"{word_min}–{word_max} words, clear and concise.")

    return f"""Write a {platform} post for {brand_name}.

Post brief:
- Topic: {topic}
- Angle: {angle_title}
- Core claim: {core_claim}
- Opening hook (use this exactly, do not modify): "{hook_text}"
{cta_line}

Audience: {audience_description}
Brand tone: {brand_tone}

{platform_specific}

What to avoid (this is a hard ban — if any appear, the post fails quality review):
{forbidden_str}

Recent content context (do not repeat these angles or hooks):
{recent_content_summary if recent_content_summary else "No recent content yet"}

Requirements:
- Start with the provided hook — do not change it
- The core claim must be clear before the end of the post
- Use a concrete example, number, or real-world observation — not abstract advice
- Sound like a founder/operator with real experience, not a content marketer
- The post must earn the right to make its claim — build to it

Return ONLY the post text. No labels, no metadata, no commentary."""


def build_x_thread_prompt(
    topic: str,
    angle_title: str,
    core_claim: str,
    hook_text: str,
    brand_name: str,
    brand_tone: str,
    audience_description: str,
    forbidden_phrases: list[str],
) -> str:
    """Separate prompt for X thread format (5-tweet structured thread)."""
    forbidden_str = "\n".join(f"- {p}" for p in forbidden_phrases) if forbidden_phrases else "None"

    return f"""Write a 5-tweet X (Twitter) thread for {brand_name}.

Thread brief:
- Topic: {topic}
- Angle: {angle_title}
- Core claim: {core_claim}
- Opening hook (tweet 1 — use this exactly): "{hook_text}"

Thread structure:
1/ Hook — the opening statement (provided above)
2/ Problem — why this matters / what breaks
3/ Insight — the key operational observation
4/ Framework or example — the concrete application
5/ Takeaway + follow prompt

Rules:
- Each tweet max 270 characters (leave room for thread numbering)
- Each tweet must be able to stand alone AND advance the argument
- No filler tweets — every tweet must add new information
- Tone: {brand_tone}
- Audience: {audience_description}

Hard ban phrases:
{forbidden_str}

Return as JSON array of 5 tweet strings:
["tweet 1 text", "tweet 2 text", "tweet 3 text", "tweet 4 text", "tweet 5 text"]"""
