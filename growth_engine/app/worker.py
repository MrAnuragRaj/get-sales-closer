"""
Growth Engine worker entry point.

This module is the long-running background worker. It runs separately from
the FastAPI API server — either as a separate Railway service or process.

Registered jobs:
  Every 30s — publish_job   (drain the publish_queue via run_publish_cycle)

Upcoming jobs (Phase 5+):
  07:30 UTC — planner_job          (generate daily content ideas)
  08:00 UTC — writer_job           (draft platform variants from ideas)
  08:20 UTC — image_job            (render Pillow images for approved variants)
  Every 2h  — engagement_job       (scan targets, generate engagement drafts)
  22:30 UTC — metrics_job          (collect platform metrics)
  23:00 UTC — scoring_job          (analytics learning loop)

To run the worker:
    python -m app.worker
"""

from __future__ import annotations

import asyncio
import signal
import sys

from app.config import settings
from app.db import close_pool, get_pool, init_pool
from app.logging_config import configure_logging, get_logger
from app.services.queue_worker import POLL_INTERVAL_S, run_publish_cycle

configure_logging(log_level=settings.log_level, environment=settings.environment)
log = get_logger(__name__)

_shutdown = asyncio.Event()


def _handle_signal(sig: signal.Signals) -> None:
    log.info("worker_shutdown_signal_received", signal=sig.name)
    _shutdown.set()


async def _publish_loop() -> None:
    """
    Publish queue drain loop — runs every POLL_INTERVAL_S seconds.
    Stops cleanly when _shutdown is set.
    """
    log.info("publish_loop_started", poll_interval_s=POLL_INTERVAL_S)
    pool = get_pool()

    while not _shutdown.is_set():
        try:
            processed = await run_publish_cycle(pool)
            if processed > 0:
                log.info("publish_loop_cycle", items=processed)
        except Exception as exc:
            # Never let a cycle crash kill the loop
            log.error("publish_loop_cycle_error", error=str(exc))

        # Wait for next cycle or shutdown — whichever comes first
        try:
            await asyncio.wait_for(
                asyncio.shield(_shutdown.wait()),
                timeout=POLL_INTERVAL_S,
            )
        except asyncio.TimeoutError:
            pass  # Normal path — poll interval elapsed

    log.info("publish_loop_stopped")


async def main() -> None:
    log.info(
        "growth_worker_starting",
        environment=settings.environment,
        enabled_platforms=settings.enabled_platforms(),
    )

    await init_pool()

    loop = asyncio.get_event_loop()
    loop.add_signal_handler(signal.SIGTERM, lambda: _handle_signal(signal.SIGTERM))
    loop.add_signal_handler(signal.SIGINT,  lambda: _handle_signal(signal.SIGINT))

    log.info("growth_worker_ready", jobs=["publish_loop"])

    # Run all background jobs concurrently
    await asyncio.gather(
        _publish_loop(),
    )

    log.info("growth_worker_shutting_down")
    await close_pool()
    log.info("growth_worker_stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
