"""
Migration 010 — Decision Attribution table.

Creates growth.decision_attributions to record every autonomous decision
the system makes, with enough context to explain "why".

Decision types:
  engagement_scored   — LLM scored an opportunity (scoring_worker)
  engagement_executed — System dispatched a platform action (executor)
  content_generated   — Pipeline completed a content variant (content_pipeline)

Indexes:
  idx_da_org_subject  — fast per-org lookup by subject (opportunity or variant)
  idx_da_org_type     — fast per-org listing by decision type + time

Down: drops the table and indexes (CASCADE handles the rest).
"""

revision:    str = "010"
down_revision    = "009"


upgrade_sql = """
-- ── Decision Attribution table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS growth.decision_attributions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID        NOT NULL
                    REFERENCES public.organizations(id) ON DELETE CASCADE,

    -- Which type of autonomous decision this records
    decision_type   TEXT        NOT NULL
                    CHECK (decision_type IN (
                        'engagement_scored',
                        'engagement_executed',
                        'content_generated'
                    )),

    -- The entity this decision was made about
    subject_id      UUID        NOT NULL,   -- opp_id or variant_id
    subject_type    TEXT        NOT NULL    -- 'opportunity' | 'variant'
                    CHECK (subject_type IN ('opportunity', 'variant')),

    -- Machine-readable decision context: scores, flags, model inputs at decision time
    feature_vector  JSONB,

    -- The policy path taken: e.g. 'auto_approved', 'pending_review', 'cap_blocked'
    policy          TEXT,

    -- Terminal outcome: e.g. 'success', 'failed', 'approved', 'rejected'
    outcome         TEXT,

    -- Human-readable explanation: e.g. 'confidence 0.84 and risk 0.12 met auto-safe threshold'
    decision_reason TEXT,

    -- LLM model used for this decision (NULL for non-LLM decisions)
    model_version   TEXT,

    decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-safe subject lookup (primary query pattern: given an opp_id, fetch attributions)
CREATE INDEX IF NOT EXISTS idx_da_org_subject
    ON growth.decision_attributions(org_id, subject_type, subject_id, decided_at DESC);

-- Per-org listing by decision type + time (admin/analytics queries)
CREATE INDEX IF NOT EXISTS idx_da_org_type
    ON growth.decision_attributions(org_id, decision_type, decided_at DESC);
"""


downgrade_sql = """
DROP TABLE IF EXISTS growth.decision_attributions CASCADE;
"""


async def upgrade(conn) -> None:
    await conn.execute(upgrade_sql)


async def downgrade(conn) -> None:
    await conn.execute(downgrade_sql)
