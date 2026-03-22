"""
X (Twitter) publisher — DORMANT in v1.

Architecture is complete. Publishing is blocked behind PLATFORM_X_ENABLED=false.
When X is activated: set PLATFORM_X_ENABLED=true in environment.
No code or schema changes are needed.

v2 API implementation sketch (active when PLATFORM_X_ENABLED=true):
  POST https://api.twitter.com/2/tweets
  Auth: OAuth 2.0 Bearer token (user context)
  Body: {"text": "<body_text>"}

  For image tweet:
    Step 1: POST https://upload.twitter.com/1.1/media/upload.json
    Step 2: reference media_id in tweet body

When disabled:
  - publish() returns PublishResult(success=False, error_category="PLATFORM_DISABLED")
  - Queue item transitions to 'failed' with last_error='x_platform_disabled'
  - No API call is made
"""

from __future__ import annotations

from app.config import settings
from app.logging_config import get_logger
from app.publishers.base import BasePublisher, PublishRequest, PublishResult

log = get_logger(__name__)

_TWEETS_URL  = "https://api.twitter.com/2/tweets"
_MEDIA_URL   = "https://upload.twitter.com/1.1/media/upload.json"


class XPublisher(BasePublisher):
    """
    X publisher — dormant in v1.
    Returns PLATFORM_DISABLED immediately if PLATFORM_X_ENABLED=false.
    """

    async def publish(self, req: PublishRequest) -> PublishResult:
        if not settings.platform_x_enabled:
            log.info(
                "x_publish_blocked_disabled",
                queue_id=str(req.queue_id),
                note="Set PLATFORM_X_ENABLED=true to activate X publishing",
            )
            return PublishResult(
                success=False,
                error_category="PLATFORM_DISABLED",
                error_message=(
                    "X (Twitter) publishing is not enabled in v1. "
                    "Set PLATFORM_X_ENABLED=true to activate."
                ),
            )

        # ── Active path (executed only when PLATFORM_X_ENABLED=true) ──────────
        try:
            return await self._publish_active(req)
        except Exception as exc:
            log.error("x_publisher_unexpected", error=str(exc))
            return PublishResult(
                success=False,
                error_category="RETRYABLE",
                error_message=str(exc),
            )

    async def _publish_active(self, req: PublishRequest) -> PublishResult:
        """
        v2 Tweets API implementation.
        Called only when PLATFORM_X_ENABLED=true.
        """
        import httpx
        from app.publishers.base import sanitize_for_log
        from app.publishers.error_normalizer import normalize_error

        headers = {
            "Authorization": f"Bearer {req.access_token}",
            "Content-Type":  "application/json",
        }

        # Upload media if present
        media_ids: list[str] = []
        if req.asset_url:
            media_id = await self._upload_media(req.asset_url, req.access_token)
            if media_id:
                media_ids.append(media_id)

        payload: dict = {"text": req.body_text}
        if media_ids:
            payload["media"] = {"media_ids": media_ids}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(_TWEETS_URL, json=payload, headers=headers)

        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            tweet_id = body.get("data", {}).get("id", "")
            return PublishResult(
                success=True,
                platform_post_id=tweet_id,
                platform_post_url=f"https://x.com/i/web/status/{tweet_id}" if tweet_id else None,
                http_status=http_status,
                request_json=sanitize_for_log(payload),
                response_json=sanitize_for_log(body),
            )

        category = normalize_error("x", http_status, body)
        return PublishResult(
            success=False,
            http_status=http_status,
            error_category=category,
            error_message=str(body.get("detail", body.get("title", "Unknown X error"))),
            request_json=sanitize_for_log(payload),
            response_json=sanitize_for_log(body),
        )

    async def _upload_media(self, asset_url: str, access_token: str) -> str | None:
        """Upload image to Twitter v1.1 media endpoint. Returns media_id or None."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                img_resp = await client.get(asset_url)
                if img_resp.status_code != 200:
                    return None
                upload_resp = await client.post(
                    _MEDIA_URL,
                    files={"media": img_resp.content},
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            if upload_resp.status_code in (200, 201):
                return upload_resp.json().get("media_id_string")
        except Exception as exc:
            log.warning("x_media_upload_failed", error=str(exc))
        return None
