"""
Phase 7 — Analytics & Growth Intelligence tests.

Coverage:
  TestNormalizer          — all four platform formats + manual + error fallback
  TestMetricsStore        — ingest_metrics, get_variant_metrics, get_top_content
  TestROIAttribution      — get_engagement_roi_summary aggregation
  TestHealthScore         — _compute_health_score edge cases
  TestRecommendations     — LLM failure fallback, response shape
  TestAnalyticsAPI        — route-level: variant not found, overview, top-content, roi
"""

from __future__ import annotations

import json
import uuid
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── TestNormalizer ────────────────────────────────────────────────────────────

class TestNormalizer:

    def test_linkedin_standard_format(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "totalShareStatistics": {
                "impressionCount": 1000,
                "uniqueImpressionsCount": 800,
                "clickCount": 50,
                "likeCount": 40,
                "commentCount": 10,
                "shareCount": 5,
            }
        }
        result = normalize("linkedin", raw)
        assert result.impressions == 1000
        assert result.reach == 800
        assert result.clicks == 50
        assert result.reactions == 40
        assert result.comments_received == 10
        assert result.shares == 5

    def test_linkedin_engagement_rate_calculation(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "totalShareStatistics": {
                "impressionCount": 1000,
                "likeCount": 40,
                "commentCount": 10,
                "shareCount": 5,
            }
        }
        result = normalize("linkedin", raw)
        # (40 + 10 + 5) / 1000 = 0.055
        assert abs(result.engagement_rate - 0.055) < 0.0001

    def test_x_format(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "data": {
                "public_metrics": {
                    "impression_count": 500,
                    "like_count": 20,
                    "reply_count": 5,
                    "retweet_count": 8,
                    "quote_count": 2,
                    "url_link_clicks": 15,
                }
            }
        }
        result = normalize("x", raw)
        assert result.impressions == 500
        assert result.reactions == 20
        assert result.comments_received == 5
        assert result.shares == 10   # retweet + quote
        assert result.clicks == 15

    def test_facebook_insights_format(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "data": [
                {"name": "post_impressions", "values": [{"value": 2000}]},
                {"name": "post_impressions_unique", "values": [{"value": 1500}]},
                {"name": "post_clicks", "values": [{"value": 100}]},
                {"name": "post_reactions_by_type_total", "values": [{"value": {"LIKE": 30, "LOVE": 5}}]},
                {"name": "post_comments", "values": [{"value": 8}]},
                {"name": "post_shares", "values": [{"value": 12}]},
            ]
        }
        result = normalize("facebook", raw)
        assert result.impressions == 2000
        assert result.reach == 1500
        assert result.clicks == 100
        assert result.reactions == 35   # 30 + 5
        assert result.comments_received == 8
        assert result.shares == 12

    def test_instagram_format(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "insights": {
                "data": [
                    {"name": "impressions", "values": [{"value": 3000}]},
                    {"name": "reach", "values": [{"value": 2000}]},
                    {"name": "likes", "values": [{"value": 150}]},
                    {"name": "comments", "values": [{"value": 25}]},
                    {"name": "shares", "values": [{"value": 10}]},
                    {"name": "video_views", "values": [{"value": 500}]},
                ]
            }
        }
        result = normalize("instagram", raw)
        assert result.impressions == 3000
        assert result.reach == 2000
        assert result.reactions == 150
        assert result.comments_received == 25
        assert result.shares == 10
        assert result.video_views == 500

    def test_manual_format_passthrough(self):
        from app.services.analytics.normalizer import normalize

        raw = {
            "impressions": 500,
            "reach": 400,
            "clicks": 20,
            "reactions": 15,
            "comments": 5,
            "shares": 3,
        }
        result = normalize("manual_import", raw)
        assert result.impressions == 500
        assert result.comments_received == 5

    def test_broken_format_returns_zeros(self):
        from app.services.analytics.normalizer import normalize

        # Completely invalid format → fallback to zeros, no exception
        result = normalize("linkedin", {"garbage": "data"})
        assert result.impressions == 0
        assert result.engagement_rate == 0.0

    def test_zero_impressions_avoids_division_error(self):
        from app.services.analytics.normalizer import normalize

        raw = {"totalShareStatistics": {"impressionCount": 0, "likeCount": 5}}
        result = normalize("linkedin", raw)
        assert result.engagement_rate == 0.0
        assert result.impressions == 0

    def test_negative_values_clamped_to_zero(self):
        from app.services.analytics.normalizer import normalize

        raw = {"impressions": -100, "reactions": -5}
        result = normalize("manual_import", raw)
        assert result.impressions == 0
        assert result.reactions == 0

    def test_to_dict_has_all_keys(self):
        from app.services.analytics.normalizer import NormalizedMetrics

        m = NormalizedMetrics(impressions=100, reactions=5)
        d = m.to_dict()
        assert set(d.keys()) == {
            "impressions", "reach", "clicks", "reactions",
            "comments_received", "shares", "video_views", "engagement_rate",
        }


# ── TestMetricsStore ──────────────────────────────────────────────────────────

class TestMetricsStore:

    def _make_pool(self, fetchrow_return=None, fetch_return=None):
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=fetchrow_return or {"id": uuid.uuid4()})
        mock_conn.fetch = AsyncMock(return_value=fetch_return or [])
        mock_conn.execute = AsyncMock(return_value="INSERT 1")
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))
        return mock_pool, mock_conn

    @pytest.mark.asyncio
    async def test_ingest_metrics_normalizes_and_stores(self):
        from app.services.analytics.metrics_store import ingest_metrics

        snapshot_id = uuid.uuid4()
        pool, conn = self._make_pool(fetchrow_return={"id": snapshot_id})

        raw = {
            "totalShareStatistics": {
                "impressionCount": 500,
                "likeCount": 20,
                "commentCount": 5,
                "shareCount": 2,
            }
        }
        sid, normalized = await ingest_metrics(
            pool=pool,
            org_id=uuid.uuid4(),
            variant_id=uuid.uuid4(),
            platform="linkedin",
            snapshot_date=date.today(),
            raw_metrics=raw,
        )

        assert sid == snapshot_id
        assert normalized.impressions == 500
        assert normalized.reactions == 20
        # (20 + 5 + 2) / 500 = 0.054
        assert abs(normalized.engagement_rate - 0.054) < 0.001

    @pytest.mark.asyncio
    async def test_get_variant_metrics_returns_list(self):
        from app.services.analytics.metrics_store import get_variant_metrics

        rows = [
            {
                "id": uuid.uuid4(), "org_id": uuid.uuid4(), "variant_id": uuid.uuid4(),
                "platform": "linkedin", "snapshot_date": date.today(),
                "impressions": 100, "reach": 80, "clicks": 5,
                "reactions": 8, "comments_received": 2, "shares": 1,
                "video_views": 0, "engagement_rate": 0.11,
                "snapshot_id": None, "created_at": None, "updated_at": None,
            }
        ]
        pool, _ = self._make_pool(fetch_return=rows)

        result = await get_variant_metrics(pool, uuid.uuid4(), uuid.uuid4())
        assert len(result) == 1
        assert result[0]["platform"] == "linkedin"

    @pytest.mark.asyncio
    async def test_get_top_content_empty(self):
        from app.services.analytics.metrics_store import get_top_content

        pool, _ = self._make_pool(fetch_return=[])
        result = await get_top_content(pool, uuid.uuid4(), None, date.today(), date.today())
        assert result == []


# ── TestROIAttribution ────────────────────────────────────────────────────────

class TestROIAttribution:

    @pytest.mark.asyncio
    async def test_summary_all_zeros_when_no_actions(self):
        from app.services.analytics.roi_attribution import get_engagement_roi_summary

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "total_engagements": 0,
            "successful_engagements": 0,
            "auto_approved_count": 0,
            "human_approved_count": 0,
            "avg_confidence_score": 0,
            "avg_risk_score": 0,
        })
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_conn.fetchval = AsyncMock(return_value=0)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        result = await get_engagement_roi_summary(
            mock_pool, uuid.uuid4(), date.today(), date.today()
        )
        assert result["total_engagements"] == 0
        assert result["platforms"] == []

    @pytest.mark.asyncio
    async def test_summary_with_actions(self):
        from app.services.analytics.roi_attribution import get_engagement_roi_summary

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "total_engagements": 10,
            "successful_engagements": 8,
            "auto_approved_count": 6,
            "human_approved_count": 4,
            "avg_confidence_score": 0.82,
            "avg_risk_score": 0.15,
        })
        mock_conn.fetch = AsyncMock(return_value=[
            {"platform": "linkedin", "action_count": 7, "success_count": 6},
            {"platform": "x", "action_count": 3, "success_count": 2},
        ])
        mock_conn.fetchval = AsyncMock(return_value=0)
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))

        result = await get_engagement_roi_summary(
            mock_pool, uuid.uuid4(), date.today(), date.today()
        )
        assert result["total_engagements"] == 10
        assert result["avg_confidence_score"] == 0.82
        assert len(result["platforms"]) == 2
        linkedin = next(p for p in result["platforms"] if p["platform"] == "linkedin")
        assert abs(linkedin["success_rate"] - 6/7) < 0.01


# ── TestHealthScore ───────────────────────────────────────────────────────────

class TestHealthScore:

    def _make_overview(self, platform, posts, avg_er):
        return {"platform": platform, "posts_published": posts, "avg_engagement_rate": avg_er}

    def test_zero_when_no_data(self):
        from app.services.analytics.intelligence import _compute_health_score
        score = _compute_health_score([], {"successful_engagements": 0}, [])
        assert score == 0.0

    def test_perfect_score_conditions(self):
        from app.services.analytics.intelligence import _compute_health_score
        overview = [
            self._make_overview("linkedin",  5, 0.025),   # excellent
            self._make_overview("instagram", 4, 0.040),   # excellent
            self._make_overview("x",         6, 0.001),   # excellent
        ]
        prior = [
            self._make_overview("linkedin",  3, 0.010),
            self._make_overview("instagram", 2, 0.015),
            self._make_overview("x",         4, 0.0005),
        ]
        engagement = {"successful_engagements": 15}
        score = _compute_health_score(overview, engagement, prior)
        # Should be high (>70)
        assert score > 70.0

    def test_below_benchmark_hurts_score(self):
        from app.services.analytics.intelligence import _compute_health_score
        overview = [self._make_overview("linkedin", 1, 0.001)]  # below 0.8% good threshold
        score = _compute_health_score(overview, {"successful_engagements": 0}, [])
        # Limited publishing + below benchmark + no engagement
        assert score < 40.0

    def test_score_bounded_0_to_100(self):
        from app.services.analytics.intelligence import _compute_health_score
        overview = [self._make_overview("linkedin", 100, 0.99)]
        engagement = {"successful_engagements": 1000}
        prior = [self._make_overview("linkedin", 50, 0.5)]
        score = _compute_health_score(overview, engagement, prior)
        assert 0.0 <= score <= 100.0


# ── TestRecommendations ───────────────────────────────────────────────────────

class TestRecommendations:

    @pytest.mark.asyncio
    async def test_llm_failure_returns_default_recommendation(self):
        from app.services.analytics.intelligence import _generate_recommendations

        with patch("app.services.analytics.intelligence.chat_completion",
                   AsyncMock(side_effect=Exception("OpenAI error"))):
            recs = await _generate_recommendations(
                org_id=uuid.uuid4(),
                platform_trends=[],
                posting_frequency=[],
                engagement_summary={"total_engagements": 0, "successful_engagements": 0},
                health_score=50.0,
            )

        assert len(recs) == 1
        assert recs[0]["priority"] == "high"

    @pytest.mark.asyncio
    async def test_llm_returns_list_of_recommendations(self):
        from app.services.analytics.intelligence import _generate_recommendations

        fake_response = json.dumps({
            "recommendations": [
                {"priority": "high", "category": "posting_frequency",
                 "action": "Post 3x/week on LinkedIn", "reason": "Current 1x/week is below benchmark"},
                {"priority": "medium", "category": "content_type",
                 "action": "Add more case studies", "reason": "How-to posts outperform by 2x"},
            ]
        })

        with patch("app.services.analytics.intelligence.chat_completion",
                   AsyncMock(return_value=fake_response)):
            recs = await _generate_recommendations(
                org_id=uuid.uuid4(),
                platform_trends=[{"platform": "linkedin", "avg_engagement_rate": 0.005}],
                posting_frequency=[{"platform": "linkedin", "posts_published": 1, "recommended_per_period": 3}],
                engagement_summary={"total_engagements": 5, "successful_engagements": 4},
                health_score=45.0,
            )

        assert len(recs) == 2
        assert recs[0]["priority"] == "high"
        assert "category" in recs[0]


# ── TestAnalyticsAPI ──────────────────────────────────────────────────────────

class TestAnalyticsAPI:

    def _app_with_auth(self, org_id, user_id):
        from fastapi import FastAPI
        from app.api.analytics import router
        from app.auth_bridge import AuthContext, require_auth
        from app.db import get_pool

        app = FastAPI()
        app.include_router(router, prefix="/growth")

        def fake_auth():
            return AuthContext(user_id=user_id, org_id=org_id, role=None, email="t@t.com")

        app.dependency_overrides[require_auth] = fake_auth
        app.dependency_overrides[get_pool] = lambda: MagicMock()
        return app

    def test_ingest_metrics_variant_not_found(self):
        from fastapi.testclient import TestClient

        org_id  = uuid.uuid4()
        user_id = uuid.uuid4()
        app     = self._app_with_auth(org_id, user_id)

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)  # variant not found
        mock_pool.acquire = MagicMock(return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=None),
        ))
        app.dependency_overrides[__import__("app.db", fromlist=["get_pool"]).get_pool] = lambda: mock_pool

        client = TestClient(app)
        resp = client.post(
            "/growth/analytics/metrics/ingest",
            json={
                "variant_id": str(uuid.uuid4()),
                "platform": "linkedin",
                "snapshot_date": date.today().isoformat(),
                "raw_metrics": {"totalShareStatistics": {"impressionCount": 100}},
            }
        )
        assert resp.status_code == 404

    def test_intelligence_404_when_no_summary(self):
        from fastapi.testclient import TestClient

        org_id  = uuid.uuid4()
        user_id = uuid.uuid4()
        app     = self._app_with_auth(org_id, user_id)

        with patch("app.api.analytics.get_latest_summary", AsyncMock(return_value=None)):
            client = TestClient(app)
            resp = client.get("/growth/analytics/intelligence")
        assert resp.status_code == 404

    def test_variant_metrics_returns_200(self):
        from fastapi.testclient import TestClient

        org_id  = uuid.uuid4()
        user_id = uuid.uuid4()
        app     = self._app_with_auth(org_id, user_id)

        with patch("app.api.analytics.metrics_store.get_variant_metrics",
                   AsyncMock(return_value=[])):
            client = TestClient(app)
            resp = client.get(f"/growth/analytics/variants/{uuid.uuid4()}/metrics")
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    def test_overview_returns_200_empty(self):
        from fastapi.testclient import TestClient

        org_id  = uuid.uuid4()
        user_id = uuid.uuid4()
        app     = self._app_with_auth(org_id, user_id)

        with patch("app.api.analytics.metrics_store.get_org_overview",
                   AsyncMock(return_value=[])):
            client = TestClient(app)
            resp = client.get("/growth/analytics/overview")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_posts"] == 0
        assert data["total_impressions"] == 0
