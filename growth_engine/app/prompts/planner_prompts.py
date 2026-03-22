"""
Topic planner prompts.

The planner generates content ideas from brand context.
Each idea is a structured brief: pillar, topic, angle, hook seed, score.

Two operating modes:
  1. Regular mode    — generates N independent ideas across pillars
  2. Authority Ladder — generates one idea for a specific ladder level + theme

Philosophy: the planner outputs briefs, not posts. The writer turns briefs into posts.
The briefer the idea brief, the more creative headroom the writer has.
"""

from __future__ import annotations

import json
from typing import Any, Optional


LADDER_LEVELS = {
    1: ("observation",         "Simple, relatable insight about an industry problem"),
    2: ("pattern_recognition", "Why the problem occurs — analytical view"),
    3: ("operational_insight", "How professionals solve it — concrete and specific"),
    4: ("framework",           "A repeatable model or named rule"),
    5: ("authority_position",  "A confident take that challenges conventional wisdom"),
    6: ("evidence",            "Data, example, or story that proves the claim"),
    7: ("movement",            "Invite the audience to adopt the idea"),
}


def build_planner_system_prompt() -> str:
    return (
        "You are an expert content strategist specializing in B2B social media for "
        "high-ticket businesses (law, medical, real estate, solar, SaaS sales tools). "
        "You produce sharp, insight-dense content briefs — not generic advice. "
        "Every brief must be specific enough that a writer can produce a non-generic post from it. "
        "You never produce vague platitudes."
    )


def build_regular_planner_prompt(
    brand_name: str,
    brand_summary: str,
    content_pillars: list[str],
    audience_description: str,
    tone_description: str,
    recent_topics: list[str],
    n: int = 10,
) -> str:
    recent_topics_str = "\n".join(f"- {t}" for t in recent_topics[-20:]) if recent_topics else "None yet"
    pillars_str = ", ".join(content_pillars) if content_pillars else "general business insights"

    return f"""You are planning content for: {brand_name}

Brand context:
{brand_summary}

Target audience: {audience_description}
Content pillars: {pillars_str}
Brand tone: {tone_description}

Recent topics already covered (avoid these):
{recent_topics_str}

Generate exactly {n} content idea briefs for social media posts.

Mix ratio:
- 3 educational (teach something concrete)
- 2 contrarian (challenge a common belief)
- 2 founder/operator story (reveal how professionals think)
- 2 ROI/proof (business outcomes, numbers, evidence)
- 1 objection handling (address a common pushback)

For each idea provide:
- pillar: which content pillar this belongs to
- topic: the specific subject (max 10 words, very specific — not "AI in sales")
- angle: the unique take or perspective (what makes this different)
- hook_seed: a rough opening line, question, or tension (will be developed further)
- score: your confidence this will resonate 1.0–10.0

Rules:
- No generic advice ("use AI to improve sales")
- Each topic must be specific enough to produce a non-generic post
- No two ideas from the same pillar back-to-back
- Avoid repeating recent topics

Return a valid JSON array only — no commentary, no markdown fences:
[
  {{
    "pillar": "speed_to_lead",
    "topic": "Why 90 seconds is the only lead response time that matters",
    "angle": "contrarian — most teams optimize the wrong metric",
    "hook_seed": "Your CRM has 200 leads. 180 of them already chose someone else.",
    "score": 8.5
  }}
]"""


def build_ladder_planner_prompt(
    brand_name: str,
    brand_summary: str,
    theme: str,
    ladder_level: int,
    completed_briefs: list[str],
    tone_description: str,
) -> str:
    level_name, level_description = LADDER_LEVELS.get(ladder_level, ("observation", "simple insight"))
    completed_str = "\n".join(f"- {b}" for b in completed_briefs) if completed_briefs else "None yet"

    return f"""You are building an Authority Ladder content sequence for: {brand_name}

Theme: {theme}
Brand context: {brand_summary}
Brand tone: {tone_description}

Authority Ladder so far:
{completed_str}

Current step to generate: Level {ladder_level} — {level_name.upper()}
Description: {level_description}

Generate exactly ONE content idea brief for this ladder level.

The idea must:
- Build naturally from the previous levels (if any)
- Fit the level type: {level_description}
- Be specific to the theme: {theme}
- Move the audience one step further in understanding/authority

Return a valid JSON object only — no commentary:
{{
  "pillar": "<relevant pillar>",
  "topic": "<specific topic for this ladder level>",
  "angle": "<the exact angle for level {ladder_level}>",
  "hook_seed": "<opening tension or question>",
  "score": <float 1.0-10.0>,
  "ladder_level": {ladder_level},
  "ladder_level_name": "{level_name}"
}}"""
