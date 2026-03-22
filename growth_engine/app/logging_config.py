"""
Structured logging configuration for the Growth Engine.

Uses structlog with JSON output in production, coloured console in development.
All log entries include: timestamp, level, logger name, and structured key=value fields.

SECURITY RULES (enforced by convention — not automatic):
  - Never pass token/secret/key/password values as log field values.
  - Never log plaintext OAuth tokens, Fernet keys, or JWT strings.
  - Log only opaque identifiers: org_id, user_id, platform, status codes.
"""

from __future__ import annotations

import logging
import sys

import structlog

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


def configure_logging(log_level: str = "INFO", environment: str = "development") -> None:
    """
    Call once at application startup (inside lifespan or main.py).
    Idempotent — safe to call multiple times.
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]

    if environment == "production":
        # JSON output — parseable by Railway logs, Datadog, Logtail, etc.
        renderer = structlog.processors.JSONRenderer()
    else:
        # Human-friendly coloured output for local dev
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=shared_processors + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
        foreign_pre_chain=shared_processors,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers = [handler]
    root_logger.setLevel(level)

    # Quiet noisy third-party loggers
    for noisy in ("uvicorn.access", "asyncpg"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a named structlog logger. Call at module level."""
    return structlog.get_logger(name)
