"""
Image text generation prompts.

Before rendering an image, the pipeline generates text spec via LLM.
The spec determines what text appears on each template — the renderer
then handles layout, font sizing, and brand styling.

This separation means:
  - LLM produces clean, short, image-appropriate text
  - Renderer handles all visual rules (wrapping, scaling, overflow)
  - Editing the image text = editing the spec JSON, not the post body

Rules all image prompts enforce:
  - No clichés (same banned list as writer)
  - Tight word counts (images ≠ prose)
  - B2B operator voice
  - Specificity over abstraction

Template specs:
  quote_card    — headline (max 14 words) + optional subtext
  stat_card     — headline with stat/insight (max 18 words) + supporting line
  carousel_5    — 5 slides {headline, body} with narrative arc
  single_visual — topic label + headline + core_claim
"""

from __future__ import annotations


def build_image_system_prompt() -> str:
    return (
        "You write concise, high-impact text for branded social media images. "
        "Your output is used directly on visual cards — not in prose posts. "
        "Every word must earn its place. "
        "You write for B2B operators. No clichés, no filler, no generic SaaS language. "
        "Think: what would a founder put on a slide at a conference?"
    )


def build_quote_card_prompt(
    core_claim: str,
    angle_title: str,
    brand_name: str,
) -> str:
    return f"""Create text for a branded quote card for {brand_name}.

This quote card will be posted as a social media image — it must look strong visually.

Input:
- Core claim: {core_claim}
- Angle: {angle_title}

Rules:
- headline_text: max 14 words, one complete thought, must stand alone
- Must be specific and arguable — not a platitude
- No buzzwords (game changer, revolutionize, seamlessly, etc.)
- Should provoke agreement OR productive disagreement — not bland consensus
- subtext: optional 1 short line — attribution, context, or brand tagline (or null)

Return valid JSON only:
{{
  "headline_text": "<max 14 words>",
  "subtext": "<1 short line or null>"
}}"""


def build_stat_card_prompt(
    topic: str,
    core_claim: str,
    proof_point: str,
) -> str:
    proof_str = f"\nAvailable proof point: {proof_point}" if proof_point else ""
    return f"""Create text for a stat/insight card.

This will be rendered as a visual image for B2B social content.

Topic: {topic}
Core claim: {core_claim}{proof_str}

Rules:
- headline_text: max 18 words; ideally contains a NUMBER or specific metric
  If no number is naturally present, lead with a specific operational truth
- supporting_text: optional 1 sentence of context (or null)
- Absolutely NO generic phrases (actionable insights, transform your business, etc.)
- Must be readable at a glance

Return valid JSON only:
{{
  "headline_text": "<max 18 words with number/metric if possible>",
  "supporting_text": "<1 sentence or null>"
}}"""


def build_carousel_prompt(
    topic: str,
    angle_title: str,
    core_claim: str,
    brand_name: str,
    audience_description: str,
) -> str:
    return f"""Create a 5-slide carousel for {brand_name}.

Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}
Audience: {audience_description}

Slide structure (MUST follow exactly):
1 — HOOK      (the opening tension/question that makes people swipe)
2 — PROBLEM   (why this matters / what breaks without solving it)
3 — INSIGHT   (the key operational observation — what most people miss)
4 — FRAMEWORK (concrete application / the model or rule / real example)
5 — TAKEAWAY  (actionable close + soft CTA or follow prompt)

Per-slide rules:
- headline: max 8 words — punchy and specific
- body: 2–3 sentences max — readable on a phone screen
- Each slide must stand alone AND advance the argument
- No generic filler — every slide must add new information
- Tone: real operator, not content marketer

Hard ban: game changer, revolutionize, seamlessly, transform, empower, synergy,
thought leadership, actionable insights, deep dive, value proposition

Return valid JSON only:
{{
  "slides": [
    {{"slide_no": 1, "headline": "<8 words max>", "body": "<2-3 sentences>"}},
    {{"slide_no": 2, "headline": "<8 words max>", "body": "<2-3 sentences>"}},
    {{"slide_no": 3, "headline": "<8 words max>", "body": "<2-3 sentences>"}},
    {{"slide_no": 4, "headline": "<8 words max>", "body": "<2-3 sentences>"}},
    {{"slide_no": 5, "headline": "<8 words max>", "body": "<2-3 sentences>"}}
  ]
}}"""


def build_single_visual_prompt(
    topic: str,
    angle_title: str,
    core_claim: str,
) -> str:
    return f"""Create text for a single insight visual card.

Topic: {topic}
Angle: {angle_title}
Core claim: {core_claim}

Rules:
- headline: max 10 words — the angle_title rephrased for visual impact
  (can be the angle_title directly if it already reads well at that length)
- core_claim_display: the core claim condensed to max 20 words
  Must be a complete, standalone sentence
- topic_label: max 4 words — the topic/pillar label for the top of the card
  (e.g. "Speed to Lead", "Follow-Up Strategy", "Conversion Rate")

Return valid JSON only:
{{
  "topic_label": "<max 4 words>",
  "headline": "<max 10 words>",
  "core_claim_display": "<max 20 words, complete sentence>"
}}"""
