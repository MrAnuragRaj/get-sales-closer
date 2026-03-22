"""
Angle generator prompts.

The angle is the specific perspective or take applied to a topic.
Same topic, different angles = completely different posts.

Angle types:
  contrarian       — challenges what the audience believes
  operational      — reveals how professionals actually handle it
  framework        — introduces a named model or repeatable rule
  founder_story    — told through a specific business moment or decision
  evidence         — anchored in a data point or concrete result
  market_insight   — reveals a pattern most people miss
"""

from __future__ import annotations


ANGLE_TYPES = [
    "contrarian",
    "operational",
    "framework",
    "founder_story",
    "evidence",
    "market_insight",
]


def build_angle_system_prompt() -> str:
    return (
        "You are a strategic content advisor who helps founders find the best angles "
        "for their content. You understand that the angle is more important than the topic. "
        "You specialize in B2B, high-ticket sales, and operator-led businesses."
    )


def build_angle_generator_prompt(
    topic: str,
    hook_seed: str,
    brand_name: str,
    brand_summary: str,
    content_pillar: str,
    audience_description: str,
    recent_angles: list[str],
) -> str:
    recent_str = "\n".join(f"- {a}" for a in recent_angles[-10:]) if recent_angles else "None"

    return f"""Generate 3 distinct angles for this content topic.

Brand: {brand_name}
Brand context: {brand_summary}
Audience: {audience_description}
Content pillar: {content_pillar}

Topic: {topic}
Initial hook idea: {hook_seed}

Recently used angles (avoid repeating these):
{recent_str}

For each angle provide:
- angle_type: one of contrarian | operational | framework | founder_story | evidence | market_insight
- angle_title: 5–10 word label for this angle
- core_claim: the single sentence this post will prove or argue
  (this is NOT the hook — it is the central thesis)
- recommended_priority: 1, 2, or 3 (1 = best fit for this brand/audience)
- rationale: one sentence — why this angle works for this brand

Rules:
- The 3 angles must be genuinely different — not the same idea reworded
- Each core_claim must be specific and arguable (not a generic statement)
- Priority 1 should be the angle most likely to generate meaningful engagement
  for this specific brand's audience

Return a valid JSON array only — ordered by recommended_priority:
[
  {{
    "angle_type": "contrarian",
    "angle_title": "Speed beats skill in lead response",
    "core_claim": "The company that responds in 90 seconds wins the deal — regardless of product quality",
    "recommended_priority": 1,
    "rationale": "Contrarian take on a core pain point for the audience"
  }}
]"""
