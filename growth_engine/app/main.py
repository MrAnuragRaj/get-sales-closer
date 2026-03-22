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

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import close_pool, init_pool
from app.logging_config import configure_logging, get_logger
from app.api.router import router as growth_router
from app.api.internal import router as internal_router
from app.quotas import QuotaExceeded

# Configure structured logging before anything else runs.
configure_logging(log_level=settings.log_level, environment=settings.environment)
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """FastAPI lifespan: startup → yield → shutdown."""
    log.info(
        "growth_engine_starting",
        environment=settings.environment,
        enabled_platforms=settings.enabled_platforms(),
        platform_x_enabled=settings.platform_x_enabled,
    )

    await init_pool()
    log.info("growth_engine_ready")

    yield

    log.info("growth_engine_shutting_down")
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
