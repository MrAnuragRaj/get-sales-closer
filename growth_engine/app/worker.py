"""
Growth Engine worker entry point.

This module is the long-running background worker. It runs separately from
the FastAPI API server — either as a separate Railway service or process.

Registered jobs:
  Every 30s  — publish_loop    (drain publish_queue → post to LinkedIn/FB/IG)
  07:30 UTC  — planner_loop    (generate daily content ideas for all paid orgs)
  08:00 UTC  — writer_loop     (run pipeline on pending ideas → auto-queue if mode=auto)

Upcoming jobs (Phase 6+):
  Every 2h   — engagement_job  (scan targets, generate engagement drafts)
  22:30 UTC  — metrics_job     (collect platform metrics)
  23:00 UTC  — scoring_job     (analytics learning loop)

To run the worker:
    python -m app.worker
"""

from __future__ import annotations

import asyncio
import signal
import sys
from datetime import datetime, time, timedelta, timezone

from app.config import settings
from app.db import close_pool, get_pool, init_pool
from app.logging_config import configure_logging, get_logger
from app.services.daily_jobs import run_planner_job, run_writer_job
from app.services.queue_worker import POLL_INTERVAL_S, run_publish_cycle

configure_logging(log_level=settings.log_level, environment=settings.environment)
log = get_logger(__name__)

_shutdown = asyncio.Event()

# Scheduled job times (UTC)
_PLANNER_TIME = time(7, 30, tzinfo=timezone.utc)   # 07:30 UTC
_WRITER_TIME  = time(8,  0, tzinfo=timezone.utc)   # 08:00 UTC


def _handle_signal(sig: signal.Signals) -> None:
    log.info("worker_shutdown_signal_received", signal=sig.name)
    _shutdown.set()


def _seconds_until(target: time) -> float:
    """
    Seconds from now until the next occurrence of target UTC time.
    If target is in the past today, returns seconds until tomorrow's occurrence.
    """
    now = datetime.now(timezone.utc)
    today_target = datetime.combine(now.date(), target)
    if today_target <= now:
        today_target += timedelta(days=1)
    return (today_target - now).total_seconds()


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
            log.error("publish_loop_cycle_error", error=str(exc))

        try:
            await asyncio.wait_for(
                asyncio.shield(_shutdown.wait()),
                timeout=POLL_INTERVAL_S,
            )
        except asyncio.TimeoutError:
            pass

    log.info("publish_loop_stopped")


async def _planner_loop() -> None:
    """
    Planner job — fires once per day at 07:30 UTC.
    Generates content ideas for all orgs on paid plans.
    """
    log.info("planner_loop_started", scheduled_utc=str(_PLANNER_TIME))
    pool = get_pool()

    while not _shutdown.is_set():
        wait_s = _seconds_until(_PLANNER_TIME)
        log.info("planner_loop_waiting", seconds=round(wait_s))

        try:
            await asyncio.wait_for(
                asyncio.shield(_shutdown.wait()),
                timeout=wait_s,
            )
            break  # shutdown triggered during wait
        except asyncio.TimeoutError:
            pass   # normal: target time reached

        if _shutdown.is_set():
            break

        try:
            log.info("planner_job_running")
            await run_planner_job(pool)
        except Exception as exc:
            log.error("planner_job_error", error=str(exc))

        # Sleep 60s before recalculating to avoid immediately re-firing
        try:
            await asyncio.wait_for(asyncio.shield(_shutdown.wait()), timeout=60)
        except asyncio.TimeoutError:
            pass

    log.info("planner_loop_stopped")


async def _writer_loop() -> None:
    """
    Writer job — fires once per day at 08:00 UTC.
    Runs the content pipeline on pending ideas; auto-queues if posting_mode=auto.
    """
    log.info("writer_loop_started", scheduled_utc=str(_WRITER_TIME))
    pool = get_pool()

    while not _shutdown.is_set():
        wait_s = _seconds_until(_WRITER_TIME)
        log.info("writer_loop_waiting", seconds=round(wait_s))

        try:
            await asyncio.wait_for(
                asyncio.shield(_shutdown.wait()),
                timeout=wait_s,
            )
            break
        except asyncio.TimeoutError:
            pass

        if _shutdown.is_set():
            break

        try:
            log.info("writer_job_running")
            await run_writer_job(pool)
        except Exception as exc:
            log.error("writer_job_error", error=str(exc))

        try:
            await asyncio.wait_for(asyncio.shield(_shutdown.wait()), timeout=60)
        except asyncio.TimeoutError:
            pass

    log.info("writer_loop_stopped")


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

    log.info(
        "growth_worker_ready",
        jobs=["publish_loop", "planner_loop", "writer_loop"],
    )

    await asyncio.gather(
        _publish_loop(),
        _planner_loop(),
        _writer_loop(),
    )

    log.info("growth_worker_shutting_down")
    await close_pool()
    log.info("growth_worker_stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
