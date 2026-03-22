"""
Facebook Page publisher.

API: Meta Graph API v19.0
Endpoint: POST /{page_id}/feed or /{page_id}/photos
Auth: Page access token (from Meta bundled backend)

Text post:
  POST /{page_id}/feed
  Body: {"message": "<body_text>", "access_token": "<token>"}
  Returns: {"id": "<page_id>_<post_id>"}

Image post (has asset_url):
  POST /{page_id}/photos
  Body: {"url": "<asset_url>", "caption": "<body_text>", "access_token": "<token>"}
  Returns: {"id": "<photo_id>", "post_id": "<page_id>_<post_id>"}

Published URL: https://www.facebook.com/{page_id}/posts/{post_id}

platform_account_id = Facebook Page ID (stored in social_accounts)
"""

from __future__ import annotations

import httpx

from app.logging_config import get_logger
from app.publishers.base import BasePublisher, PublishRequest, PublishResult, sanitize_for_log
from app.publishers.error_normalizer import normalize_error

log = get_logger(__name__)

_GRAPH_VERSION = "v19.0"
_GRAPH_BASE    = f"https://graph.facebook.com/{_GRAPH_VERSION}"


class FacebookPublisher(BasePublisher):

    async def publish(self, req: PublishRequest) -> PublishResult:
        try:
            return await self._publish(req)
        except Exception as exc:
            log.error("facebook_publisher_unexpected", error=str(exc))
            return PublishResult(
                success=False,
                error_category=normalize_error("facebook", None, None, exc),
                error_message=str(exc),
            )

    async def _publish(self, req: PublishRequest) -> PublishResult:
        page_id = req.platform_account_id

        if req.asset_url:
            return await self._post_photo(req, page_id)
        return await self._post_text(req, page_id)

    async def _post_text(self, req: PublishRequest, page_id: str) -> PublishResult:
        url = f"{_GRAPH_BASE}/{page_id}/feed"
        payload = {
            "message":      req.body_text,
            "access_token": req.access_token,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, data=payload)

        return self._parse_response(req, resp, "text", payload)

    async def _post_photo(self, req: PublishRequest, page_id: str) -> PublishResult:
        url = f"{_GRAPH_BASE}/{page_id}/photos"
        payload = {
            "url":          req.asset_url,
            "caption":      req.body_text,
            "access_token": req.access_token,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, data=payload)

        return self._parse_response(req, resp, "photo", payload)

    def _parse_response(
        self,
        req: PublishRequest,
        resp: httpx.Response,
        post_type: str,
        payload: dict,
    ) -> PublishResult:
        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            # For photos: use post_id field if present; fall back to id
            post_id = body.get("post_id") or body.get("id", "")
            # post_id format is "page_id_post_id" — extract post portion
            parts = post_id.split("_", 1)
            short_id = parts[1] if len(parts) == 2 else post_id
            post_url = f"https://www.facebook.com/{req.platform_account_id}/posts/{short_id}" if short_id else None

            return PublishResult(
                success=True,
                platform_post_id=post_id,
                platform_post_url=post_url,
                http_status=http_status,
                request_json=sanitize_for_log(payload),
                response_json=sanitize_for_log(body),
            )

        category = normalize_error("facebook", http_status, body)
        return PublishResult(
            success=False,
            http_status=http_status,
            error_category=category,
            error_message=_extract_fb_error(body),
            request_json=sanitize_for_log(payload),
            response_json=sanitize_for_log(body),
        )


def _extract_fb_error(body: dict | None) -> str:
    if not body:
        return "Unknown Facebook error"
    error = body.get("error", {})
    if isinstance(error, dict):
        return str(error.get("message", str(body)[:200]))
    return str(body)[:200]
