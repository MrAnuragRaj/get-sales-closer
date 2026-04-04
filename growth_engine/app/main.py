"""
Growth Engine — FastAPI application entry point.

Startup:
  1. Configure structured logging.
  2. Initialize async Postgres connection pool.
  3. Mount all API routes under /growth.

Shutdown:
  1. Gracefully close the connection pool.

Health check at GET /health — used by Railway for deploy readiness.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import close_pool, get_pool, init_pool
from app.logging_config import configure_logging, get_logger
from app.api.router import router as growth_router
from app.api.internal import router as internal_router
from app.quotas import QuotaExceeded

# Configure structured logging before anything else runs.
configure_logging(log_level=settings.log_level, environment=settings.environment)
log = get_logger(__name__)


async def _publish_worker_loop() -> None:
    """
    Drain the publish queue every 30 seconds.
    Runs as a background asyncio task alongside the API server so the single
    Railway service handles both HTTP requests and background publishing.
    """
    from app.services.queue_worker import POLL_INTERVAL_S, run_publish_cycle
    pool = get_pool()
    log.info("publish_worker_loop_started", poll_interval_s=POLL_INTERVAL_S)
    while True:
        try:
            processed = await run_publish_cycle(pool)
            if processed > 0:
                log.info("publish_worker_cycle", items=processed)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("publish_worker_cycle_error", error=str(exc))
        await asyncio.sleep(POLL_INTERVAL_S)


async def _planner_loop() -> None:
    """
    Daily planner job — runs at 07:30 UTC.
    For every org with growth_engine active + a brand profile, generates 5 content ideas.
    Skips orgs without a brand profile (user must complete brand setup first).
    """
    from app.services import brand_brain
    from app.services import planner as planner_svc
    pool = get_pool()
    log.info("planner_loop_started")

    while True:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=7, minute=30, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - datetime.now(timezone.utc)).total_seconds())

        log.info("planner_job_starting")
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT os.org_id
                    FROM org_services os
                    WHERE os.service_key = 'growth_engine' AND os.status = 'active'
                    """
                )
            org_ids = [r["org_id"] for r in rows]
            log.info("planner_job_orgs", count=len(org_ids))

            for org_id in org_ids:
                try:
                    brand = await brand_brain.get_brand_profile(pool, org_id)
                    if not brand:
                        log.info("planner_job_skip_no_brand", org_id=str(org_id))
                        continue
                    idea_ids = await planner_svc.run_regular_planner(
                        pool=pool,
                        org_id=org_id,
                        brand=brand,
                        n=5,
                        planned_for=datetime.now(timezone.utc).date(),
                    )
                    log.info("planner_job_org_done", org_id=str(org_id), ideas=len(idea_ids))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.error("planner_job_org_error", org_id=str(org_id), error=str(exc))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("planner_job_error", error=str(exc))


async def _writer_loop() -> None:
    """
    Daily writer job — runs at 08:00 UTC.
    Picks up all generated content ideas and runs the full content pipeline
    (angle → hook tournament → draft → critic → save variant).
    """
    from app.services import brand_brain
    from app.services.content_pipeline import run_pipeline_for_idea
    pool = get_pool()
    log.info("writer_loop_started")

    while True:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=8, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - datetime.now(timezone.utc)).total_seconds())

        log.info("writer_job_starting")
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT id, org_id
                    FROM growth.content_ideas
                    WHERE status = 'generated'
                    ORDER BY planned_for ASC NULLS LAST, created_at ASC
                    LIMIT 50
                    """
                )
            log.info("writer_job_ideas", count=len(rows))

            for row in rows:
                try:
                    brand = await brand_brain.get_brand_profile(pool, row["org_id"])
                    if not brand:
                        log.info("writer_job_skip_no_brand", idea_id=str(row["id"]))
                        continue
                    await run_pipeline_for_idea(
                        pool=pool,
                        org_id=row["org_id"],
                        brand=brand,
                        idea_id=row["id"],
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.error("writer_job_idea_error", idea_id=str(row["id"]), error=str(exc))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("writer_job_error", error=str(exc))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """FastAPI lifespan: startup → background tasks → yield → shutdown."""
    log.info(
        "growth_engine_starting",
        environment=settings.environment,
        enabled_platforms=settings.enabled_platforms(),
        platform_x_enabled=settings.platform_x_enabled,
    )

    await init_pool()

    # Start background workers alongside the API server.
    # This removes the need for a separate Railway worker service.
    _bg_tasks = [
        asyncio.create_task(_publish_worker_loop(), name="publish_worker"),
        asyncio.create_task(_planner_loop(),        name="planner_daily"),
        asyncio.create_task(_writer_loop(),         name="writer_daily"),
    ]
    log.info("growth_engine_ready", background_tasks=[t.get_name() for t in _bg_tasks])

    yield

    log.info("growth_engine_shutting_down")
    for t in _bg_tasks:
        t.cancel()
    await asyncio.gather(*_bg_tasks, return_exceptions=True)
    await close_pool()
    log.info("growth_engine_stopped")


app = FastAPI(
    title="GetSalesCloser Growth Engine",
    description=(
        "AI-powered Social Growth Engine — content generation, scheduling, "
        "publishing, engagement automation, and ROI analytics."
    ),
    version="1.0.0",
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Development: allow all origins (local dashboard, Postman, etc.)
# Staging + Production: restrict to the live GetSalesCloser domain only.
# Staging intentionally uses the production allowlist — no separate staging
# frontend exists, and loose staging CORS could be used to probe prod data.
_origins = (
    ["*"]
    if settings.environment == "development"
    else [
        "https://www.getsalescloser.com",
        "https://getsalescloser.com",
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        # Internal maintenance endpoints (curl/cron only — not browser-initiated,
        # but declared here so preflight checks never silently reject them)
        "X-Internal-Secret",
        "X-Org-Id",
    ],
)


# ── Global exception handlers ─────────────────────────────────────────────────

@app.exception_handler(QuotaExceeded)
async def quota_exceeded_handler(request, exc: QuotaExceeded) -> JSONResponse:
    """
    Surface quota errors as HTTP 429 with structured body.
    The 'quota_type' field allows frontend to show the correct upgrade prompt.
    """
    return JSONResponse(
        status_code=429,
        content={
            "error": "quota_exceeded",
            "quota_type": exc.quota_type,
            "detail": exc.detail,
        },
    )


@app.exception_handler(ValueError)
async def value_error_handler(request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "bad_request", "detail": str(exc)})


# ── Routes ────────────────────────────────────────────────────────────────────

app.include_router(growth_router)
app.include_router(internal_router)   # /internal/* — cron-only, secret-gated


@app.get("/health", tags=["System"])
async def health() -> dict:
    """
    Health check endpoint — used by Railway deploy readiness probe.
    Returns 200 if the service is up. DB connectivity is checked via pool.
    """
    from app.db import get_pool
    try:
        pool = get_pool()
        await pool.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        db_ok = False

    return {
        "status": "ok" if db_ok else "degraded",
        "db": "connected" if db_ok else "error",
        "environment": settings.environment,
        "platforms_active": settings.enabled_platforms(),
        "platform_x_status": "active" if settings.platform_x_enabled else "dormant_by_config",
    }


@app.get("/", tags=["System"])
async def root() -> dict:
    return {"service": "GetSalesCloser Growth Engine", "version": "1.0.0"}
