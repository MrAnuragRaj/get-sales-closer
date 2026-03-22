"""
Base publisher interface and shared data types.

All platform adapters accept a PublishRequest and return a PublishResult.
The queue worker constructs the request, calls the publisher, and transitions
the queue item state based on the result.

Security rules (locked):
  - request_json stored in publish_logs MUST NOT contain plaintext tokens
  - response_json stored in publish_logs MUST NOT contain plaintext tokens
  - sanitize_for_log() strips known token fields before persistence
  - Tokens are decrypted from Fernet ciphertext immediately before the API call
    and must not be stored or logged anywhere after use
"""

from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class PublishRequest:
    """Everything a publisher needs to make one API call."""
    queue_id:            uuid.UUID
    org_id:              uuid.UUID
    platform:            str
    variant_id:          uuid.UUID
    body_text:           str
    platform_account_id: str          # URN / page_id / user_id depending on platform
    access_token:        str          # plaintext — decrypted from Fernet, never logged
    idempotency_key:     str
    asset_url:           Optional[str] = None   # public Supabase Storage URL
    caption_text:        Optional[str] = None   # Instagram caption override


@dataclass
class PublishResult:
    """Outcome of a single publish attempt."""
    success:              bool
    platform_post_id:     Optional[str] = None   # platform-returned post/media ID
    platform_post_url:    Optional[str] = None   # permalink if available
    http_status:          Optional[int] = None
    error_category:       Optional[str] = None   # canonical — see error_normalizer.py
    error_message:        Optional[str] = None   # human-readable
    request_json:         Optional[dict] = None  # sanitized (no tokens)
    response_json:        Optional[dict] = None  # sanitized (no tokens)

    @property
    def failed(self) -> bool:
        return not self.success


class BasePublisher(ABC):
    """Abstract base — each platform adapter implements publish()."""

    @abstractmethod
    async def publish(self, req: PublishRequest) -> PublishResult:
        """Execute the publish. Never raises — errors are returned in result."""
        ...


# ── Log sanitization ───────────────────────────────────────────────────────────

# Fields that must never appear in publish_logs
_TOKEN_FIELDS = frozenset({
    "access_token", "accessToken", "access_token_secret",
    "client_secret", "client_id", "Authorization",
    "bearer_token", "refresh_token",
})


def sanitize_for_log(payload: Optional[dict]) -> Optional[dict]:
    """
    Recursively strip token fields from a dict before writing to publish_logs.
    Returns None if payload is None.
    """
    if payload is None:
        return None
    return _scrub(payload)


def _scrub(obj):
    if isinstance(obj, dict):
        return {
            k: "[REDACTED]" if k in _TOKEN_FIELDS else _scrub(v)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_scrub(item) for item in obj]
    return obj
