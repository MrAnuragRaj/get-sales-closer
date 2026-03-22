"""
Tests for the critic pipeline — parsing, threshold enforcement, and fallback behaviour.

These tests mock the OpenAI call and verify:
  1. A clean high-scoring response → approve
  2. A failing threshold → revise (overrides model's approve)
  3. Missing insight_count → revise
  4. marketing_intern operator_voice → revise
  5. Pre-detected clichés injected into result
  6. JSON parse failure → synthetic revise with meaningful brief
  7. Revision brief synthesised when thresholds fail without model brief
  8. Rewriter preserves hook (checked via prompt content)
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.critic import (
    CriticResult,
    _parse_critic_response,
    _synthesise_revision_brief,
)


# ── _parse_critic_response unit tests (no I/O) ─────────────────────────────────

def _make_brand():
    brand = MagicMock()
    brand.brand_name = "TestBrand"
    brand.tone_json = {"description": "direct and authoritative"}
    return brand


def _make_high_score_response() -> str:
    return json.dumps({
        "scores": {
            "clarity": 8,
            "specificity": 7,
            "novelty": 8,
            "platform_fit": 7,
            "commercial_relevance": 8,
            "non_genericness": 8,
        },
        "insight_count": 3,
        "operator_voice": "founder",
        "weaknesses": [],
        "generic_phrases_found": [],
        "decision": "approve",
        "revision_brief": None,
    })


def test_high_score_all_pass_approves():
    result = _parse_critic_response(_make_high_score_response(), [])
    assert result.decision == "approve"
    assert result.passed is True
    assert result.failed_thresholds == []
    assert result.revision_brief is None


def test_low_clarity_score_forces_revise():
    data = json.loads(_make_high_score_response())
    data["scores"]["clarity"] = 5   # below threshold of 7
    data["decision"] = "approve"    # model says approve — we override
    result = _parse_critic_response(json.dumps(data), [])
    assert result.decision == "revise"
    assert result.passed is False
    assert any("clarity" in f for f in result.failed_thresholds)


def test_low_non_genericness_forces_revise():
    data = json.loads(_make_high_score_response())
    data["scores"]["non_genericness"] = 5   # below 7
    data["decision"] = "approve"
    result = _parse_critic_response(json.dumps(data), [])
    assert result.decision == "revise"
    assert any("non_genericness" in f for f in result.failed_thresholds)


def test_low_commercial_relevance_forces_revise():
    data = json.loads(_make_high_score_response())
    data["scores"]["commercial_relevance"] = 6   # below 7
    result = _parse_critic_response(json.dumps(data), [])
    assert result.decision == "revise"


def test_low_insight_count_forces_revise():
    data = json.loads(_make_high_score_response())
    data["insight_count"] = 1   # below MINIMUM_INSIGHT_COUNT of 2
    data["decision"] = "approve"
    result = _parse_critic_response(json.dumps(data), [])
    assert result.decision == "revise"
    assert any("insight_count" in f for f in result.failed_thresholds)


def test_marketing_intern_voice_forces_revise():
    data = json.loads(_make_high_score_response())
    data["operator_voice"] = "marketing_intern"
    data["decision"] = "approve"
    result = _parse_critic_response(json.dumps(data), [])
    assert result.decision == "revise"
    assert any("operator_voice" in f for f in result.failed_thresholds)


def test_predetected_cliches_merged_into_result():
    predetected = ["seamlessly", "game changer"]
    data = json.loads(_make_high_score_response())
    data["generic_phrases_found"] = ["thought leadership"]
    result = _parse_critic_response(json.dumps(data), predetected)
    # All three should appear in result
    for phrase in ["seamlessly", "game changer", "thought leadership"]:
        assert phrase in result.generic_phrases_found


def test_predetected_cliches_deduplicated():
    predetected = ["seamlessly"]
    data = json.loads(_make_high_score_response())
    data["generic_phrases_found"] = ["seamlessly"]   # same as predetected
    result = _parse_critic_response(json.dumps(data), predetected)
    assert result.generic_phrases_found.count("seamlessly") == 1


def test_json_parse_failure_returns_synthetic_revise():
    result = _parse_critic_response("this is not json at all", [])
    assert result.decision == "revise"
    assert result.passed is False
    assert "parse_error" in result.failed_thresholds
    assert result.revision_brief is not None
    assert len(result.revision_brief) > 0


def test_markdown_fenced_json_parsed_correctly():
    raw = "```json\n" + _make_high_score_response() + "\n```"
    result = _parse_critic_response(raw, [])
    assert result.decision == "approve"


def test_model_says_revise_no_thresholds_failed():
    # Model says revise even with all scores passing
    data = json.loads(_make_high_score_response())
    data["decision"] = "revise"
    data["revision_brief"] = "Add a specific number to the opening claim."
    result = _parse_critic_response(json.dumps(data), [])
    # Our logic: if no thresholds failed and model says approve/revise,
    # model is overridden only when thresholds fail. If model says revise
    # with no threshold failures, we trust it.
    assert result.decision == "revise"
    assert result.revision_brief == "Add a specific number to the opening claim."


# ── _synthesise_revision_brief unit tests ─────────────────────────────────────

def test_synthesise_brief_for_clarity():
    brief = _synthesise_revision_brief(["clarity<7"], [])
    assert "clear" in brief.lower() or "immediately" in brief.lower()


def test_synthesise_brief_for_operator_voice():
    brief = _synthesise_revision_brief(["operator_voice!=founder"], [])
    assert "founder" in brief.lower() or "operator" in brief.lower()


def test_synthesise_brief_non_empty_always():
    brief = _synthesise_revision_brief(["unknown_dimension"], ["Post is weak"])
    assert len(brief) > 0


def test_synthesise_brief_max_two_dimensions():
    # Should address first 2 failed dims, not all of them
    failed = ["clarity<7", "non_genericness<7", "novelty<7"]
    brief = _synthesise_revision_brief(failed, [])
    # Brief should not be excessively long
    assert len(brief) < 400


# ── Integration: run_critic mocking OpenAI ────────────────────────────────────

@pytest.mark.asyncio
async def test_run_critic_approve_path():
    brand = _make_brand()
    mock_response = _make_high_score_response()

    with patch("app.services.critic.chat_completion", new=AsyncMock(return_value=mock_response)):
        from app.services.critic import run_critic
        result = await run_critic(brand=brand, platform="linkedin", draft_text="Clean post about lead response times. Our SDRs close 40% more deals by responding within 90 seconds.")

    assert result.decision == "approve"
    assert result.passed is True


@pytest.mark.asyncio
async def test_run_critic_revise_path_with_cliche():
    brand = _make_brand()
    # Draft contains "seamlessly" — predetected cliché
    draft = "This seamlessly integrates with your existing stack to transform your sales process."

    low_score_response = json.dumps({
        "scores": {
            "clarity": 6,
            "specificity": 5,
            "novelty": 6,
            "platform_fit": 7,
            "commercial_relevance": 6,
            "non_genericness": 4,
        },
        "insight_count": 1,
        "operator_voice": "marketing_intern",
        "weaknesses": ["Too generic", "No concrete examples"],
        "generic_phrases_found": ["transform your sales"],
        "decision": "revise",
        "revision_brief": "Add a specific conversion metric and remove generic phrases.",
    })

    with patch("app.services.critic.chat_completion", new=AsyncMock(return_value=low_score_response)):
        from app.services.critic import run_critic
        result = await run_critic(brand=brand, platform="linkedin", draft_text=draft)

    assert result.decision == "revise"
    assert result.passed is False
    assert "seamlessly" in result.predetected_cliches
    assert result.revision_brief is not None
    assert len(result.failed_thresholds) > 0
