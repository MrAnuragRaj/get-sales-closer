"""
Growth Engine configuration — loaded from environment variables.
Uses pydantic-settings for validation and type coercion.
All secrets are loaded once at startup; never re-read per request.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Postgres ────────────────────────────────────────────────────────────
    database_url: str = Field(..., description="asyncpg-compatible Postgres URL")
    db_pool_min_size: int = Field(2, ge=1)
    db_pool_max_size: int = Field(10, ge=1)

    # ── Auth ────────────────────────────────────────────────────────────────
    supabase_jwt_secret: str = Field(..., description="Supabase JWT signing secret (HS256)")

    # ── Token encryption ────────────────────────────────────────────────────
    # Primary Fernet key (URL-safe base64, 32-byte key)
    growth_encryption_key: str = Field(..., description="Primary Fernet encryption key")
    # Optional previous key — only set during key rotation window
    growth_encryption_key_previous: str = Field(
        default="", description="Previous Fernet key for rotation (leave blank normally)"
    )

    # ── Service ─────────────────────────────────────────────────────────────
    service_host: str = "0.0.0.0"
    service_port: int = 8080
    environment: Literal["development", "staging", "production"] = "development"

    # ── Platform feature flags ──────────────────────────────────────────────
    # X is fully architected but INACTIVE in v1.
    # Enabling X requires only: PLATFORM_X_ENABLED=true + X credentials.
    # No code or schema changes needed.
    platform_linkedin_enabled: bool = True
    platform_facebook_enabled: bool = True
    platform_instagram_enabled: bool = True
    platform_x_enabled: bool = False   # LOCKED INACTIVE in v1

    # ── Platform credentials ────────────────────────────────────────────────
    linkedin_client_id: str = ""
    linkedin_client_secret: str = ""

    # Meta covers both Facebook Pages and Instagram Business (bundled OAuth)
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_webhook_verify_token: str = ""

    # X credentials (architecture complete, activation deferred)
    x_api_key: str = ""
    x_api_secret: str = ""
    x_bearer_token: str = ""

    # ── Supabase Storage ────────────────────────────────────────────────────
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    growth_assets_bucket: str = "growth-assets"

    # ── AI ──────────────────────────────────────────────────────────────────
    openai_api_key: str = ""

    # ── Internal maintenance ────────────────────────────────────────────────
    # Shared secret for POST /internal/sweep.
    # Required in production — set a strong random value and pass it in cron headers.
    # If left empty the sweep endpoint returns 503 (safe default).
    internal_sweep_secret: str = Field(
        default="",
        description="Shared secret for internal endpoints (X-Internal-Secret header)",
    )

    # ── Learning Loop ───────────────────────────────────────────────────────────
    # When enabled, scoring worker uses per-org learned thresholds instead of
    # plan-level hardcoded defaults. Keep False until enough execution data
    # has accumulated (at least a few days of traffic per platform).
    # Flip on to activate; flip off instantly if unexpected behavior appears.
    learning_loop_enabled: bool = Field(
        default=False,
        description="Use per-org learned scoring thresholds instead of plan defaults",
    )

    # ── Growth Graph ────────────────────────────────────────────────────────────
    # When enabled, scoring worker prioritizes authors with prior engagement history.
    # Keep False until Growth Graph data has accumulated (a few days of traffic).
    # Flip to True to activate; flip back to False instantly if any issues appear.
    growth_graph_priority_enabled: bool = Field(
        default=False,
        description="Prioritize scoring queue by influencer relationship strength",
    )

    # ── Scoring worker ──────────────────────────────────────────────────────────
    # Number of pending_score opportunities processed per worker invocation.
    # Raise this if cron frequency is low; lower it if LLM latency is high.
    scoring_worker_batch_size: int = Field(
        default=10,
        ge=1, le=100,
        description="Max opportunities scored per /internal/run-scoring-worker call",
    )

    # ── OAuth return target ──────────────────────────────────────────────────
    # The GSC dashboard URL that LinkedIn/Meta OAuth redirects back to after success/failure.
    # Default: production URL. Override in development: http://localhost:3000
    gsc_dashboard_url: str = Field(
        default="https://www.getsalescloser.com",
        description="GSC dashboard base URL — used as OAuth post-connect redirect target",
    )

    # ── Logging ─────────────────────────────────────────────────────────────
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    @field_validator("database_url")
    @classmethod
    def _validate_db_url(cls, v: str) -> str:
        if not v.startswith(("postgresql://", "postgresql+asyncpg://")):
            raise ValueError(
                "DATABASE_URL must start with 'postgresql://' or 'postgresql+asyncpg://'"
            )
        # Normalize: asyncpg does not accept 'postgresql+asyncpg://' prefix
        return v.replace("postgresql+asyncpg://", "postgresql://")

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def enabled_platforms(self) -> list[str]:
        """Return list of currently enabled platform identifiers."""
        platforms = []
        if self.platform_linkedin_enabled:
            platforms.append("linkedin")
        if self.platform_facebook_enabled:
            platforms.append("facebook")
        if self.platform_instagram_enabled:
            platforms.append("instagram")
        if self.platform_x_enabled:
            platforms.append("x")
        return platforms


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton — loaded once at process start."""
    return Settings()


# Module-level alias for convenience
settings: Settings = get_settings()
