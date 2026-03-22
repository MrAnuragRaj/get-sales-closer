"""
Instagram publisher.

API: Meta Graph API v19.0 — Instagram Content Publishing API
Two-step process:
  Step 1: POST /{ig_user_id}/media
            → creates a media container
            → returns {"id": "<container_id>"}
  Step 2: POST /{ig_user_id}/media_publish
            → publishes the container
            → returns {"id": "<media_id>"}

Image requirement (v1):
  Instagram publishing requires an image.
  If no asset_url is present, the item is rejected with CONTENT_REJECTED.
  This is a platform constraint — Instagram does not support text-only posts
  via the Content Publishing API.

platform_account_id = Instagram Business Account ID
  (stored in social_accounts; linked to a Facebook Page via meta_connection_id)
"""

from __future__ import annotations

import httpx

from app.logging_config import get_logger
from app.publishers.base import BasePublisher, PublishRequest, PublishResult, sanitize_for_log
from app.publishers.error_normalizer import normalize_error

log = get_logger(__name__)

_GRAPH_VERSION = "v19.0"
_GRAPH_BASE    = f"https://graph.facebook.com/{_GRAPH_VERSION}"


class InstagramPublisher(BasePublisher):

    async def publish(self, req: PublishRequest) -> PublishResult:
        try:
            return await self._publish(req)
        except Exception as exc:
            log.error("instagram_publisher_unexpected", error=str(exc))
            return PublishResult(
                success=False,
                error_category=normalize_error("instagram", None, None, exc),
                error_message=str(exc),
            )

    async def _publish(self, req: PublishRequest) -> PublishResult:
        if not req.asset_url:
            # Instagram requires an image — reject without calling the API
            return PublishResult(
                success=False,
                error_category="CONTENT_REJECTED",
                error_message=(
                    "Instagram publishing requires an image asset. "
                    "Generate an image template first via POST /drafts/{id}/assets."
                ),
            )

        ig_user_id = req.platform_account_id

        # ── Step 1: Create media container ────────────────────────────────────
        container_id, step1_result = await self._create_container(req, ig_user_id)
        if container_id is None:
            return step1_result

        # ── Step 2: Publish container ─────────────────────────────────────────
        return await self._publish_container(req, ig_user_id, container_id, step1_result)

    async def _create_container(
        self,
        req: PublishRequest,
        ig_user_id: str,
    ) -> tuple[str | None, PublishResult | None]:
        url = f"{_GRAPH_BASE}/{ig_user_id}/media"
        payload = {
            "image_url":    req.asset_url,
            "caption":      req.caption_text or req.body_text,
            "access_token": req.access_token,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, data=payload)

        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            container_id = body.get("id")
            if container_id:
                return container_id, None
            return None, PublishResult(
                success=False,
                http_status=http_status,
                error_category="PERMANENT",
                error_message="Instagram container creation returned no ID",
                response_json=sanitize_for_log(body),
            )

        category = normalize_error("instagram", http_status, body)
        return None, PublishResult(
            success=False,
            http_status=http_status,
            error_category=category,
            error_message=_extract_meta_error(body),
            request_json=sanitize_for_log(payload),
            response_json=sanitize_for_log(body),
        )

    async def _publish_container(
        self,
        req: PublishRequest,
        ig_user_id: str,
        container_id: str,
        step1_result,
    ) -> PublishResult:
        url = f"{_GRAPH_BASE}/{ig_user_id}/media_publish"
        payload = {
            "creation_id":  container_id,
            "access_token": req.access_token,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, data=payload)

        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            media_id = body.get("id", "")
            return PublishResult(
                success=True,
                platform_post_id=media_id,
                platform_post_url=f"https://www.instagram.com/p/{media_id}" if media_id else None,
                http_status=http_status,
                request_json=sanitize_for_log({"container_id": container_id}),
                response_json=sanitize_for_log(body),
            )

        category = normalize_error("instagram", http_status, body)
        return PublishResult(
            success=False,
            http_status=http_status,
            error_category=category,
            error_message=_extract_meta_error(body),
            request_json=sanitize_for_log(payload),
            response_json=sanitize_for_log(body),
        )


def _extract_meta_error(body: dict | None) -> str:
    if not body:
        return "Unknown Instagram/Meta error"
    error = body.get("error", {})
    if isinstance(error, dict):
        return str(error.get("message", str(body)[:200]))
    return str(body)[:200]
