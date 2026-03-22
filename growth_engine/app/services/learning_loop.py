"""
Learning Loop — adaptive scoring thresholds.

Computes per-org per-platform auto-approval thresholds from real execution
outcomes and writes them to growth.learning_state.

Guardrails (all enforced, none configurable in v1):
  - Feature-flagged: no effect unless LEARNING_LOOP_ENABLED=true
  - 24h cooldown: only one threshold adjustment per org/platform per day
  - Minimum sample: loosen requires ≥10 executions, tighten requires ≥5
  - Threshold bounds: conf [0.60, 0.95], risk [0.15, 0.50]
  - Audit log: every adjustment (including no-change) written to learning_events

Adjustment rules:
  Loosen (system earned trust):
    success_rate ≥ 0.85 AND sample_size ≥ 10
    → conf -= 0.02, risk += 0.02

  Tighten (something is wrong):
    success_rate < 0.50 AND sample_size ≥ 5
    → conf += 0.05, risk -= 0.05

  No change:
    anything else (insufficient data, rate in acceptable range)

Called by:
  POST /internal/run-learning-sweep
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)

# ── Hardcoded system defaults ─────────────────────────────────────────────────
DEFAULT_CONF_THRESHOLD = 0.750
DEFAULT_RISK_THRESHOLD = 0.300

# ── Adjustment magnitudes ─────────────────────────────────────────────────────
LOOSEN_CONF_DELTA  = 0.02
LOOSEN_RISK_DELTA  = 0.02   # risk threshold rises → more risk tolerated
TIGHTEN_CONF_DELTA = 0.05
TIGHTEN_RISK_DELTA = 0.05   # risk threshold falls → less risk tolerated

# ── Minimum sample sizes (hardcoded, do not lower) ───────────────────────────
MIN_SAMPLE_LOOSEN  = 10
MIN_SAMPLE_TIGHTEN = 5

# ── Threshold bounds ──────────────────────────────────────────────────────────
CONF_MIN, CONF_MAX = 0.60, 0.95
RISK_MIN, RISK_MAX = 0.15, 0.50

# ── Thresholds for rate classification ───────────────────────────────────────
LOOSEN_RATE_THRESHOLD  = 0.85
TIGHTEN_RATE_THRESHOLD = 0.50

# ── Cooldown ──────────────────────────────────────────────────────────────────
COOLDOWN_HOURS = 24


@dataclass
class LearningUpdate:
    platform:              str
    old_conf:              float
    new_conf:              float
    old_risk:              float
    new_risk:              float
    success_rate:          float
    sample_size:           int
    reason:                str
    thresholds_changed:    bool


async def run_learning_sweep(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> list[LearningUpdate]:
    """
    Run the learning sweep for one org across all platforms with recent data.

    Returns a list of LearningUpdate records (one per platform processed).
    Platforms with no executions in the last 30 days are skipped.
    Platforms still within their 24h cooldown are skipped.
    """
    platforms = await _get_active_platforms(pool, org_id)
    updates: list[LearningUpdate] = []

    for platform in platforms:
        update = await _process_platform(pool, org_id, platform)
        if update:
            updates.append(update)

    log.info(
        "learning_sweep_complete",
        org_id=str(org_id),
        platforms_processed=len(updates),
        thresholds_changed=sum(1 for u in updates if u.thresholds_changed),
    )
    return updates


async def get_thresholds(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> tuple[float, float]:
    """
    Return effective (conf_threshold, risk_threshold) for this org/platform.

    Falls back to system defaults if no learning_state row exists yet.
    Always returns valid floats — never raises.
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT auto_conf_threshold, auto_risk_threshold
                FROM growth.learning_state
                WHERE org_id = $1 AND platform = $2
                """,
                org_id, platform,
            )
        if row:
            return float(row["auto_conf_threshold"]), float(row["auto_risk_threshold"])
    except Exception as exc:
        log.error(
            "learning_get_thresholds_failed",
            org_id=str(org_id), platform=platform, error=str(exc),
        )
    return DEFAULT_CONF_THRESHOLD, DEFAULT_RISK_THRESHOLD


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _get_active_platforms(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> list[str]:
    """Return distinct platforms with executed actions in the last 30 days."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT platform
            FROM growth.engagement_actions
            WHERE org_id = $1
              AND executed_at > NOW() - INTERVAL '30 days'
            """,
            org_id,
        )
    return [r["platform"] for r in rows]


async def _process_platform(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> Optional[LearningUpdate]:
    """
    Process one org/platform pair.

    Returns LearningUpdate if processed, None if skipped (cooldown or no data).
    """
    # ── Fetch current state (or use defaults) ────────────────────────────────
    async with pool.acquire() as conn:
        state = await conn.fetchrow(
            """
            SELECT auto_conf_threshold, auto_risk_threshold, last_computed_at
            FROM growth.learning_state
            WHERE org_id = $1 AND platform = $2
            """,
            org_id, platform,
        )

    current_conf = float(state["auto_conf_threshold"]) if state else DEFAULT_CONF_THRESHOLD
    current_risk = float(state["auto_risk_threshold"]) if state else DEFAULT_RISK_THRESHOLD
    last_computed = state["last_computed_at"] if state else None

    # ── 24h cooldown guard ────────────────────────────────────────────────────
    if last_computed:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=COOLDOWN_HOURS)
        if last_computed.replace(tzinfo=timezone.utc) > cutoff:
            log.debug(
                "learning_sweep_cooldown_skip",
                org_id=str(org_id), platform=platform,
                last_computed=str(last_computed),
            )
            return None

    # ── Compute rolling 30-day stats ──────────────────────────────────────────
    async with pool.acquire() as conn:
        stats = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                          AS total,
                COUNT(*) FILTER (WHERE status = 'success')       AS successes
            FROM growth.engagement_actions
            WHERE org_id     = $1
              AND platform   = $2
              AND executed_at > NOW() - INTERVAL '30 days'
            """,
            org_id, platform,
        )

    total      = int(stats["total"])
    successes  = int(stats["successes"])

    if total == 0:
        return None  # No data — skip silently

    success_rate = round(successes / total, 4)

    # ── Apply adjustment rules ────────────────────────────────────────────────
    new_conf = current_conf
    new_risk = current_risk
    reason   = "no_change"

    if success_rate >= LOOSEN_RATE_THRESHOLD and total >= MIN_SAMPLE_LOOSEN:
        # System earned trust — loosen thresholds slightly
        new_conf = round(max(CONF_MIN, current_conf - LOOSEN_CONF_DELTA), 3)
        new_risk = round(min(RISK_MAX, current_risk + LOOSEN_RISK_DELTA), 3)
        reason   = "loosened_due_to_success"

    elif success_rate < TIGHTEN_RATE_THRESHOLD and total >= MIN_SAMPLE_TIGHTEN:
        # Failures prevalent — tighten thresholds
        new_conf = round(min(CONF_MAX, current_conf + TIGHTEN_CONF_DELTA), 3)
        new_risk = round(max(RISK_MIN, current_risk - TIGHTEN_RISK_DELTA), 3)
        reason   = "tightened_due_to_failures"

    thresholds_changed = (new_conf != current_conf or new_risk != current_risk)

    # ── Persist updated learning_state ───────────────────────────────────────
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.learning_state
                (org_id, platform, auto_conf_threshold, auto_risk_threshold,
                 execution_success_rate, sample_size, last_computed_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (org_id, platform) DO UPDATE
                SET auto_conf_threshold    = EXCLUDED.auto_conf_threshold,
                    auto_risk_threshold    = EXCLUDED.auto_risk_threshold,
                    execution_success_rate = EXCLUDED.execution_success_rate,
                    sample_size            = EXCLUDED.sample_size,
                    last_computed_at       = EXCLUDED.last_computed_at,
                    updated_at             = NOW()
            """,
            org_id, platform, new_conf, new_risk, success_rate, total,
        )

        # ── Audit log (always written, even when no change) ──────────────────
        await conn.execute(
            """
            INSERT INTO growth.learning_events
                (org_id, platform,
                 old_conf_threshold, new_conf_threshold,
                 old_risk_threshold, new_risk_threshold,
                 execution_success_rate, sample_size, reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            org_id, platform,
            current_conf, new_conf,
            current_risk, new_risk,
            success_rate, total, reason,
        )

    if thresholds_changed:
        log.info(
            "learning_threshold_adjusted",
            org_id=str(org_id), platform=platform,
            old_conf=current_conf, new_conf=new_conf,
            old_risk=current_risk, new_risk=new_risk,
            success_rate=success_rate, sample_size=total,
            reason=reason,
        )
    else:
        log.debug(
            "learning_no_threshold_change",
            org_id=str(org_id), platform=platform,
            success_rate=success_rate, sample_size=total,
        )

    return LearningUpdate(
        platform=platform,
        old_conf=current_conf,
        new_conf=new_conf,
        old_risk=current_risk,
        new_risk=new_risk,
        success_rate=success_rate,
        sample_size=total,
        reason=reason,
        thresholds_changed=thresholds_changed,
    )
