"""
Tests for individual publisher adapters.

Covers:
  - LinkedIn: payload building (text-only, image, URN normalization)
  - Facebook: text vs photo routing, URL construction
  - Instagram: no-asset rejection, two-step flow
  - X: PLATFORM_DISABLED behavior
  - Meta: token resolution (Facebook direct, Instagram via meta_connection_id)
  - sanitize_for_log: token scrubbing

Run via: pytest tests/test_publishers.py
Requires: pytest-asyncio (in requirements.txt)
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _req(**overrides):
    from app.publishers.base import PublishRequest
    kwargs = dict(
        queue_id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        platform="linkedin",
        variant_id=uuid.uuid4(),
        body_text="Test post body text for publishing.",
        platform_account_id="urn:li:person:ABCD1234",
        access_token="secret_token_value",
        idempotency_key="test-ikey-001",
        asset_url=None,
        caption_text=None,
    )
    kwargs.update(overrides)
    return PublishRequest(**kwargs)


def _make_pool_and_conn():
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock(return_value="UPDATE 1")

    pool = MagicMock()
    pool.acquire = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


# ── sanitize_for_log ────────────────────────────────────────────────────────────

class TestSanitizeForLog:
    def test_redacts_access_token(self):
        from app.publishers.base import sanitize_for_log
        payload = {"text": "hello", "access_token": "secret123"}
        result = sanitize_for_log(payload)
        # Implementation replaces value with [REDACTED], keeps key
        assert result["access_token"] == "[REDACTED]"
        assert result["text"] == "hello"

    def test_redacts_authorization_header(self):
        from app.publishers.base import sanitize_for_log
        payload = {"Authorization": "Bearer supersecret"}
        result = sanitize_for_log(payload)
        assert result["Authorization"] == "[REDACTED]"

    def test_redacts_nested_token(self):
        from app.publishers.base import sanitize_for_log
        payload = {"wrapper": {"access_token": "nested_secret"}}
        result = sanitize_for_log(payload)
        assert result["wrapper"]["access_token"] == "[REDACTED]"

    def test_non_sensitive_fields_preserved(self):
        from app.publishers.base import sanitize_for_log
        payload = {"text": "hello", "media_id": "123"}
        result = sanitize_for_log(payload)
        assert result["text"] == "hello"
        assert result["media_id"] == "123"

    def test_none_input_returns_none(self):
        from app.publishers.base import sanitize_for_log
        assert sanitize_for_log(None) is None

    def test_empty_dict_returns_empty(self):
        from app.publishers.base import sanitize_for_log
        assert sanitize_for_log({}) == {}

    def test_list_values_recursed(self):
        from app.publishers.base import sanitize_for_log
        payload = {"items": [{"access_token": "tok1"}, {"text": "ok"}]}
        result = sanitize_for_log(payload)
        assert result["items"][0]["access_token"] == "[REDACTED]"
        assert result["items"][1]["text"] == "ok"


# ── LinkedIn publisher ──────────────────────────────────────────────────────────

class TestLinkedInHelpers:
    """Test module-level helper functions (not methods)."""

    def test_urn_normalization_bare_id(self):
        from app.publishers.linkedin import _ensure_urn
        assert _ensure_urn("ABC123") == "urn:li:person:ABC123"

    def test_urn_normalization_already_full(self):
        from app.publishers.linkedin import _ensure_urn
        assert _ensure_urn("urn:li:person:ABC123") == "urn:li:person:ABC123"

    def test_urn_normalization_org_urn_unchanged(self):
        from app.publishers.linkedin import _ensure_urn
        urn = "urn:li:organization:12345"
        assert _ensure_urn(urn) == urn

    def test_text_only_payload_structure(self):
        from app.publishers.linkedin import _build_ugc_payload
        payload = _build_ugc_payload(
            author_urn="urn:li:person:ABC123",
            body_text="Hello LinkedIn",
            li_asset_urn=None,
        )
        assert payload["author"] == "urn:li:person:ABC123"
        assert payload["lifecycleState"] == "PUBLISHED"
        content = payload["specificContent"]["com.linkedin.ugc.ShareContent"]
        assert content["shareCommentary"]["text"] == "Hello LinkedIn"
        assert content["shareMediaCategory"] == "NONE"
        assert "media" not in content

    def test_image_payload_includes_media(self):
        from app.publishers.linkedin import _build_ugc_payload
        payload = _build_ugc_payload(
            author_urn="urn:li:person:ABC123",
            body_text="Image post",
            li_asset_urn="urn:li:digitalmediaAsset:MEDIA123",
        )
        content = payload["specificContent"]["com.linkedin.ugc.ShareContent"]
        assert content["shareMediaCategory"] == "IMAGE"
        assert len(content["media"]) == 1
        assert content["media"][0]["media"] == "urn:li:digitalmediaAsset:MEDIA123"

    def test_urn_to_url_returns_feed_link(self):
        from app.publishers.linkedin import _li_urn_to_url
        url = _li_urn_to_url("urn:li:share:7199123456")
        assert url is not None
        assert "linkedin.com/feed/update" in url

    def test_urn_to_url_empty_returns_none(self):
        from app.publishers.linkedin import _li_urn_to_url
        assert _li_urn_to_url("") is None
        assert _li_urn_to_url(None) is None


class TestLinkedInPublisher:
    @pytest.mark.asyncio
    async def test_publish_success(self):
        from app.publishers.linkedin import LinkedInPublisher
        pub = LinkedInPublisher()
        req = _req(asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {"id": "urn:li:share:99999"}
        mock_resp.headers = {}

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True
        assert result.http_status == 201

    @pytest.mark.asyncio
    async def test_publish_401_auth_failed(self):
        from app.publishers.linkedin import LinkedInPublisher
        pub = LinkedInPublisher()
        req = _req(asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.json.return_value = {"message": "Unauthorized"}

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "AUTH_FAILED"

    @pytest.mark.asyncio
    async def test_image_upload_fail_falls_back_to_text(self):
        """If image upload fails, publish proceeds as text-only (no exception)."""
        from app.publishers.linkedin import LinkedInPublisher
        pub = LinkedInPublisher()
        req = _req(asset_url="https://storage.example.com/img.png")

        # Register upload returns failure
        reg_fail = MagicMock()
        reg_fail.status_code = 500
        reg_fail.json.return_value = {}

        # UGC post succeeds as text
        post_ok = MagicMock()
        post_ok.status_code = 201
        post_ok.json.return_value = {"id": "urn:li:share:text123"}
        post_ok.headers = {}

        call_count = [0]

        async def mock_post(url, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return reg_fail  # register upload fails
            return post_ok

        async def mock_get(url, **kwargs):
            r = MagicMock()
            r.status_code = 200
            r.content = b"PNG"
            return r

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.get = mock_get
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True


# ── Facebook publisher ──────────────────────────────────────────────────────────

class TestFacebookPublisher:
    @pytest.mark.asyncio
    async def test_text_post_uses_feed_endpoint(self):
        from app.publishers.facebook import FacebookPublisher
        pub = FacebookPublisher()
        req = _req(platform="facebook", platform_account_id="page123", asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"id": "page123_post456"}

        captured = []

        async def mock_post(url, **kwargs):
            captured.append(url)
            return mock_resp

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True
        assert "/page123/feed" in captured[0]

    @pytest.mark.asyncio
    async def test_image_post_uses_photos_endpoint(self):
        from app.publishers.facebook import FacebookPublisher
        pub = FacebookPublisher()
        req = _req(
            platform="facebook",
            platform_account_id="page123",
            asset_url="https://storage.example.com/img.png",
        )

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"post_id": "page123_photo789", "id": "photo789"}

        captured = []

        async def mock_post(url, **kwargs):
            captured.append(url)
            return mock_resp

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True
        assert "/page123/photos" in captured[0]

    def test_post_url_splits_page_id_correctly(self):
        from app.publishers.facebook import FacebookPublisher
        pub = FacebookPublisher()
        req = _req(platform="facebook", platform_account_id="page123", asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"id": "page123_post456"}

        result = pub._parse_response(req, mock_resp, "text", {})
        assert result.success is True
        assert "page123" in result.platform_post_url
        assert "post456" in result.platform_post_url


# ── Instagram publisher ─────────────────────────────────────────────────────────

class TestInstagramPublisher:
    @pytest.mark.asyncio
    async def test_no_asset_returns_content_rejected(self):
        from app.publishers.instagram import InstagramPublisher
        pub = InstagramPublisher()
        req = _req(platform="instagram", asset_url=None)

        result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "CONTENT_REJECTED"

    @pytest.mark.asyncio
    async def test_two_step_publish_makes_two_calls(self):
        from app.publishers.instagram import InstagramPublisher
        pub = InstagramPublisher()
        req = _req(
            platform="instagram",
            platform_account_id="ig_user_123",
            asset_url="https://storage.example.com/img.png",
        )

        step1 = MagicMock()
        step1.status_code = 200
        step1.json.return_value = {"id": "container_abc"}

        step2 = MagicMock()
        step2.status_code = 200
        step2.json.return_value = {"id": "media_xyz"}

        calls = [0]

        async def mock_post(url, **kwargs):
            calls[0] += 1
            return step1 if calls[0] == 1 else step2

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = mock_post
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True
        assert result.platform_post_id == "media_xyz"
        assert calls[0] == 2

    @pytest.mark.asyncio
    async def test_container_auth_failure_returns_error(self):
        from app.publishers.instagram import InstagramPublisher
        pub = InstagramPublisher()
        req = _req(
            platform="instagram",
            asset_url="https://storage.example.com/img.png",
        )

        fail_resp = MagicMock()
        fail_resp.status_code = 400
        fail_resp.json.return_value = {"error": {"code": 190, "message": "token expired"}}

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=fail_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "AUTH_FAILED"

    @pytest.mark.asyncio
    async def test_container_creation_no_id_returns_permanent_error(self):
        from app.publishers.instagram import InstagramPublisher
        pub = InstagramPublisher()
        req = _req(
            platform="instagram",
            asset_url="https://storage.example.com/img.png",
        )

        # Step 1 returns 200 but no id
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {}  # no "id" field

        with patch("httpx.AsyncClient") as mock_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=empty_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "PERMANENT"


# ── X publisher ─────────────────────────────────────────────────────────────────

class TestXPublisher:
    @pytest.mark.asyncio
    async def test_disabled_returns_platform_disabled(self):
        from app.publishers.x import XPublisher
        pub = XPublisher()
        req = _req(platform="x")

        with patch("app.publishers.x.settings") as mock_settings:
            mock_settings.platform_x_enabled = False
            result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "PLATFORM_DISABLED"

    @pytest.mark.asyncio
    async def test_disabled_makes_no_http_calls(self):
        from app.publishers.x import XPublisher
        pub = XPublisher()
        req = _req(platform="x")

        with patch("app.publishers.x.settings") as mock_settings, \
             patch("httpx.AsyncClient") as mock_cls:
            mock_settings.platform_x_enabled = False
            await pub.publish(req)
            mock_cls.assert_not_called()

    @pytest.mark.asyncio
    async def test_enabled_calls_tweets_api(self):
        from app.publishers.x import XPublisher
        pub = XPublisher()
        req = _req(platform="x", asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {"data": {"id": "tweet_123"}}

        with patch("app.publishers.x.settings") as mock_settings, \
             patch("httpx.AsyncClient") as mock_cls:
            mock_settings.platform_x_enabled = True
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is True
        assert result.platform_post_id == "tweet_123"

    @pytest.mark.asyncio
    async def test_enabled_401_auth_failed(self):
        from app.publishers.x import XPublisher
        pub = XPublisher()
        req = _req(platform="x", asset_url=None)

        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.json.return_value = {"title": "Unauthorized"}

        with patch("app.publishers.x.settings") as mock_settings, \
             patch("httpx.AsyncClient") as mock_cls:
            mock_settings.platform_x_enabled = True
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_client

            result = await pub.publish(req)

        assert result.success is False
        assert result.error_category == "AUTH_FAILED"


# ── Meta token resolution ───────────────────────────────────────────────────────

class TestMetaAccountResolution:
    @pytest.mark.asyncio
    async def test_facebook_resolves_directly(self):
        from app.publishers.meta import resolve_meta_account

        pool, conn = _make_pool_and_conn()
        conn.fetchrow.return_value = {
            "id": uuid.uuid4(),
            "platform_account_id": "page_123",
            "access_token_enc": b"encrypted",
            "meta_connection_id": None,
        }

        with patch("app.publishers.meta.decrypt_token", return_value="plaintext"):
            result = await resolve_meta_account(pool, uuid.uuid4(), "facebook")

        assert result is not None
        assert result["platform_account_id"] == "page_123"
        assert result["access_token"] == "plaintext"

    @pytest.mark.asyncio
    async def test_instagram_fetches_fb_parent_token(self):
        from app.publishers.meta import resolve_meta_account

        fb_id = uuid.uuid4()
        pool, conn = _make_pool_and_conn()
        conn.fetchrow.side_effect = [
            {
                "id": uuid.uuid4(),
                "platform_account_id": "ig_user_456",
                "access_token_enc": b"ig_enc",
                "meta_connection_id": fb_id,
            },
            {"access_token_enc": b"fb_enc"},
        ]

        with patch("app.publishers.meta.decrypt_token", return_value="fb_plaintext"):
            result = await resolve_meta_account(pool, uuid.uuid4(), "instagram")

        assert result["platform_account_id"] == "ig_user_456"
        assert result["access_token"] == "fb_plaintext"
        assert conn.fetchrow.call_count == 2

    @pytest.mark.asyncio
    async def test_no_account_returns_none(self):
        from app.publishers.meta import resolve_meta_account

        pool, conn = _make_pool_and_conn()
        conn.fetchrow.return_value = None

        result = await resolve_meta_account(pool, uuid.uuid4(), "facebook")
        assert result is None

    @pytest.mark.asyncio
    async def test_non_meta_platform_raises(self):
        from app.publishers.meta import resolve_meta_account

        pool, _ = _make_pool_and_conn()
        with pytest.raises(ValueError, match="non-Meta"):
            await resolve_meta_account(pool, uuid.uuid4(), "linkedin")

    @pytest.mark.asyncio
    async def test_decrypt_failure_returns_none(self):
        from app.publishers.meta import resolve_meta_account

        pool, conn = _make_pool_and_conn()
        conn.fetchrow.return_value = {
            "id": uuid.uuid4(),
            "platform_account_id": "page_789",
            "access_token_enc": b"bad_data",
            "meta_connection_id": None,
        }

        with patch("app.publishers.meta.decrypt_token", side_effect=Exception("bad key")):
            result = await resolve_meta_account(pool, uuid.uuid4(), "facebook")

        assert result is None
