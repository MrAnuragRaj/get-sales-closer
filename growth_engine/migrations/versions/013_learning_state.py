"""
Migration 013 — Learning Loop: per-org per-platform scoring thresholds.

Creates two tables:

  growth.learning_state
    One row per (org_id, platform).
    Stores the current effective auto-approval thresholds.
    Starts at the same defaults as the hardcoded values.
    Updated by the learning sweep (once per 24h per org/platform).

  growth.learning_events
    Append-only audit log of every threshold adjustment.
    Records old/new thresholds, success rate, sample size, and reason.
    Never deleted — provides full history for trust and debugging.

The scoring worker reads from learning_state when LEARNING_LOOP_ENABLED=true.
When the flag is false it uses the hardcoded defaults regardless of this table.

Threshold bounds (enforced by learning_loop.py, not DB constraints):
  auto_conf_threshold: 0.60 – 0.95
  auto_risk_threshold: 0.15 – 0.50
"""

revision:    str = "013"
down_revision    = "012"


upgrade_sql = """
-- ── Effective scoring thresholds (one row per org/platform) ──────────────────

CREATE TABLE IF NOT EXISTS growth.learning_state (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID        NOT NULL
                            REFERENCES public.organizations(id) ON DELETE CASCADE,
    platform                TEXT        NOT NULL,

    -- Current effective thresholds (start at system defaults)
    auto_conf_threshold     NUMERIC(4,3) NOT NULL DEFAULT 0.750,
    auto_risk_threshold     NUMERIC(4,3) NOT NULL DEFAULT 0.300,

    -- Most recent rolling 30-day stats used to compute these thresholds
    execution_success_rate  NUMERIC(5,4),
    sample_size             INT,

    -- Cooldown guard: prevents more than one adjustment per 24h
    last_computed_at        TIMESTAMPTZ,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (org_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_learning_state_org
    ON growth.learning_state(org_id, platform);

-- ── Threshold change audit log (append-only) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS growth.learning_events (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID        NOT NULL
                            REFERENCES public.organizations(id) ON DELETE CASCADE,
    platform                TEXT        NOT NULL,

    old_conf_threshold      NUMERIC(4,3) NOT NULL,
    new_conf_threshold      NUMERIC(4,3) NOT NULL,
    old_risk_threshold      NUMERIC(4,3) NOT NULL,
    new_risk_threshold      NUMERIC(4,3) NOT NULL,

    execution_success_rate  NUMERIC(5,4) NOT NULL,
    sample_size             INT          NOT NULL,

    -- Human-readable reason for this adjustment
    reason                  TEXT         NOT NULL,
    -- 'loosened_due_to_success' | 'tightened_due_to_failures' | 'no_change'

    decided_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_events_org
    ON growth.learning_events(org_id, decided_at DESC);
"""


downgrade_sql = """
DROP TABLE IF EXISTS growth.learning_events   CASCADE;
DROP TABLE IF EXISTS growth.learning_state    CASCADE;
"""


async def upgrade(conn) -> None:
    await conn.execute(upgrade_sql)


async def downgrade(conn) -> None:
    await conn.execute(downgrade_sql)
