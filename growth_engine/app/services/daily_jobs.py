"""
Daily scheduled jobs for the Growth Engine.

planner_job — runs daily at 07:30 UTC
  Generates today's content ideas for every org on a paid plan with a brand profile.
  Number of ideas = plan.daily_content_pieces (1/2/3 for starter/growth/scale).

writer_job  — runs daily at 08:00 UTC
  Runs the full content pipeline on every pending idea created by the planner.
  Pipeline: angle → hook → write → critic → rewrite → save.
  If posting_mode='auto' and critic passes → variant is auto-enqueued immediately
  (handled inside approval_engine.handle_pipeline_completion — no extra logic needed here).
  Quota (check_and_increment_content_quota) is consumed per idea; stops when limit hit.
"""

from __future__ import annotations

import uuid
from datetime import date

import asyncpg

from app.entitlements import get_content_plan
from app.logging_config import get_logger
from app.quotas import QuotaExceeded, check_and_increment_content_quota
from app.services import brand_brain
from app.services import planner as planner_svc
from app.services.content_pipeline import run_pipeline_for_idea

log = get_logger(__name__)


async def run_planner_job(pool: asyncpg.Pool) -> None:
    """
    Generate today's content ideas for all orgs on paid (automatable) plans.

    Skips orgs without a brand profile — content generation requires brand context.
    One org failure never stops processing for other orgs.
    """
    today = date.today()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT org_id, plan_key
            FROM growth.org_growth_settings
            WHERE plan_key != 'free'
            ORDER BY org_id
            """
        )

    log.info("planner_job_started", org_count=len(rows), date=today.isoformat())

    succeeded = 0
    for row in rows:
        org_id: uuid.UUID = row["org_id"]
        plan_key: str = row["plan_key"]

        try:
            plan = get_content_plan(plan_key)
            if not plan.can_automate:
                log.debug("planner_job_skip_no_automate", org_id=str(org_id), plan=plan_key)
                continue

            brand = await brand_brain.get_brand_profile(pool, org_id)
            if not brand:
                log.warning("planner_job_no_brand", org_id=str(org_id))
                continue

            idea_ids = await planner_svc.run_regular_planner(
                pool=pool,
                org_id=org_id,
                brand=brand,
                n=plan.daily_content_pieces,
                planned_for=today,
            )

            log.info(
                "planner_job_org_done",
                org_id=str(org_id),
                plan=plan_key,
                ideas_created=len(idea_ids),
            )
            succeeded += 1

        except Exception as exc:
            log.error("planner_job_org_failed", org_id=str(org_id), error=str(exc))

    log.info("planner_job_done", orgs_succeeded=succeeded, orgs_total=len(rows))


async def run_writer_job(pool: asyncpg.Pool) -> None:
    """
    Run the content pipeline on all pending ideas for orgs on paid plans.

    Ideas are processed in creation order per org.
    Quota is checked before each idea — stops writing for an org when limit is hit.
    Auto-queuing is handled inside run_pipeline_for_idea → handle_pipeline_completion,
    so this job does not need to touch the publish queue directly.
    """
    today = date.today()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ci.id AS idea_id, ci.org_id
            FROM growth.content_ideas ci
            JOIN growth.org_growth_settings ogs ON ogs.org_id = ci.org_id
            WHERE ci.status = 'generated'
              AND (ci.planned_for IS NULL OR ci.planned_for <= $1)
              AND ogs.plan_key != 'free'
            ORDER BY ci.org_id, ci.created_at ASC
            """,
            today,
        )

    log.info("writer_job_started", idea_count=len(rows), date=today.isoformat())

    # Group ideas by org so quota is tracked per org
    by_org: dict[uuid.UUID, list[uuid.UUID]] = {}
    for row in rows:
        by_org.setdefault(row["org_id"], []).append(row["idea_id"])

    orgs_succeeded = 0
    ideas_total = 0

    for org_id, idea_ids in by_org.items():
        try:
            brand = await brand_brain.get_brand_profile(pool, org_id)
            if not brand:
                log.warning("writer_job_no_brand", org_id=str(org_id))
                continue

            org_ideas_done = 0

            for idea_id in idea_ids:
                # Quota check: stops this org when daily limit is reached
                try:
                    await check_and_increment_content_quota(pool, org_id, today)
                except QuotaExceeded as qe:
                    log.info(
                        "writer_job_quota_hit",
                        org_id=str(org_id),
                        ideas_done=org_ideas_done,
                        detail=qe.detail,
                    )
                    break

                results = await run_pipeline_for_idea(
                    pool=pool,
                    org_id=org_id,
                    brand=brand,
                    idea_id=idea_id,
                )

                succeeded_variants = sum(1 for r in results if r.succeeded)
                auto_queued = sum(
                    1 for r in results if r.succeeded and r.status == "queued"
                )

                log.info(
                    "writer_job_idea_done",
                    org_id=str(org_id),
                    idea_id=str(idea_id),
                    platforms=len(results),
                    succeeded=succeeded_variants,
                    auto_queued=auto_queued,
                )

                org_ideas_done += 1
                ideas_total += 1

            orgs_succeeded += 1

        except Exception as exc:
            log.error("writer_job_org_failed", org_id=str(org_id), error=str(exc))

    log.info(
        "writer_job_done",
        orgs_processed=orgs_succeeded,
        ideas_processed=ideas_total,
    )
