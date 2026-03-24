"""
Root API router — assembles all sub-routers under /growth prefix.

Route inventory:
  /growth/brand/*                    — Brand Profile CRUD
  /growth/settings/*                 — Org Growth Settings CRUD + quota summary
  /growth/ideas/*                    — Topic planner + idea management
  /growth/ladders/*                  — Authority Ladder management
  /growth/drafts/*                   — Content variants + approval workflow
  /growth/drafts/{id}/assets         — Image generation for a variant
  /growth/drafts/{id}/assets/all     — All platform templates for a variant
  /growth/drafts/{id}/image-spec     — Edit image text spec before re-render
  /growth/assets/*                   — Asset management (list/get/delete)
  /growth/queue/*                    — Publish queue management + logs
  /growth/drafts/{id}/approve        — Mode-aware approval (auto/approval enqueue; suggestion_only approve-only)
  /growth/drafts/{id}/queue          — Explicit enqueue (all modes)
  /growth/drafts/{id}/approval-history — Approval audit trail
  /growth/engagement/targets/*       — Engagement target CRUD
  /growth/engagement/opportunities/* — Opportunity review + execution
  /growth/engagement/actions         — Engagement action log
  /growth/engagement/caps            — Daily cap status

  /growth/analytics/metrics/ingest          — Ingest raw platform metrics
  /growth/analytics/variants/{id}/metrics  — Metrics for a specific variant
  /growth/analytics/overview               — Org-level platform performance
  /growth/analytics/top-content            — Top variants by engagement_rate
  /growth/analytics/roi                    — Engagement ROI attribution
  /growth/analytics/intelligence           — Growth intelligence summary
  /growth/analytics/intelligence/generate  — Trigger new summary generation

  /growth/accounts/status   — Per-platform connection health (social_accounts)
  /growth/radar             — Growth Radar intelligence snapshot

Not under /growth — separate prefix:
  /internal/sweep       — Stale-state recovery (secret-gated, cron-called)

Phase 8 (LinkedIn OAuth — built):
  /growth/oauth/linkedin/connect    — Start LinkedIn OAuth (GET, token= query param)
  /growth/oauth/linkedin/callback   — LinkedIn OAuth callback (GET)
  /growth/oauth/linkedin            — Disconnect LinkedIn (DELETE, Bearer JWT)

Phase 9 (Meta OAuth — built):
  /growth/oauth/meta/connect        — Start Meta/Facebook OAuth (GET, token= query param)
  /growth/oauth/meta/callback       — Meta OAuth callback (GET, handles facebook + instagram)
  /growth/oauth/meta/{platform}     — Disconnect Facebook or Instagram (DELETE, Bearer JWT)
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.accounts import router as accounts_router
from app.api.oauth_linkedin import router as oauth_linkedin_router
from app.api.oauth_meta import router as oauth_meta_router
from app.api.radar import router as radar_router
from app.api.assets import router as assets_router
from app.api.assets import variant_asset_router
from app.api.brand import router as brand_router
from app.api.drafts import router as drafts_router
from app.api.analytics import router as analytics_router
from app.api.engagement import router as engagement_router
from app.api.ideas import ladder_router, router as ideas_router
from app.api.org_settings import router as settings_router
from app.api.queue import router as queue_router

router = APIRouter(prefix="/growth")

router.include_router(brand_router)
router.include_router(settings_router)
router.include_router(ideas_router)
router.include_router(ladder_router)
router.include_router(drafts_router)
router.include_router(assets_router)
router.include_router(variant_asset_router)
router.include_router(queue_router)
router.include_router(engagement_router)
router.include_router(analytics_router)
router.include_router(accounts_router)
router.include_router(oauth_linkedin_router)
router.include_router(oauth_meta_router)
router.include_router(radar_router)
