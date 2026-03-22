"""
Tests for cliché detector.

The detector is the cheapest quality gate — pure string matching.
These tests verify: phrase detection, clean text, case insensitivity,
partial word matching, and the is_clean helper.
"""

from __future__ import annotations

import pytest

from app.services.cliche_detector import (
    BANNED_PHRASES,
    detect_cliches,
    get_banned_phrases,
    is_clean,
)


def test_clean_text_returns_empty():
    text = "Most sales teams lose deals in the first 90 seconds. Here is why."
    assert detect_cliches(text) == []


def test_banned_phrase_detected():
    text = "This will revolutionize how you sell."
    found = detect_cliches(text)
    assert "revolutionize" in found


def test_multiple_banned_phrases_detected():
    text = "This game changer will seamlessly transform your business."
    found = detect_cliches(text)
    assert len(found) >= 2
    assert "game changer" in found or "game-changer" in found
    assert "seamlessly" in found


def test_case_insensitive():
    text = "REVOLUTIONIZE your entire pipeline today."
    found = detect_cliches(text)
    assert "revolutionize" in found


def test_case_insensitive_mixed():
    text = "This is a Game Changer for any operator."
    found = detect_cliches(text)
    assert "game changer" in found or "game-changer" in found


def test_is_clean_true_for_clean_text():
    text = "Response time under 2 minutes determines whether you get the meeting."
    assert is_clean(text) is True


def test_is_clean_false_for_banned_text():
    text = "We empower businesses to take their business to the next level."
    assert is_clean(text) is False


def test_deep_dive_banned():
    text = "Let us do a deep dive into your pipeline metrics."
    found = detect_cliches(text)
    assert "deep dive" in found


def test_thought_leadership_banned():
    text = "Our thought leadership content drives brand awareness."
    found = detect_cliches(text)
    assert "thought leadership" in found


def test_actionable_insights_banned():
    text = "Get actionable insights from your sales data."
    found = detect_cliches(text)
    assert "actionable insights" in found


def test_value_proposition_banned():
    text = "Your value proposition needs to be clearer."
    found = detect_cliches(text)
    assert "value proposition" in found


def test_supercharge_banned():
    text = "Supercharge your team with AI."
    found = detect_cliches(text)
    assert "supercharge" in found


def test_get_banned_phrases_returns_list():
    phrases = get_banned_phrases()
    assert isinstance(phrases, list)
    assert len(phrases) > 0
    assert all(isinstance(p, str) for p in phrases)
    # Should match the module-level list
    assert phrases == list(BANNED_PHRASES)


def test_partial_word_match():
    # "revolutionize" should match "revolutionizes"
    text = "This approach revolutionizes the sales process."
    found = detect_cliches(text)
    assert "revolutionize" in found


def test_hyphenated_variant():
    # Both "game changer" and "game-changer" are in the ban list
    text = "This is a game-changer."
    found = detect_cliches(text)
    assert "game-changer" in found


def test_empty_string_is_clean():
    assert detect_cliches("") == []
    assert is_clean("") is True


def test_whitespace_only_is_clean():
    assert detect_cliches("   \n\t  ") == []


def test_synergy_banned():
    text = "We need to find synergy between the two teams."
    found = detect_cliches(text)
    assert "synergy" in found
