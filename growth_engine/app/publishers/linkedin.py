"""
LinkedIn publisher adapter.

API: LinkedIn UGC Posts v2 (personal profile posting)
Endpoint: POST https://api.linkedin.com/v2/ugcPosts
Auth: Bearer {access_token}
Scope required: w_member_social (granted by "Share on LinkedIn" product)

NOTE ON COMPANY PAGE POSTING
Company/org page posting via urn:li:organization requires the
"Community Management API" product on a SEPARATE LinkedIn Developer App
(LinkedIn enforces 1-product-per-app for Community Management API).
Until that new app is created and approved, ALL posts go to the
authenticated user's personal profile (urn:li:person:).

Text post payload:
  {
    "author": "urn:li:person:{id}",
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

_UGC_URL             = "https://api.linkedin.com/v2/ugcPosts"
_REGISTER_UPLOAD_URL = "https://api.linkedin.com/v2/assets?action=registerUpload"
_API_VERSION_HEADER  = {"LinkedIn-Version": "202304"}


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
        # Always post as personal profile — org posting requires Community
        # Management API on a separate app (not yet approved).
        author_urn = _personal_urn(req.platform_account_id)

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
        """Upload image to LinkedIn in two steps. Returns asset URN or None."""
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
                headers=auth_headers,
            )

        if reg_resp.status_code not in (200, 201):
            log.warning("linkedin_register_upload_failed", status=reg_resp.status_code)
            return None

        try:
            reg_body   = reg_resp.json()
            upload_url = (
                reg_body["value"]["uploadMechanism"]
                ["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]
                ["uploadUrl"]
            )
            asset_urn = reg_body["value"]["asset"]
        except (KeyError, TypeError):
            log.warning("linkedin_register_parse_failed")
            return None

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


def _personal_urn(platform_account_id: str) -> str:
    """
    Return a personal profile URN (urn:li:person:).

    If the stored account ID is an org URN (urn:li:organization:), we cannot
    post to it — Community Management API (separate app) is required for that.
    In that case, fall back gracefully by logging a warning. The caller should
    ensure resolve_linkedin_account always returns a person URN for now.
    """
    if platform_account_id.startswith("urn:li:person:"):
        return platform_account_id
    if platform_account_id.startswith("urn:li:organization:"):
        # Org posting not supported yet — log and use as-is (will fail at LinkedIn
        # with a clear error). resolve_linkedin_account should prevent this case.
        log.warning("linkedin_org_urn_not_supported_fallback",
                    urn=platform_account_id[:40])
        return platform_account_id
    # Bare ID — treat as person URN
    return f"urn:li:person:{platform_account_id}"


def _li_urn_to_url(post_urn: str) -> Optional[str]:
    if not post_urn:
        return None
    return f"https://www.linkedin.com/feed/update/{post_urn}"


def _extract_li_error(body) -> str:
    if not body:
        return "Unknown LinkedIn error"
    if isinstance(body, dict):
        return str(body.get("message", body.get("error", str(body)[:200])))
    return str(body)[:200]
