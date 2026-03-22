"""
Internal maintenance endpoints — not exposed to end users.

Routes:
  POST /internal/sweep                    — run all stale-state recovery sweeps
  POST /internal/run-scoring-worker       — process one batch of pending_score
                                            opportunities through the LLM scorer
  POST /internal/run-attribution-sweep    — match engaged influencer nodes to
                                            CRM leads (revenue attribution)

Auth:
  All routes require X-Internal-Secret header matching INTERNAL_SWEEP_SECRET
  from settings. If INTERNAL_SWEEP_SECRET is empty (not configured), all
  endpoints return 503 to prevent accidental open access.

  In production: configure INTERNAL_SWEEP_SECRET and pass it in your cron
  job's request header.

  Example Railway cron call:
    curl -X POST https://your-engine.railway.app/internal/sweep \\
         -H "X-Internal-Secret: your-secret-here"

    curl -X POST https://your-engine.railway.app/internal/run-scoring-worker \\
         -H "X-Internal-Secret: your-secret-here"

    curl -X POST https://your-engine.railway.app/internal/run-attribution-sweep \\
         -H "X-Internal-Secret: your-secret-here" \\
         -H "X-Org-Id: <org_uuid>"

Recommended cron schedule:
  /internal/sweep               every 5 minutes
  /internal/run-scoring-worker  every 1–2 minutes (keeps scoring lag low)
  /internal/run-attribution-sweep  daily (or on-demand after engagement activity)
  /internal/run-learning-sweep     daily per active org (respects 24h per-platform cooldown)

These routes are intentionally NOT mounted under /growth to keep them
clearly separated from the user-facing API.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, status

import uuid

from pydantic import BaseModel

from app.config import settings
from app.db import get_pool
from app.logging_config import get_logger
from app.services.sweeper import SweepResult, run_all_sweeps
from app.services.engagement.scoring_worker import run_scoring_worker
from app.services.revenue_attribution import run_attribution_sweep
from app.services.learning_loop import run_learning_sweep
from app.services.growth_radar import compute_radar
from app.services.feature_flags import ALLOWED_FLAGS, get_flag, list_flags, set_flag

log = get_logger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


def _check_secret(x_internal_secret: str | None) -> None:
    """
    Validate the internal secret header.

    Raises HTTP 503 if secret is not configured (mis-deployed).
    Raises HTTP 401 if secret is wrong or missing.
    """
    configured = settings.internal_sweep_secret
    if not configured:
        log.error("internal_endpoint_called_but_secret_not_configured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Internal endpoints are not configured on this deployment.",
        )
    if x_internal_secret != configured:
        log.warning("internal_endpoint_unauthorized_attempt")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Secret.",
        )


@router.post("/sweep")
async def run_sweep(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Run all stale-state recovery sweeps.

    Safe to call repeatedly — all sweeps are idempotent.
    Schedule every 5 minutes in production.

    Returns counts of rows recovered per sweep type.
    """
    _check_secret(x_internal_secret)

    pool = get_pool()
    result: SweepResult = await run_all_sweeps(pool)

    return {
        "status": "ok",
        "swept": {
            "stuck_generating_recovered": result.stuck_generating_recovered,
            "stuck_scoring_reset":        result.stuck_scoring_reset,
            "stuck_executing_recovered":  result.stuck_executing_recovered,
            "opportunities_expired":      result.opportunities_expired,
            "queue_orphans_failed":       result.queue_orphans_failed,
            "total":                      result.total(),
        },
    }


@router.post("/run-scoring-worker")
async def trigger_scoring_worker(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Process one batch of pending_score opportunities through the LLM scorer.

    Claims up to settings.scoring_worker_batch_size rows atomically
    (FOR UPDATE SKIP LOCKED), calls the scoring LLM for each, and
    transitions rows to pending_review, auto_approved, or failed.

    Safe to call concurrently — concurrent calls process non-overlapping rows.
    Schedule every 1–2 minutes in production to keep scoring lag low.

    Returns the number of opportunities processed in this batch.
    """
    _check_secret(x_internal_secret)

    pool = get_pool()
    processed = await run_scoring_worker(
        pool=pool,
        batch_size=settings.scoring_worker_batch_size,
    )

    return {
        "status":    "ok",
        "processed": processed,
        "batch_size": settings.scoring_worker_batch_size,
    }


@router.post("/run-attribution-sweep")
async def trigger_attribution_sweep(
    x_internal_secret: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
) -> dict:
    """
    Match engaged influencer nodes to CRM leads for one org.

    Runs two match strategies:
      1. messenger_psid exact match (confidence 0.9)
      2. author_name case-insensitive match (confidence 0.6)

    Idempotent — safe to run repeatedly; duplicates are skipped via
    the UNIQUE (org_id, lead_id, influencer_node_id) constraint.

    Requires X-Org-Id header with the org UUID to sweep.
    Recommended: daily cron or on-demand after significant engagement activity.

    Returns count of new attributions written in this run.
    """
    _check_secret(x_internal_secret)

    if not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id header is required.",
        )
    try:
        org_id = uuid.UUID(x_org_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id must be a valid UUID.",
        )

    pool = get_pool()
    attributed = await run_attribution_sweep(pool=pool, org_id=org_id)

    return {
        "status":     "ok",
        "org_id":     str(org_id),
        "attributed": attributed,
    }


@router.post("/run-learning-sweep")
async def trigger_learning_sweep(
    x_internal_secret: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
) -> dict:
    """
    Run the learning loop for one org — adjust per-platform scoring thresholds
    based on rolling 30-day execution success rates.

    Guardrails enforced:
      - 24h cooldown per org/platform (skips if recently computed)
      - Minimum sample: loosen requires ≥10, tighten requires ≥5 executions
      - Threshold bounds: conf [0.60–0.95], risk [0.15–0.50]
      - Audit log: every run written to growth.learning_events

    Only has effect when LEARNING_LOOP_ENABLED=true in settings.
    Safe to run regardless of flag — sweep runs but scoring worker ignores
    learned values when flag is off.

    Requires X-Org-Id header. Recommended: daily cron per active org.
    """
    _check_secret(x_internal_secret)

    if not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id header is required.",
        )
    try:
        org_id = uuid.UUID(x_org_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id must be a valid UUID.",
        )

    pool    = get_pool()
    updates = await run_learning_sweep(pool=pool, org_id=org_id)
    learning_enabled = await get_flag(pool, "learning_loop")

    return {
        "status":              "ok",
        "org_id":              str(org_id),
        "learning_enabled":    learning_enabled,
        "platforms_processed": len(updates),
        "updates": [
            {
                "platform":           u.platform,
                "old_conf_threshold": u.old_conf,
                "new_conf_threshold": u.new_conf,
                "old_risk_threshold": u.old_risk,
                "new_risk_threshold": u.new_risk,
                "success_rate":       u.success_rate,
                "sample_size":        u.sample_size,
                "reason":             u.reason,
                "thresholds_changed": u.thresholds_changed,
            }
            for u in updates
        ],
    }


@router.post("/run-radar")
async def trigger_radar(
    x_internal_secret: str | None = Header(default=None),
    x_org_id: str | None = Header(default=None),
) -> dict:
    """
    Compute (or refresh) the Growth Radar snapshot for one org.

    Aggregates top authors, top content angles, engagement health stats,
    and revenue attribution summary into a single stored snapshot.

    No LLM calls. Runs in < 100ms. Safe to call repeatedly — overwrites
    the existing snapshot for the org via ON CONFLICT DO UPDATE.

    Requires X-Org-Id header. Recommended: daily or weekly cron.
    """
    _check_secret(x_internal_secret)

    if not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id header is required.",
        )
    try:
        org_id = uuid.UUID(x_org_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="X-Org-Id must be a valid UUID.",
        )

    pool     = get_pool()
    snapshot = await compute_radar(pool=pool, org_id=org_id)

    return {
        "status":      "ok",
        "org_id":      str(org_id),
        "computed_at": snapshot.get("computed_at"),
        "summary": {
            "top_authors_count":  len(snapshot.get("top_authors") or []),
            "top_angles_count":   len(snapshot.get("top_angles")  or []),
            "total_executed":     (snapshot.get("engagement_health") or {}).get("total_executed"),
            "total_attributed":   (snapshot.get("attribution_summary") or {}).get("total_attributed"),
        },
    }


# ── Feature flags ─────────────────────────────────────────────────────────────

class _FlagUpdate(BaseModel):
    enabled: bool
    updated_by_user_id: str | None = None   # optional: pass admin user UUID


@router.get("/feature-flags")
async def get_feature_flags(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Return all feature flags for the active environment.

    Use this to read current state before toggling.
    """
    _check_secret(x_internal_secret)

    pool  = get_pool()
    flags = await list_flags(pool)

    return {
        "status":      "ok",
        "environment": settings.environment,
        "flags": [
            {
                "key":                 r["key"],
                "enabled":             r["enabled"],
                "updated_at":          r["updated_at"].isoformat() if r["updated_at"] else None,
                "updated_by_user_id":  str(r["updated_by_user_id"]) if r["updated_by_user_id"] else None,
            }
            for r in flags
        ],
    }


@router.post("/feature-flags/{key}")
async def update_feature_flag(
    key: str,
    body: _FlagUpdate,
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Enable or disable a feature flag for the active environment.

    Only the following keys are accepted:
      growth_graph_priority  — prioritise scoring queue by relationship strength
      learning_loop          — adaptive scoring thresholds (per-org learned values)

    Audit: pass updated_by_user_id in the request body to record who toggled.
    Effect: within 60 seconds (TTL cache) all worker runs will see the new value.
    """
    _check_secret(x_internal_secret)

    if key not in ALLOWED_FLAGS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown flag '{key}'. Allowed: {sorted(ALLOWED_FLAGS)}",
        )

    user_id: uuid.UUID | None = None
    if body.updated_by_user_id:
        try:
            user_id = uuid.UUID(body.updated_by_user_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="updated_by_user_id must be a valid UUID.",
            )

    pool = get_pool()
    await set_flag(pool=pool, key=key, enabled=body.enabled, updated_by_user_id=user_id)

    return {
        "status":      "ok",
        "environment": settings.environment,
        "key":         key,
        "enabled":     body.enabled,
    }
