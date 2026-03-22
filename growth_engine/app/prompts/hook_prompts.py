"""
Hook tournament prompts.

Hooks determine 80% of post engagement.
Instead of generating 1 hook, we generate 10–12 variants, score each,
and pass the top-ranked hook to the writer.

Hook styles:
  question       — opens with a specific question that creates tension
  bold_statement — makes a confident claim immediately
  contrarian     — challenges what the audience believes
  statistic      — opens with a specific number or metric
  story_open     — drops the reader mid-scene
  pattern_break  — starts with something unexpected or counterintuitive
"""

from __future__ import annotations


HOOK_STYLE_DESCRIPTIONS = {
    "question":       "A specific question that creates immediate tension or curiosity",
    "bold_statement": "A confident, direct claim — no hedging, no setup",
    "contrarian":     "Challenges something the audience commonly believes",
    "statistic":      "Opens with a specific number, metric, or data point",
    "story_open":     "Drops the reader into a specific moment or scene",
    "pattern_break":  "Something unexpected or counterintuitive that forces a second read",
}


def build_hook_system_prompt() -> str:
    return (
        "You are a world-class social media copywriter who specializes in opening hooks. "
        "You understand that the first line of a post determines whether anyone reads it. "
        "You write hooks that feel written by a real operator, not a marketing department. "
        "Your hooks are sharp, specific, and create immediate tension or curiosity."
    )


def build_hook_tournament_prompt(
    topic: str,
    angle_title: str,
    core_claim: str,
    platform: str,
    brand_tone: str,
    n: int = 12,
) -> str:
    platform_guidance = {
        "linkedin": "professional but direct, can be slightly longer (up to 20 words)",
        "x":        "punchy and sharp, max 12 words, very direct",
        "facebook":  "conversational and relatable, can include a question",
        "instagram": "visual and emotional, connects to a feeling or moment",
    }.get(platform, "clear and direct")

    styles = list(HOOK_STYLE_DESCRIPTIONS.keys())
    styles_str = "\n".join(f"- {s}: {HOOK_STYLE_DESCRIPTIONS[s]}" for s in styles)

    return f"""Generate {n} distinct opening hooks for a social media post.

Post brief:
- Topic: {topic}
- Angle: {angle_title}
- Core claim: {core_claim}
- Platform: {platform} ({platform_guidance})
- Brand tone: {brand_tone}

Available hook styles:
{styles_str}

Rules:
- Each hook must be under 20 words
- Each hook must feel like a real founder/operator wrote it
- No generic SaaS phrases ("In today's fast-paced world", "Game changer", etc.)
- No two hooks can use the same opening word
- Cover at least 4 different styles across the {n} hooks
- Be specific — use concrete details, not vague concepts

Score each hook 1.0–10.0 on:
- Tension: does it create immediate curiosity?
- Specificity: does it feel real and grounded (not vague)?
- Originality: is it something rarely said before?
- Platform fit: does it match {platform} audience expectations?

Return a valid JSON array only — ordered by total_score descending:
[
  {{
    "hook": "<the hook text>",
    "style": "<one of the style names above>",
    "tension_score": <float>,
    "specificity_score": <float>,
    "originality_score": <float>,
    "platform_fit_score": <float>,
    "total_score": <float average>,
    "reason": "<one sentence — why this hook is strong>"
  }}
]"""
