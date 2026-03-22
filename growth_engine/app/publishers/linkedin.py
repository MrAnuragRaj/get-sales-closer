"""
LinkedIn publisher adapter.

API: LinkedIn UGC Posts v2
Endpoint: POST https://api.linkedin.com/v2/ugcPosts
Auth: Bearer {access_token}

Text post payload:
  {
    "author": "urn:li:person:{account_id}",     ← stored in social_accounts.platform_account_id
    "lifecycleState": "PUBLISHED",
    "specificContent": {
      "com.linkedin.ugc.ShareContent": {
        "shareCommentary": {"text": "<body_text>"},
        "shareMediaCategory": "NONE"
      }
    },
    "visibility": {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
    }
  }

Image post (2-step upload then reference):
  Step 1: POST /v2/assets?action=registerUpload → upload_url + asset URN
  Step 2: PUT upload_url with image bytes
  Step 3: UGC post with shareMediaCategory="IMAGE" + media reference

The platform_account_id in social_accounts stores the full URN
(e.g., "urn:li:person:ABC123" or "urn:li:organization:12345").
If it is bare (no "urn:li:" prefix), it is treated as a person ID.

Idempotency: LinkedIn has no request-level idempotency key.
The queue worker checks publish_logs for prior success before calling the API.
"""

from __future__ import annotations

import io
from typing import Optional

import httpx

from app.logging_config import get_logger
from app.publishers.base import BasePublisher, PublishRequest, PublishResult, sanitize_for_log
from app.publishers.error_normalizer import normalize_error

log = get_logger(__name__)

_UGC_URL = "https://api.linkedin.com/v2/ugcPosts"
_REGISTER_UPLOAD_URL = "https://api.linkedin.com/v2/assets?action=registerUpload"
_API_VERSION_HEADER = {"LinkedIn-Version": "202304"}


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
            "Authorization": f"Bearer {req.access_token}",
            "Content-Type":  "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            **_API_VERSION_HEADER,
        }

        # Upload image to LinkedIn if asset is present
        li_asset_urn: Optional[str] = None
        if req.asset_url:
            li_asset_urn = await self._upload_image(req.asset_url, author_urn, headers)
            # If image upload fails, fall back to text-only post
            if li_asset_urn is None:
                log.warning("linkedin_image_upload_failed_fallback_text",
                            queue_id=str(req.queue_id))

        payload = _build_ugc_payload(
            author_urn=author_urn,
            body_text=req.body_text,
            li_asset_urn=li_asset_urn,
        )

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(_UGC_URL, json=payload, headers=headers)

        http_status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}

        if http_status in (200, 201):
            # LinkedIn returns the post URN in the `id` field (header or body)
            post_urn = body.get("id") or resp.headers.get("x-restli-id", "")
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
        Upload image to LinkedIn in two steps.
        Returns LinkedIn asset URN on success, None on failure.
        """
        # Step 1: register upload
        register_payload = {
            "registerUploadRequest": {
                "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                "owner": author_urn,
                "serviceRelationships": [
                    {
                        "relationshipType": "OWNER",
                        "identifier": "urn:li:userGeneratedContent",
                    }
                ],
            }
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            reg_resp = await client.post(
                _REGISTER_UPLOAD_URL,
                json=register_payload,
                headers={**auth_headers, "Content-Type": "application/json"},
            )

        if reg_resp.status_code not in (200, 201):
            log.warning("linkedin_register_upload_failed", status=reg_resp.status_code)
            return None

        try:
            reg_body = reg_resp.json()
            upload_url = (
                reg_body["value"]["uploadMechanism"]
                ["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]
                ["uploadUrl"]
            )
            asset_urn = reg_body["value"]["asset"]
        except (KeyError, TypeError):
            log.warning("linkedin_register_parse_failed")
            return None

        # Step 2: fetch image bytes from Supabase Storage, upload to LinkedIn
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

        return asset_urn


# ── Payload builders ───────────────────────────────────────────────────────────

def _build_ugc_payload(
    author_urn: str,
    body_text: str,
    li_asset_urn: Optional[str],
) -> dict:
    if li_asset_urn:
        media_category = "IMAGE"
        media = [
            {
                "status": "READY",
                "description": {"text": body_text[:200]},
                "media":  li_asset_urn,
                "title":  {"text": body_text[:80]},
            }
        ]
    else:
        media_category = "NONE"
        media = []

    content: dict = {
        "shareCommentary": {"text": body_text},
        "shareMediaCategory": media_category,
    }
    if media:
        content["media"] = media

    return {
        "author": author_urn,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": content,
        },
        "visibility": {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
    }


def _ensure_urn(platform_account_id: str) -> str:
    """Return a proper LinkedIn URN. Adds urn:li:person: prefix if bare ID."""
    if platform_account_id.startswith("urn:li:"):
        return platform_account_id
    return f"urn:li:person:{platform_account_id}"


def _li_urn_to_url(post_urn: str) -> Optional[str]:
    """Convert a LinkedIn post URN to a permalink where possible."""
    if not post_urn:
        return None
    # LinkedIn post URNs look like urn:li:share:7199... or urn:li:ugcPost:7199...
    return f"https://www.linkedin.com/feed/update/{post_urn}"


def _extract_li_error(body: Optional[dict]) -> str:
    if not body:
        return "Unknown LinkedIn error"
    return str(body.get("message", body.get("error", str(body)[:200])))
