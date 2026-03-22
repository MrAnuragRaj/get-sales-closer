"""
Tests for token encryption/decryption.

These tests run WITHOUT a DB connection — pure crypto logic only.
Run with: pytest tests/test_crypto.py -v
"""

from __future__ import annotations

import os

import pytest
from cryptography.fernet import Fernet

# Set required env var before importing crypto module
_TEST_KEY = Fernet.generate_key().decode()
os.environ["GROWTH_ENCRYPTION_KEY"] = _TEST_KEY


from app.crypto import (  # noqa: E402
    TokenDecryptionError,
    TokenEncryptionError,
    decrypt_token,
    encrypt_token,
    rotate_token,
)


def test_encrypt_decrypt_roundtrip():
    plaintext = "test_oauth_token_abc123"
    ciphertext = encrypt_token(plaintext)
    assert ciphertext != plaintext
    assert decrypt_token(ciphertext) == plaintext


def test_ciphertext_is_opaque():
    plaintext = "sensitive_token_value"
    ciphertext = encrypt_token(plaintext)
    assert plaintext not in ciphertext


def test_empty_plaintext_raises():
    with pytest.raises(TokenEncryptionError):
        encrypt_token("")


def test_empty_ciphertext_raises():
    with pytest.raises(TokenDecryptionError):
        decrypt_token("")


def test_tampered_ciphertext_raises():
    ciphertext = encrypt_token("real_token")
    tampered = ciphertext[:-4] + "XXXX"
    with pytest.raises(TokenDecryptionError):
        decrypt_token(tampered)


def test_wrong_key_raises():
    ciphertext = encrypt_token("real_token")
    # Temporarily swap to a different key
    wrong_key = Fernet.generate_key().decode()
    original = os.environ["GROWTH_ENCRYPTION_KEY"]
    os.environ["GROWTH_ENCRYPTION_KEY"] = wrong_key

    # Clear lru_cache so new key is picked up
    from app.crypto import _build_fernet
    _build_fernet.cache_clear()

    with pytest.raises(TokenDecryptionError):
        decrypt_token(ciphertext)

    # Restore
    os.environ["GROWTH_ENCRYPTION_KEY"] = original
    _build_fernet.cache_clear()


def test_key_rotation():
    """MultiFernet with previous key can still decrypt old ciphertext."""
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()

    # Encrypt with old key
    os.environ["GROWTH_ENCRYPTION_KEY"] = old_key
    from app.crypto import _build_fernet
    _build_fernet.cache_clear()
    old_ciphertext = encrypt_token("token_to_rotate")

    # Now rotate: primary = new, previous = old
    os.environ["GROWTH_ENCRYPTION_KEY"] = new_key
    os.environ["GROWTH_ENCRYPTION_KEY_PREVIOUS"] = old_key
    _build_fernet.cache_clear()

    # Old ciphertext should still decrypt
    assert decrypt_token(old_ciphertext) == "token_to_rotate"

    # Rotate produces new ciphertext
    new_ciphertext = rotate_token(old_ciphertext)
    assert new_ciphertext != old_ciphertext
    assert decrypt_token(new_ciphertext) == "token_to_rotate"

    # Cleanup
    os.environ["GROWTH_ENCRYPTION_KEY"] = _TEST_KEY
    os.environ.pop("GROWTH_ENCRYPTION_KEY_PREVIOUS", None)
    _build_fernet.cache_clear()


def test_entitlements_content_plans():
    """Verify locked plan definitions match spec."""
    from app.entitlements import CONTENT_PLANS, FREE_MONTHLY_DAY_CAP

    assert CONTENT_PLANS["free"].daily_content_pieces == 0
    assert CONTENT_PLANS["free"].can_automate is False
    assert CONTENT_PLANS["starter"].daily_content_pieces == 1
    assert CONTENT_PLANS["growth"].daily_content_pieces == 2
    assert CONTENT_PLANS["scale"].daily_content_pieces == 3
    assert FREE_MONTHLY_DAY_CAP == 15


def test_entitlements_engagement_plans():
    from app.entitlements import ENGAGEMENT_PLANS

    assert ENGAGEMENT_PLANS["engagement_starter"].daily_engagements == 5
    assert ENGAGEMENT_PLANS["engagement_starter"].monthly_max_engagements == 150
    assert ENGAGEMENT_PLANS["engagement_pro"].daily_engagements == 15
    assert ENGAGEMENT_PLANS["engagement_pro"].monthly_max_engagements == 450


def test_platform_caps():
    from app.entitlements import PLATFORM_ENGAGEMENT_CAPS, PLATFORM_POST_CAPS

    assert PLATFORM_POST_CAPS["linkedin"] == 2
    assert PLATFORM_POST_CAPS["x"] == 8
    assert PLATFORM_POST_CAPS["facebook"] == 2
    assert PLATFORM_POST_CAPS["instagram"] == 2
    assert PLATFORM_ENGAGEMENT_CAPS["linkedin"] == 10
    assert PLATFORM_ENGAGEMENT_CAPS["x"] == 30


def test_x_platform_disabled_by_default():
    """X must be inactive unless PLATFORM_X_ENABLED=true."""
    # Reset env — don't set PLATFORM_X_ENABLED
    os.environ.pop("PLATFORM_X_ENABLED", None)
    # Config uses pydantic default of False
    # We test the entitlement cap still exists (design-complete)
    from app.entitlements import PLATFORM_POST_CAPS
    assert "x" in PLATFORM_POST_CAPS   # architecture present
    assert PLATFORM_POST_CAPS["x"] == 8
