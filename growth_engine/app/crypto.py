"""
Token encryption/decryption for social platform OAuth credentials.

──────────────────────────────────────────────────────────────────────────────
ENCRYPTION STRATEGY
──────────────────────────────────────────────────────────────────────────────

Algorithm: Fernet (AES-128-CBC + HMAC-SHA256) from the `cryptography` library.
This provides authenticated encryption — tampering with the ciphertext raises
InvalidToken, it cannot be silently corrupted.

Keys:
  GROWTH_ENCRYPTION_KEY          — current primary key (URL-safe base64, 32 bytes)
  GROWTH_ENCRYPTION_KEY_PREVIOUS — optional fallback key (only set during rotation)

Generate a key:
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

──────────────────────────────────────────────────────────────────────────────
EXACT RUNTIME BEHAVIOR
──────────────────────────────────────────────────────────────────────────────

Encrypt path (writing a new token to DB):
  1. encrypt_token(plaintext) called with the raw OAuth token string.
  2. _build_fernet() is called (lru_cache — runs once per process).
  3. MultiFernet.encrypt() uses GROWTH_ENCRYPTION_KEY (primary key only).
  4. Returns opaque URL-safe base64 ciphertext string.
  5. Ciphertext is written to growth.social_accounts.access_token_enc (or refresh_token_enc).
  6. Plaintext is not logged. Only ciphertext length is logged at DEBUG level.

Decrypt path (reading a token for runtime use):
  1. decrypt_token(ciphertext) called with the stored ciphertext string.
  2. MultiFernet.decrypt() tries GROWTH_ENCRYPTION_KEY first.
     If that fails, tries GROWTH_ENCRYPTION_KEY_PREVIOUS (if set).
  3. Returns plaintext string held only in memory.
  4. Plaintext is never logged, never returned to API callers, never persisted
     anywhere outside runtime memory.
  5. If both keys fail → TokenDecryptionError (key mismatch or corrupted data).

Key rotation procedure (exact steps):
  Step 1. Generate new key:
            python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  Step 2. Deploy with:
            GROWTH_ENCRYPTION_KEY         = <new key>
            GROWTH_ENCRYPTION_KEY_PREVIOUS = <old key>
  Step 3. Service now: encrypts all NEW tokens with new key,
                        decrypts EXISTING tokens with new key (fails → tries old key).
  Step 4. Run rotation utility (future script) to re-encrypt all rows:
            calls rotate_token(old_ciphertext) → new_ciphertext per row in DB.
  Step 5. Once all rows are re-encrypted, clear GROWTH_ENCRYPTION_KEY_PREVIOUS.
            Re-deploy. Old key is no longer in memory.

Token API return policy:
  - decrypt_token() is called only inside platform adapters / workers.
  - The plaintext value is passed directly to the HTTP client — never stored in a
    local variable named 'token' that might be included in a log statement.
  - API routes (brand.py, org_settings.py, etc.) NEVER return decrypted tokens.
    social_accounts endpoint (Phase 4) returns status + display_name only.

──────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.logging_config import get_logger

log = get_logger(__name__)


class TokenEncryptionError(Exception):
    """Raised when a token cannot be encrypted."""


class TokenDecryptionError(Exception):
    """Raised when a token cannot be decrypted (wrong key, corrupted data)."""


@lru_cache(maxsize=1)
def _build_fernet() -> MultiFernet:
    """
    Build MultiFernet from current + previous key(s).
    MultiFernet tries keys in order: primary first, then fallback.
    Cached per process — key material loaded once at startup.
    Raises RuntimeError if GROWTH_ENCRYPTION_KEY is missing.
    """
    primary_raw = os.environ.get("GROWTH_ENCRYPTION_KEY", "")
    if not primary_raw:
        raise RuntimeError(
            "GROWTH_ENCRYPTION_KEY is required but not set. "
            "Generate one with: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )

    keys: list[Fernet] = [Fernet(primary_raw.encode())]

    previous_raw = os.environ.get("GROWTH_ENCRYPTION_KEY_PREVIOUS", "")
    if previous_raw.strip():
        keys.append(Fernet(previous_raw.encode()))
        log.info("crypto_rotation_mode_active", fallback_key_present=True)

    return MultiFernet(keys)


def encrypt_token(plaintext: str) -> str:
    """
    Encrypt a social platform access or refresh token for DB storage.

    Args:
        plaintext: Raw OAuth token string (held only in memory, never logged).

    Returns:
        Opaque URL-safe base64 ciphertext suitable for text DB column.

    Raises:
        TokenEncryptionError: If encryption fails for any reason.
    """
    if not plaintext:
        raise TokenEncryptionError("Cannot encrypt empty token")

    try:
        fernet = _build_fernet()
        ciphertext = fernet.encrypt(plaintext.encode()).decode()
        # Log only the ciphertext length — NEVER the plaintext value.
        log.debug("token_encrypted", ciphertext_length=len(ciphertext))
        return ciphertext
    except (TokenEncryptionError, RuntimeError):
        raise
    except Exception as exc:
        log.error("token_encryption_failed", error_type=type(exc).__name__)
        raise TokenEncryptionError("Token encryption failed") from exc


def decrypt_token(ciphertext: str) -> str:
    """
    Decrypt a stored OAuth token for runtime use only.

    Args:
        ciphertext: Encrypted string from DB.

    Returns:
        Plaintext token string — caller must NOT log or persist this value.

    Raises:
        TokenDecryptionError: If the key doesn't match or data is corrupted.
    """
    if not ciphertext:
        raise TokenDecryptionError("Cannot decrypt empty ciphertext")

    try:
        fernet = _build_fernet()
        plaintext = fernet.decrypt(ciphertext.encode()).decode()
        # Log only confirmation — NEVER the plaintext value.
        log.debug("token_decrypted")
        return plaintext
    except InvalidToken:
        log.error(
            "token_decryption_failed",
            reason="invalid_token_or_wrong_key",
            hint="Check GROWTH_ENCRYPTION_KEY and GROWTH_ENCRYPTION_KEY_PREVIOUS",
        )
        raise TokenDecryptionError(
            "Token decryption failed — key mismatch or corrupted ciphertext. "
            "If you recently rotated keys, ensure GROWTH_ENCRYPTION_KEY_PREVIOUS is set."
        )
    except (TokenDecryptionError, RuntimeError):
        raise
    except Exception as exc:
        log.error("token_decryption_failed", error_type=type(exc).__name__)
        raise TokenDecryptionError("Token decryption failed") from exc


def rotate_token(ciphertext: str) -> str:
    """
    Re-encrypt a stored token using the current primary key only.

    Use this during key rotation to migrate existing rows.
    Decrypts with MultiFernet (tries all keys), re-encrypts with primary.

    Returns:
        New ciphertext encrypted with GROWTH_ENCRYPTION_KEY.
    """
    plaintext = decrypt_token(ciphertext)
    primary_raw = os.environ.get("GROWTH_ENCRYPTION_KEY", "")
    if not primary_raw:
        raise RuntimeError("GROWTH_ENCRYPTION_KEY not set")

    primary_fernet = Fernet(primary_raw.encode())
    new_ciphertext = primary_fernet.encrypt(plaintext.encode()).decode()
    log.info("token_rotated_to_new_key")
    return new_ciphertext
