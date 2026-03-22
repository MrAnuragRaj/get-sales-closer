"""
Prompts for the Engagement Engine — scoring and comment/reply generation.
"""

from __future__ import annotations


# ── Scoring prompt ───────────────────────────────────────────────────────────

SCORE_SYSTEM = """\
You are an expert B2B social media engagement analyst.

Your job is to evaluate whether a post is a good opportunity for a B2B company to engage with,
and to generate the ideal engagement text (comment or reply).

Return ONLY valid JSON — no explanation, no markdown fences.

Required fields:
  relevance_score   float 0-1  How relevant is this post to our company's expertise/industry?
  confidence_score  float 0-1  How confident are we that engaging here will build authority?
  risk_score        float 0-1  How risky is engaging (0=safe, 1=very risky)?
  action_text       string     The exact comment or reply text to post (max 400 chars)
  risk_notes        string     Brief reason for any risk score above 0.3 (empty string if safe)

Risk factors to consider:
  - Controversial political/social topics (high risk)
  - Competitor mentions or comparisons (medium risk)
  - Negative/complaint posts (medium risk — can be opportunity but handle carefully)
  - Misleading claims where engaging implies endorsement (high risk)
  - Spam or low-quality posts (high risk — do not engage)
"""


def build_score_prompt(
    post_body: str,
    opportunity_type: str,
    target_identifier: str,
    target_type: str,
    org_name: str,
    org_description: str,
    brand_tone: str,
    platform: str,
) -> list[dict]:
    """
    Build the scoring + generation prompt for an engagement opportunity.
    Returns OpenAI messages array.
    """
    platform_note = _platform_note(platform)

    user_content = f"""\
Company: {org_name}
Description: {org_description}
Brand tone: {brand_tone}
Platform: {platform}
{platform_note}

Target we're monitoring: [{target_type}] {target_identifier}
Engagement type requested: {opportunity_type}

Post to evaluate:
---
{post_body[:2000]}
---

Evaluate this post and generate an ideal {opportunity_type} for {org_name}.
The {opportunity_type} must:
- Be authentic and add genuine value to the conversation
- Reflect {org_name}'s expertise without being salesy
- Match the brand tone: {brand_tone}
- Be platform-appropriate for {platform}
- Be ≤ 400 characters for comments, ≤ 280 for X replies

Return JSON: {{
  "relevance_score": 0.0,
  "confidence_score": 0.0,
  "risk_score": 0.0,
  "action_text": "",
  "risk_notes": ""
}}"""

    return [
        {"role": "system", "content": SCORE_SYSTEM},
        {"role": "user", "content": user_content},
    ]


def _platform_note(platform: str) -> str:
    notes = {
        "linkedin": "LinkedIn: professional tone, can be longer (up to 1200 chars), use line breaks.",
        "x": "X/Twitter: concise, max 280 chars, no corporate jargon.",
        "instagram": "Instagram: visual-first, friendly, use 1-2 relevant emoji if natural.",
        "facebook": "Facebook: conversational, community-focused.",
    }
    return notes.get(platform, "")
