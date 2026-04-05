"""
LinkedIn publisher adapter.

API: LinkedIn Posts API (v2 replacement — posts endpoint)
Endpoint: POST https://api.linkedin.com/rest/posts
LinkedIn-Version: 202501
Auth: Bearer {access_token}

Text post payload:
  {
    "author": "urn:li:person:{id}" or "urn:li:organization:{id}",
    "commentary": "<body_text>",
    "visibility": "PUBLIC",
    "distribution": {
      "feedDistribution": "MAIN_FEED",
      "targetEntities": [],
      "thirdPartyDistributionChannels": []
    },
    "lifecycleState": "PUBLISHED",
    "isReshareDisabledByAuthor": false
  }

Image post (2-step upload then reference):
  Step 1: POST /rest/images?action=initializeUpload
          body: {"initializeUploadRequest": {"owner": "<author_urn>"}}
          → uploadUrl + image URN
  Step 2: PUT uploadUrl with raw image bytes
  Step 3: posts payload with content block referencing image URN

The platform_account_id in social_accounts stores the full URN
(e.g., "urn:li:person:ABC123" or "urn:li:organization:12345").
If it is bare (no "urn:li:" prefix), it is treated as a person ID.

Scope required:
  w_member_social   — post as person
  w_organization_social — post as organization (requires MDP approval)

Idempotency: LinkedIn has no request-level idempotency key.
The queue worker checks publish_logs for prior success before calling the API.
"""

from __future__ import annotations

from typing import Optional

import httpx

from app.logging_config import get_logger
from app.publishers.base import BasePublisher, PublishRequest, PublishResult, sanitize_for_log
from app.publishers.error_normalizer import normalize_error

log = get_logger(__name__)

_POSTS_URL   = "https://api.linkedin.com/rest/posts"
_IMAGES_URL  = "https://api.linkedin.com/rest/images?action=initializeUpload"
_LI_VERSION  = "202501"


class LinkedInPublisher(BasePublisher):

    async def publish(self, req: PublishRequest) -> PublishResult:
        """Post to LinkedIn. Returns result — never raises."""
        try:
            return await self._publish(req)
        except Exception as exc:
            log.error("linkedin_publisher_unexpected", error=str(exc))
            category = normalize_error("linkedin", None, None, exc)
            return PublishResult(
                success=False,
                error_category=category,
                error_message=str(exc),
            )

    async def _publish(self, req: PublishRequest) -> PublishResult:
        author_urn = _ensure_urn(req.platform_account_id)
        headers = {
            "Authorization":    f"Bearer {req.access_token}",
            "Content-Type":     "application/json",
            "LinkedIn-Version": _LI_VERSION,
            # NOTE: do NOT include X-Restli-Protocol-Version for /rest/* endpoints
            # That header is only for the legacy /v2/ RestLi API
        }

        # Upload image if asset is present
        li_image_urn: Optional[str] = None
        if req.asset_url:
            li_image_urn = await self._upload_image(req.asset_url, author_urn, headers)
            if li_image_urn is None:
                log.warning("linkedin_image_upload_failed_fallback_text",
                            queue_id=str(req.queue_id))

        payload = _build_post_payload(
            author_urn=author_urn,
            body_text=req.body_text,
            li_image_urn=li_image_urn,
        )

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(_POSTS_URL, json=payload, headers=headers)

        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            # Posts API returns the post URN in the `id` field or X-RestLi-Id header
            post_urn = (body.get("id") if isinstance(body, dict) else None) \
                       or resp.headers.get("x-restli-id", "")
            return PublishResult(
                success=True,
                platform_post_id=post_urn,
                platform_post_url=_li_urn_to_url(post_urn),
                http_status=http_status,
                request_json=sanitize_for_log(payload),
                response_json=sanitize_for_log(body),
            )

        category = normalize_error("linkedin", http_status, body)
        return PublishResult(
            success=False,
            http_status=http_status,
            error_category=category,
            error_message=_extract_li_error(body),
            request_json=sanitize_for_log(payload),
            response_json=sanitize_for_log(body),
        )

    async def _upload_image(
        self,
        asset_url: str,
        author_urn: str,
        auth_headers: dict,
    ) -> Optional[str]:
        """
        Upload image to LinkedIn using the Images API (new endpoint).
        Returns LinkedIn image URN on success, None on failure.
        """
        # Step 1: initialize upload
        init_payload = {
            "initializeUploadRequest": {
                "owner": author_urn,
            }
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            init_resp = await client.post(
                _IMAGES_URL,
                json=init_payload,
                headers=auth_headers,
            )

        if init_resp.status_code not in (200, 201):
            log.warning("linkedin_image_init_failed", status=init_resp.status_code,
                        body=init_resp.text[:200])
            return None

        try:
            init_body   = init_resp.json()
            upload_url  = init_body["value"]["uploadUrl"]
            image_urn   = init_body["value"]["image"]
        except (KeyError, TypeError):
            log.warning("linkedin_image_init_parse_failed")
            return None

        # Step 2: fetch image bytes from Supabase Storage, PUT to LinkedIn
        async with httpx.AsyncClient(timeout=60.0) as client:
            img_resp = await client.get(asset_url)
            if img_resp.status_code != 200:
                log.warning("linkedin_image_fetch_failed", status=img_resp.status_code)
                return None

            up_resp = await client.put(
                upload_url,
                content=img_resp.content,
                headers={"Content-Type": "image/png"},
            )

        if up_resp.status_code not in (200, 201):
            log.warning("linkedin_image_upload_put_failed", status=up_resp.status_code)
            return None

        return image_urn


# ── Payload builders ───────────────────────────────────────────────────────────

def _build_post_payload(
    author_urn: str,
    body_text: str,
    li_image_urn: Optional[str],
) -> dict:
    payload: dict = {
        "author": author_urn,
        "commentary": body_text,
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }

    if li_image_urn:
        payload["content"] = {
            "media": {
                "altText": body_text[:200],
                "id": li_image_urn,
            }
        }

    return payload


def _ensure_urn(platform_account_id: str) -> str:
    """Return a proper LinkedIn URN. Adds urn:li:person: prefix if bare ID."""
    if platform_account_id.startswith("urn:li:"):
        return platform_account_id
    return f"urn:li:person:{platform_account_id}"


def _li_urn_to_url(post_urn: str) -> Optional[str]:
    """Convert a LinkedIn post URN to a permalink where possible."""
    if not post_urn:
        return None
    return f"https://www.linkedin.com/feed/update/{post_urn}"


def _extract_li_error(body) -> str:
    if not body:
        return "Unknown LinkedIn error"
    if isinstance(body, dict):
        return str(body.get("message", body.get("error", str(body)[:200])))
    return str(body)[:200]
