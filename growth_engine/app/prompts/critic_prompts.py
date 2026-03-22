"""
Critic prompts — the mandatory quality gate.

The critic behaves like a harsh editor, not a polite assistant.
It scores the post on 6 dimensions and makes a binary decision:
  "approve" — post passes all thresholds, save it
  "revise"  — one or more dimensions failed, provide targeted rewrite brief

Scoring dimensions (from critic.md — these thresholds are locked):
  clarity            >= 7  — is the main point immediately clear?
  specificity        >= 6  — concrete details, not vague generalizations
  novelty            >= 7  — fresh perspective, not common advice
  platform_fit       >= 6  — matches tone/format for the platform
  commercial_relevance >= 7 — connects to real business outcomes
  non_genericness    >= 7  — avoids AI/SaaS clichés

Additional mandatory checks:
  insight_count >= 2       — must contain at least 2 unique insights
  operator_voice = "founder"  — must read like a real operator, not a marketing intern

The revision brief is a targeted instruction — NOT "start over".
The rewriter uses it to fix specific weak parts while preserving the structure.
"""

from __future__ import annotations

# Score thresholds — any dimension below these triggers a "revise" decision
CRITIC_THRESHOLDS: dict[str, int] = {
    "clarity":             7,
    "specificity":         6,
    "novelty":             7,
    "platform_fit":        6,
    "commercial_relevance": 7,
    "non_genericness":     7,
}

MINIMUM_INSIGHT_COUNT = 2


def build_critic_system_prompt() -> str:
    return (
        "You are a harsh content editor for B2B social media. "
        "Your job is to catch weak writing, AI-generated patterns, and generic advice "
        "before they embarrass the brand. "
        "You are not here to be encouraging. You are here to be correct. "
        "A post that fails your review gets revised. A post that passes has earned it. "
        "You do not give partial credit for effort."
    )


def build_critic_prompt(
    post_text: str,
    platform: str,
    brand_name: str,
    cliches_detected: list[str],
) -> str:
    detected_str = (
        "\nNOTE: The following cliché phrases were pre-detected in this post:\n"
        + "\n".join(f"- \"{p}\"" for p in cliches_detected)
        if cliches_detected
        else ""
    )

    thresholds_str = "\n".join(
        f"  {dim}: minimum {score}/10"
        for dim, score in CRITIC_THRESHOLDS.items()
    )

    return f"""Review this {platform} post for {brand_name}.

Post:
---
{post_text}
---
{detected_str}

Score this post on each dimension from 1–10:

Dimensions:
  clarity           — Is the main point immediately clear?
  specificity       — Does it use concrete details, numbers, or real examples?
                      Vague generalizations score low.
  novelty           — Does it offer a perspective rarely seen? Or just repeat known advice?
  platform_fit      — Does the format, length, and tone match {platform} expectations?
  commercial_relevance — Does it connect to real business outcomes (not just awareness)?
  non_genericness   — Does it avoid AI/SaaS clichés and marketing language?

Additional mandatory checks:
  insight_count     — Count the number of unique, non-redundant insights in the post.
                      Repeating the same idea 3 ways counts as 1 insight.
  operator_voice    — Does this sound like:
                        A) a founder/operator who has done the work
                        B) a marketing intern who learned this from a blog post
  generic_phrases   — List any cliché or AI-sounding phrases found.

Minimum passing thresholds:
{thresholds_str}
  insight_count: minimum {MINIMUM_INSIGHT_COUNT}
  operator_voice: must be "founder"

Decision rules:
  "approve" — ALL thresholds met AND insight_count >= {MINIMUM_INSIGHT_COUNT} AND operator_voice = "founder"
  "revise"  — ANY threshold failed OR insight_count < {MINIMUM_INSIGHT_COUNT} OR operator_voice = "marketing_intern"

If decision is "revise", provide a targeted revision_brief:
  - Specific to what failed
  - Tells the writer WHAT to fix and HOW (not just "be more specific")
  - Preserves what worked — do NOT say "rewrite from scratch"
  - Max 3 sentences

Return valid JSON only — no commentary, no markdown:
{{
  "scores": {{
    "clarity": <int 1-10>,
    "specificity": <int 1-10>,
    "novelty": <int 1-10>,
    "platform_fit": <int 1-10>,
    "commercial_relevance": <int 1-10>,
    "non_genericness": <int 1-10>
  }},
  "insight_count": <int>,
  "operator_voice": "founder" | "marketing_intern",
  "weaknesses": ["...", "..."],
  "generic_phrases_found": ["..."],
  "decision": "approve" | "revise",
  "revision_brief": "<targeted rewrite instruction — only present if decision is revise>"
}}"""


def build_rewriter_system_prompt() -> str:
    return (
        "You are a skilled rewriter who improves content based on specific editorial feedback. "
        "You do NOT rewrite from scratch. "
        "You preserve what works — the structure, angle, and hook — and fix exactly what was flagged. "
        "Your output should feel like a natural improvement of the original, not a new post."
    )


def build_rewriter_prompt(
    original_draft: str,
    revision_brief: str,
    weaknesses: list[str],
    generic_phrases: list[str],
    platform: str,
    angle_title: str,
    hook_text: str,
    brand_tone: str,
) -> str:
    weaknesses_str = "\n".join(f"- {w}" for w in weaknesses) if weaknesses else "None specified"
    generic_str = "\n".join(f"- \"{p}\"" for p in generic_phrases) if generic_phrases else "None"

    return f"""Rewrite this {platform} post based on specific editorial feedback.

Original post:
---
{original_draft}
---

What to fix (revision brief):
{revision_brief}

Specific weaknesses to address:
{weaknesses_str}

Generic phrases to remove:
{generic_str}

What to preserve:
- The opening hook: "{hook_text}" (do not change this)
- The angle: {angle_title}
- The overall structure and length
- Anything that was working well

Rules:
- Do NOT start from scratch — improve the existing draft
- Fix ONLY what was flagged — do not introduce new problems
- The result must read like a real founder/operator on {platform}
- Tone: {brand_tone}

Return ONLY the rewritten post text. No labels, no explanation, no commentary."""
