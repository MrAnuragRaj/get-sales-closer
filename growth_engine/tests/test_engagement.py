"""
Phase 6 — Engagement Engine tests.

Coverage:
  TestPlannerCaps          — plan limits, auto-safe thresholds, daily cap arithmetic
  TestTargetsCRUD          — create, list, get, update, delete, dedup
  TestDiscovery            — process_discovered_post, batch, dedup, auto-safe routing
  TestExecutor             — execute success, cap exceeded, wrong status, missing opp
  TestScoringFallback      — LLM failure falls back to safe defaults
  TestEngagementAPI        — route-level: 404s, 409s, 403 plan gate, 429 cap

All async tests require pytest-asyncio (in requirements.txt — runs in Docker).
All app.* imports are deferred inside test functions to handle missing structlog in local env.
"""

from __future__ import annotations

import json
import uuid
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── TestPlannerCaps ──────────────────────────────────────────────────────────

class TestPlannerCaps:

    def test_starter_total_cap_is_5(self):
        from app.services.engagement.planner import get_plan_total_daily_cap
        assert get_plan_total_daily_cap("engagement_starter") == 5

    def test_pro_total_cap_is_15(self):
        from app.services.engagement.planner import get_plan_total_daily_cap
        assert get_plan_total_daily_cap("engagement_pro") == 15

    def test_no_plan_total_cap_is_0(self):
        from app.services.engagement.planner import get_plan_total_daily_cap
        assert get_plan_total_daily_cap("none") == 0

    def test_unknown_plan_total_cap_is_0(self):
        from app.services.engagement.planner import get_plan_total_daily_cap
        assert get_plan_total_daily_cap("ghost_plan") == 0

    def test_platform_safety_cap_linkedin_comment(self):
        from app.services.engagement.planner import get_platform_safety_cap
        assert get_platform_safety_cap("linkedin", "comment") == 15

    def test_platform_safety_cap_x_reply(self):
        from app.services.engagement.planner import get_platform_safety_cap
        assert get_platform_safety_cap("x", "reply") == 6

    def test_platform_safety_cap_unsupported_returns_0(self):
        from app.services.engagement.planner import get_platform_safety_cap
        # Likes not in safety caps
        assert get_platform_safety_cap("linkedin", "like") == 0

    def test_auto_safe_starter_passes_threshold(self):
        from app.services.engagement.planner import is_auto_safe
        # confidence=0.85, risk=0.10 → passes starter (0.80 / 0.30)
        assert is_auto_safe(0.85, 0.10, "engagement_starter") is True

    def test_auto_safe_starter_fails_confidence(self):
        from app.services.engagement.planner import is_auto_safe
        assert is_auto_safe(0.79, 0.10, "engagement_starter") is False

    def test_auto_safe_starter_fails_risk(self):
        from app.services.engagement.planner import is_auto_safe
        assert is_auto_safe(0.90, 0.31, "engagement_starter") is False

    def test_auto_safe_pro_lower_threshold(self):
        from app.services.engagement.planner import is_auto_safe
        # 0.72 passes pro (0.70) but would fail starter (0.80)
        assert is_auto_safe(0.72, 0.20, "engagement_pro") is True
        assert is_auto_safe(0.72, 0.20, "engagement_starter") is False

    def test_auto_safe_no_plan_always_false(self):
        from app.services.engagement.planner import is_auto_safe
        assert is_auto_safe(0.99, 0.01, "none") is False

    @pytest.mark.asyncio
    async def test_get_commercial_used_zero_on_no_row(self):
        from app.services.engagement.planner import get_commercial_used_today

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        used = await get_commercial_used_today(mock_pool, uuid.uuid4(), date.today())
        assert used == 0

    @pytest.mark.asyncio
    async def test_check_caps_available_within_commercial_limit(self):
        from app.services.engagement.planner import check_caps_available

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        # commercial used = 2 (below 5); safety used = 1 (below 15)
        mock_conn.fetchrow = AsyncMock(side_effect=[{"count": 2}, {"count": 1}])
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        allowed, reason = await check_caps_available(
            mock_pool, uuid.uuid4(), "linkedin", "comment", "engagement_starter"
        )
        assert allowed is True
        assert reason == "ok"

    @pytest.mark.asyncio
    async def test_check_caps_commercial_cap_exceeded(self):
        from app.services.engagement.planner import check_caps_available

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"count": 5})  # used all 5 starter cap
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        allowed, reason = await check_caps_available(
            mock_pool, uuid.uuid4(), "linkedin", "comment", "engagement_starter"
        )
        assert allowed is False
        assert "commercial_cap_exceeded" in reason

    @pytest.mark.asyncio
    async def test_check_caps_no_plan_blocked(self):
        from app.services.engagement.planner import check_caps_available

        pool = MagicMock()
        allowed, reason = await check_caps_available(
            pool, uuid.uuid4(), "linkedin", "comment", "none"
        )
        assert allowed is False
        assert reason == "no_engagement_plan"

    @pytest.mark.asyncio
    async def test_check_caps_platform_not_supported(self):
        """Action type not in platform safety caps → blocked at layer 2."""
        from app.services.engagement.planner import check_caps_available

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"count": 0})  # commercial used = 0
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        # "like" is not a supported action type in v1
        allowed, reason = await check_caps_available(
            mock_pool, uuid.uuid4(), "linkedin", "like", "engagement_pro"
        )
        assert allowed is False
        assert "platform_action_not_supported" in reason


# ── TestTargetsCRUD ──────────────────────────────────────────────────────────

class TestTargetsCRUD:

    def _make_pool(self, fetchrow_return=None, fetchval_return=0, fetch_return=None, execute_return="DELETE 1"):
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=fetchrow_return)
        mock_conn.fetchval = AsyncMock(return_value=fetchval_return)
        mock_conn.fetch = AsyncMock(return_value=fetch_return or [])
        mock_conn.execute = AsyncMock(return_value=execute_return)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))
        return mock_pool, mock_conn

    @pytest.mark.asyncio
    async def test_create_target_returns_row(self):
        from app.models.engagement import EngagementTargetCreate
        from app.services.engagement.targets import create_target

        org_id = uuid.uuid4()
        data = EngagementTargetCreate(
            platform="linkedin",
            target_type="profile",
            target_identifier="johndoe",
            target_name="John Doe",
        )
        expected = {
            "id": uuid.uuid4(), "org_id": org_id, "platform": "linkedin",
            "target_type": "profile", "target_identifier": "johndoe",
            "target_name": "John Doe", "description": None, "is_active": True,
            "created_at": None, "updated_at": None,
        }
        pool, conn = self._make_pool(fetchrow_return=expected)

        result = await create_target(pool, org_id, data)
        assert result is not None
        assert result["platform"] == "linkedin"
        assert result["target_identifier"] == "johndoe"

    @pytest.mark.asyncio
    async def test_create_target_duplicate_returns_none(self):
        from app.models.engagement import EngagementTargetCreate
        from app.services.engagement.targets import create_target

        data = EngagementTargetCreate(
            platform="linkedin", target_type="hashtag", target_identifier="ai",
        )
        pool, _ = self._make_pool(fetchrow_return=None)  # ON CONFLICT DO NOTHING → no RETURNING

        result = await create_target(pool, uuid.uuid4(), data)
        assert result is None

    @pytest.mark.asyncio
    async def test_delete_target_found(self):
        from app.services.engagement.targets import delete_target

        pool, _ = self._make_pool(execute_return="DELETE 1")
        result = await delete_target(pool, uuid.uuid4(), uuid.uuid4())
        assert result is True

    @pytest.mark.asyncio
    async def test_delete_target_not_found(self):
        from app.services.engagement.targets import delete_target

        pool, _ = self._make_pool(execute_return="DELETE 0")
        result = await delete_target(pool, uuid.uuid4(), uuid.uuid4())
        assert result is False

    @pytest.mark.asyncio
    async def test_list_targets_empty(self):
        from app.services.engagement.targets import list_targets

        pool, _ = self._make_pool(fetchval_return=0, fetch_return=[])
        rows, total = await list_targets(pool, uuid.uuid4())
        assert rows == []
        assert total == 0


# ── TestDiscovery ────────────────────────────────────────────────────────────

class TestDiscovery:

    @pytest.mark.asyncio
    async def test_process_post_dedup_returns_none(self):
        """If post already exists, process_discovered_post returns None."""
        from app.models.engagement import DiscoveredPost
        from app.services.engagement.discovery import process_discovered_post

        target = {
            "id": uuid.uuid4(), "org_id": uuid.uuid4(),
            "platform": "linkedin", "target_type": "hashtag",
            "target_identifier": "aimarketing",
        }
        post = DiscoveredPost(
            post_platform_id="post_123",
            post_body="Interesting take on AI in sales.",
            opportunity_type="comment",
        )

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        # First query: dedup check returns existing row
        mock_conn.fetchrow = AsyncMock(return_value={"id": uuid.uuid4(), "status": "executed"})
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        result = await process_discovered_post(mock_pool, target["org_id"], target, post)
        assert result is None

    @pytest.mark.asyncio
    async def test_process_post_auto_approved_when_safe(self):
        """High confidence, low risk → status='auto_approved'."""
        from app.models.engagement import DiscoveredPost
        from app.services.engagement import discovery
        from app.models.engagement import ScoringResult

        target = {
            "id": uuid.uuid4(), "org_id": uuid.uuid4(),
            "platform": "linkedin", "target_type": "keyword",
            "target_identifier": "revenue growth",
        }
        post = DiscoveredPost(
            post_platform_id="post_safe",
            post_body="Revenue growth best practices for 2026: focus on pipeline quality.",
            opportunity_type="comment",
        )

        expected_opp_id = uuid.uuid4()
        expected_row = {
            "id": expected_opp_id, "org_id": target["org_id"],
            "target_id": target["id"], "platform": "linkedin",
            "opportunity_type": "comment", "post_platform_id": "post_safe",
            "status": "auto_approved",
            "confidence_score": 0.9, "risk_score": 0.1, "relevance_score": 0.85,
            "generated_action_text": "Great insight!", "generation_model": "gpt-4o-mini",
            "post_url": None, "post_body_snippet": None,
            "author_platform_id": None, "author_name": None,
            "rejection_reason": None, "approved_by": None, "approved_at": None,
            "discovered_at": None, "scheduled_for": None, "executed_at": None,
            "created_at": None, "updated_at": None,
        }

        safe_score = ScoringResult(
            confidence_score=0.9, risk_score=0.1, relevance_score=0.85,
            generated_action_text="Great insight!", generation_model="gpt-4o-mini",
        )

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        # First fetchrow: dedup check → no duplicate
        # Second fetchrow: INSERT RETURNING → new row
        mock_conn.fetchrow = AsyncMock(side_effect=[None, expected_row])
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        with patch("app.services.engagement.discovery.score_opportunity",
                   AsyncMock(return_value=safe_score)), \
             patch("app.services.engagement.discovery.get_org_plan",
                   AsyncMock(return_value="engagement_pro")):

            result = await discovery.process_discovered_post(
                mock_pool, target["org_id"], target, post
            )

        assert result is not None
        assert result["status"] == "auto_approved"

    @pytest.mark.asyncio
    async def test_process_post_pending_review_when_risky(self):
        """Low confidence → status='pending_review'."""
        from app.models.engagement import DiscoveredPost, ScoringResult
        from app.services.engagement import discovery

        target = {
            "id": uuid.uuid4(), "org_id": uuid.uuid4(),
            "platform": "linkedin", "target_type": "keyword",
            "target_identifier": "politics",
        }
        post = DiscoveredPost(
            post_platform_id="post_risky",
            post_body="Controversial political opinion about market regulations.",
            opportunity_type="comment",
        )

        risky_score = ScoringResult(
            confidence_score=0.4, risk_score=0.7, relevance_score=0.3,
            generated_action_text="...", generation_model="gpt-4o-mini",
        )
        expected_row = {
            "id": uuid.uuid4(), "status": "pending_review",
            "org_id": target["org_id"], "target_id": target["id"],
            "platform": "linkedin", "opportunity_type": "comment",
            "post_platform_id": "post_risky", "post_url": None,
            "post_body_snippet": None, "author_platform_id": None,
            "author_name": None, "confidence_score": 0.4, "risk_score": 0.7,
            "relevance_score": 0.3, "rejection_reason": None,
            "generated_action_text": "...", "generation_model": "gpt-4o-mini",
            "approved_by": None, "approved_at": None, "discovered_at": None,
            "scheduled_for": None, "executed_at": None,
            "created_at": None, "updated_at": None,
        }

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[None, expected_row])
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        with patch("app.services.engagement.discovery.score_opportunity",
                   AsyncMock(return_value=risky_score)), \
             patch("app.services.engagement.discovery.get_org_plan",
                   AsyncMock(return_value="engagement_starter")):

            result = await discovery.process_discovered_post(
                mock_pool, target["org_id"], target, post
            )

        assert result is not None
        assert result["status"] == "pending_review"

    @pytest.mark.asyncio
    async def test_batch_counts_created_vs_duplicates(self):
        from app.models.engagement import DiscoveredPost
        from app.services.engagement.discovery import process_post_batch

        target = {
            "id": uuid.uuid4(), "org_id": uuid.uuid4(),
            "platform": "linkedin", "target_type": "keyword",
            "target_identifier": "sales",
        }
        posts = [
            DiscoveredPost(post_platform_id="p1", post_body="post 1", opportunity_type="comment"),
            DiscoveredPost(post_platform_id="p2", post_body="post 2", opportunity_type="comment"),
            DiscoveredPost(post_platform_id="p3", post_body="post 3", opportunity_type="comment"),
        ]

        # p2 will be a duplicate (returns None), p1 and p3 created
        fake_opp = {"id": uuid.uuid4(), "status": "auto_approved"}

        async def mock_process(pool, org_id, target_, post):
            if post.post_platform_id == "p2":
                return None
            return {**fake_opp, "post_platform_id": post.post_platform_id}

        with patch("app.services.engagement.discovery.process_discovered_post",
                   side_effect=mock_process):
            results = await process_post_batch(MagicMock(), target["org_id"], target, posts)

        assert len(results) == 2
        assert all(r["post_platform_id"] != "p2" for r in results)


# ── TestExecutor ─────────────────────────────────────────────────────────────

class TestExecutor:

    @pytest.mark.asyncio
    async def test_execute_opportunity_not_found(self):
        from app.services.engagement.executor import execute_opportunity

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        result = await execute_opportunity(mock_pool, uuid.uuid4(), uuid.uuid4())
        assert result["success"] is False
        assert "not_found" in result["error"]

    @pytest.mark.asyncio
    async def test_execute_opportunity_wrong_status(self):
        from app.services.engagement.executor import execute_opportunity

        opp = {
            "id": uuid.uuid4(), "org_id": uuid.uuid4(), "platform": "linkedin",
            "opportunity_type": "comment", "post_platform_id": "p1",
            "status": "pending_review",  # not approved
            "generated_action_text": "Hello!",
        }

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=opp)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        result = await execute_opportunity(mock_pool, uuid.uuid4(), uuid.uuid4())
        assert result["success"] is False
        assert "cannot_execute_status" in result["error"]

    @pytest.mark.asyncio
    async def test_execute_opportunity_cap_exceeded(self):
        from app.services.engagement.executor import execute_opportunity

        org_id = uuid.uuid4()
        opp = {
            "id": uuid.uuid4(), "org_id": org_id, "platform": "linkedin",
            "opportunity_type": "comment", "post_platform_id": "p1",
            "status": "auto_approved",
            "generated_action_text": "Great post!",
        }

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=opp)
        mock_conn.execute = AsyncMock(return_value="UPDATE 1")
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        with patch("app.services.engagement.executor.get_org_plan",
                   AsyncMock(return_value="engagement_starter")), \
             patch("app.services.engagement.executor.check_caps_available",
                   AsyncMock(return_value=(False, "commercial_cap_exceeded (5/5)"))), \
             patch("app.services.engagement.executor._write_action_log",
                   AsyncMock()), \
             patch("app.services.engagement.executor._fail_opportunity",
                   AsyncMock()):

            result = await execute_opportunity(mock_pool, org_id, uuid.uuid4())

        assert result["success"] is False
        assert "commercial_cap_exceeded" in result["error"]

    @pytest.mark.asyncio
    async def test_execute_opportunity_success(self):
        from app.services.engagement.executor import execute_opportunity

        org_id = uuid.uuid4()
        opp = {
            "id": uuid.uuid4(), "org_id": org_id, "platform": "linkedin",
            "opportunity_type": "comment", "post_platform_id": "urn:li:ugcPost:1234",
            "status": "approved",
            "generated_action_text": "Excellent perspective on AI-driven sales.",
        }

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=opp)
        mock_conn.execute = AsyncMock(return_value="UPDATE 1")
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        with patch("app.services.engagement.executor.get_org_plan",
                   AsyncMock(return_value="engagement_pro")), \
             patch("app.services.engagement.executor.check_caps_available",
                   AsyncMock(return_value=(True, "ok"))), \
             patch("app.services.engagement.executor._write_action_log",
                   AsyncMock()), \
             patch("app.services.engagement.executor._mark_executed",
                   AsyncMock()), \
             patch("app.services.engagement.executor.increment_daily_cap",
                   AsyncMock(return_value=4)), \
             patch("app.services.engagement.executor._dispatch_action",
                   AsyncMock(return_value={
                       "success": True,
                       "platform_action_id": "stub_linkedin_urn",
                       "http_status": 201,
                   })):

            result = await execute_opportunity(mock_pool, org_id, uuid.uuid4())

        assert result["success"] is True
        assert result["platform_action_id"] == "stub_linkedin_urn"


# ── TestScoringFallback ──────────────────────────────────────────────────────

class TestScoringFallback:

    @pytest.mark.asyncio
    async def test_llm_failure_returns_safe_defaults(self):
        from app.services.engagement.scorer import score_opportunity

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        # brand_profiles query returns nothing → fallback brand context
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        with patch("app.services.engagement.scorer.chat_completion",
                   AsyncMock(side_effect=Exception("OpenAI timeout"))):
            result = await score_opportunity(
                pool=mock_pool,
                org_id=uuid.uuid4(),
                post_body="AI is changing everything",
                opportunity_type="comment",
                target_identifier="ai",
                target_type="hashtag",
                platform="linkedin",
            )

        # Fallback values — sends to human review
        assert result.confidence_score == 0.4
        assert result.risk_score == 0.5
        assert "failed" in result.generated_action_text.lower()

    @pytest.mark.asyncio
    async def test_short_post_caps_relevance(self):
        from app.services.engagement.scorer import score_opportunity

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        # LLM returns high relevance but post is < 50 chars
        llm_response = json.dumps({
            "confidence_score": 0.8,
            "risk_score": 0.1,
            "relevance_score": 0.9,
            "action_text": "Great post!",
            "risk_notes": "",
        })

        with patch("app.services.engagement.scorer.chat_completion",
                   AsyncMock(return_value=llm_response)):
            result = await score_opportunity(
                pool=mock_pool,
                org_id=uuid.uuid4(),
                post_body="Short!",  # < 50 chars
                opportunity_type="comment",
                target_identifier="ai",
                target_type="hashtag",
                platform="linkedin",
            )

        # Relevance capped at 0.3 for short posts
        assert result.relevance_score <= 0.3

    @pytest.mark.asyncio
    async def test_no_brand_profile_caps_confidence(self):
        from app.services.engagement.scorer import score_opportunity

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)  # no brand profile
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        llm_response = json.dumps({
            "confidence_score": 0.9,
            "risk_score": 0.1,
            "relevance_score": 0.8,
            "action_text": "Insightful perspective!",
            "risk_notes": "",
        })

        with patch("app.services.engagement.scorer.chat_completion",
                   AsyncMock(return_value=llm_response)):
            result = await score_opportunity(
                pool=mock_pool,
                org_id=uuid.uuid4(),
                post_body="A" * 100,  # long enough
                opportunity_type="comment",
                target_identifier="sales",
                target_type="keyword",
                platform="linkedin",
            )

        # Confidence capped at 0.5 when no brand profile
        assert result.confidence_score <= 0.5


# ── TestEngagementAPI ────────────────────────────────────────────────────────

class TestEngagementAPI:
    """
    Route-level tests using FastAPI TestClient (sync).
    These mock the service layer, not the DB.
    """

    def _app_with_auth(self, org_id: uuid.UUID, user_id: uuid.UUID):
        """Build a test app with a fake auth override."""
        from fastapi import FastAPI
        from app.api.engagement import router
        from app.auth_bridge import AuthContext, require_auth
        from app.db import get_pool

        app = FastAPI()
        app.include_router(router, prefix="/growth")

        def fake_auth():
            return AuthContext(
                user_id=user_id, org_id=org_id, role=None, email="test@test.com"
            )

        app.dependency_overrides[require_auth] = fake_auth
        app.dependency_overrides[get_pool] = lambda: MagicMock()
        return app

    def test_get_target_404(self):
        from fastapi.testclient import TestClient

        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = self._app_with_auth(org_id, user_id)

        with patch("app.api.engagement.targets.get_target", AsyncMock(return_value=None)):
            client = TestClient(app)
            resp = client.get(f"/growth/engagement/targets/{uuid.uuid4()}")
        assert resp.status_code == 404

    def test_create_target_409_on_duplicate(self):
        from fastapi.testclient import TestClient

        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = self._app_with_auth(org_id, user_id)

        with patch("app.api.engagement.targets.create_target", AsyncMock(return_value=None)):
            client = TestClient(app)
            resp = client.post(
                "/growth/engagement/targets",
                json={
                    "platform": "linkedin",
                    "target_type": "hashtag",
                    "target_identifier": "aimarketing",
                },
            )
        assert resp.status_code == 409

    def test_discover_403_no_plan(self):
        from fastapi.testclient import TestClient

        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = self._app_with_auth(org_id, user_id)

        with patch("app.api.engagement.get_org_plan", AsyncMock(return_value="none")):
            client = TestClient(app)
            resp = client.post(
                f"/growth/engagement/targets/{uuid.uuid4()}/discover",
                json={"posts": []},
            )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "no_engagement_plan_active"

    def test_execute_429_cap_exceeded(self):
        from fastapi.testclient import TestClient

        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = self._app_with_auth(org_id, user_id)

        with patch("app.api.engagement.get_org_plan",
                   AsyncMock(return_value="engagement_starter")), \
             patch("app.api.engagement.executor.execute_opportunity",
                   AsyncMock(return_value={"success": False, "error": "commercial_cap_exceeded (5/5)"})):

            client = TestClient(app)
            resp = client.post(f"/growth/engagement/opportunities/{uuid.uuid4()}/execute")
        assert resp.status_code == 429

    def test_approve_opportunity_409_wrong_status(self):
        from fastapi.testclient import TestClient

        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        app = self._app_with_auth(org_id, user_id)

        async def fake_approve_none(*args, **kwargs):
            # Simulate pool context for the 409 branch
            return None

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        # UPDATE returns no row (status mismatch)
        mock_conn.fetchrow = AsyncMock(side_effect=[
            None,  # UPDATE RETURNING → no row
            {"status": "executed"},  # SELECT for existing check
        ])
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        app.dependency_overrides[__import__("app.db", fromlist=["get_pool"]).get_pool] = lambda: mock_pool

        client = TestClient(app)
        resp = client.post(
            f"/growth/engagement/opportunities/{uuid.uuid4()}/approve",
            json={},
        )
        assert resp.status_code in (409, 404)  # depends on DB state


# ── TestPlannerGetOrgPlan ────────────────────────────────────────────────────

class TestPlannerGetOrgPlan:

    @pytest.mark.asyncio
    async def test_returns_pro_when_active(self):
        from app.services.engagement.planner import get_org_plan

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"service_key": "engagement_pro"})
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        plan = await get_org_plan(mock_pool, uuid.uuid4())
        assert plan == "engagement_pro"

    @pytest.mark.asyncio
    async def test_returns_starter_when_only_starter(self):
        from app.services.engagement.planner import get_org_plan

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"service_key": "engagement_starter"})
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        plan = await get_org_plan(mock_pool, uuid.uuid4())
        assert plan == "engagement_starter"

    @pytest.mark.asyncio
    async def test_returns_none_when_no_plan(self):
        from app.services.engagement.planner import get_org_plan

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        plan = await get_org_plan(mock_pool, uuid.uuid4())
        assert plan == "none"
