-- ============================================================
-- Session 28: Revenue Health + Revenue Doctor — DB Schema
-- Run in Supabase SQL Editor (service role / postgres)
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- TABLE 1: revenue_health_snapshots
-- Cached, materialized health scores per org / window / date.
-- Refreshed by pg_cron every 4 hours (job #18).
-- Served cold by the revenue-health edge function (<100ms).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_health_snapshots (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  window_type      TEXT        NOT NULL CHECK (window_type IN ('daily','weekly','monthly')),
  reference_date   DATE        NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  overall_score    NUMERIC(5,2),
  category_scores  JSONB       NOT NULL DEFAULT '{}',
  raw_metrics      JSONB       NOT NULL DEFAULT '{}',
  warnings         JSONB       NOT NULL DEFAULT '[]',
  data_confidence  TEXT        NOT NULL DEFAULT 'sufficient'
                               CHECK (data_confidence IN ('sufficient','partial','insufficient')),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One canonical snapshot per org / window / reference date.
  -- On refresh, the row is upserted (computed_at updated).
  UNIQUE (org_id, window_type, reference_date)
);

-- Fast lookup: org dashboard load, most-recent weekly/monthly snapshot
CREATE INDEX IF NOT EXISTS rhs_org_window_computed_idx
  ON revenue_health_snapshots (org_id, window_type, computed_at DESC);

-- ─────────────────────────────────────────────────────────────
-- TABLE 2: revenue_doctor_reports
-- Persisted LLM diagnostic reports. One row per generation.
-- Multiple reports may exist for the same org / window / period
-- (each "Generate New Report" produces a new row).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revenue_doctor_reports (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  window_type        TEXT        NOT NULL CHECK (window_type IN ('daily','weekly','monthly')),
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,

  -- Full audit inputs — never overwritten after insert
  health_snapshot    JSONB       NOT NULL DEFAULT '{}',  -- category scores at generation time
  diagnostic_payload JSONB       NOT NULL DEFAULT '{}',  -- full input sent to LLM (audit trail)

  -- LLM output — structured for UI rendering
  report_content     JSONB       NOT NULL DEFAULT '{}',

  -- Denormalized for fast list view
  executive_summary  TEXT,
  overall_score      NUMERIC(5,2),

  -- Cost tracking
  model_used         TEXT        NOT NULL DEFAULT 'gpt-4o',
  input_token_count  INTEGER,
  output_token_count INTEGER,

  generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Fast lookup: org report history, most-recent first
CREATE INDEX IF NOT EXISTS rdr_org_generated_idx
  ON revenue_doctor_reports (org_id, generated_at DESC);

-- ─────────────────────────────────────────────────────────────
-- TABLE 3: doctor_report_metrics
-- Flat metric values captured at report generation time.
-- Enables future cross-report trend analytics without re-parsing JSONB.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_report_metrics (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id        UUID        NOT NULL REFERENCES revenue_doctor_reports(id) ON DELETE CASCADE,
  org_id           UUID        NOT NULL,
  window_type      TEXT        NOT NULL,
  reference_date   DATE        NOT NULL,
  metric_category  TEXT        NOT NULL,  -- lead_response | conversation_quality | channel_health | conversion_health
  metric_key       TEXT        NOT NULL,  -- e.g. avg_response_minutes, reply_rate_pct
  metric_value     NUMERIC,
  metric_metadata  JSONB       NOT NULL DEFAULT '{}',
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drm_org_category_idx
  ON doctor_report_metrics (org_id, metric_category, recorded_at DESC);

CREATE INDEX IF NOT EXISTS drm_report_idx
  ON doctor_report_metrics (report_id);

-- ─────────────────────────────────────────────────────────────
-- RLS — Org members can read their org's data only.
-- All writes go through edge functions using service role.
-- No client-side INSERT / UPDATE / DELETE permitted.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE revenue_health_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_doctor_reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_report_metrics     ENABLE ROW LEVEL SECURITY;

-- DROP existing policies idempotently before recreating
DROP POLICY IF EXISTS "rhs_select_org_member"  ON revenue_health_snapshots;
DROP POLICY IF EXISTS "rdr_select_org_member"  ON revenue_doctor_reports;
DROP POLICY IF EXISTS "drm_select_org_member"  ON doctor_report_metrics;

CREATE POLICY "rhs_select_org_member"
  ON revenue_health_snapshots FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "rdr_select_org_member"
  ON revenue_doctor_reports FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "drm_select_org_member"
  ON doctor_report_metrics FOR SELECT
  USING (is_org_member(org_id));

-- ─────────────────────────────────────────────────────────────
-- CREDIT WALLETS — doctor_report token key
--
-- v1 COMMERCIAL MAPPING (temporary — do not treat as final):
--   org_type='enterprise' + active voice  →  999  (effectively unlimited)
--   any other org_type   + active voice  →   10  (Voice/non-enterprise tier)
--   no active voice (Sentinel-only)      →    0  (Health only; no Doctor)
--
-- When Starter/Pro/Enterprise plan_tier is introduced (v2), update this
-- INSERT and refresh_doctor_report_credits() to read plan_tier instead.
-- Seed all existing orgs. Future orgs handled by the refresh function.
-- ─────────────────────────────────────────────────────────────
INSERT INTO credit_wallets (org_id, token_key, available_balance)
SELECT
  o.id                                               AS org_id,
  'doctor_report'                                    AS token_key,
  CASE
    WHEN o.org_type = 'enterprise'
      AND EXISTS (
        SELECT 1 FROM org_services os
        WHERE os.org_id = o.id
          AND os.service_key = 'voice'
          AND os.status = 'active'
      ) THEN 999
    WHEN EXISTS (
      SELECT 1 FROM org_services os
      WHERE os.org_id = o.id
        AND os.service_key = 'voice'
        AND os.status = 'active'
    ) THEN 10
    ELSE 0
  END                                                AS available_balance
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM credit_wallets cw
  WHERE cw.org_id = o.id
    AND cw.token_key = 'doctor_report'
)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- FUNCTION: refresh_doctor_report_credits()
--
-- Called by pg_cron on the 1st of each month at 00:05 UTC.
-- Resets each org's doctor_report wallet to its plan allotment.
-- Does NOT carry over unused credits (monthly allotment, not accruing).
-- Idempotent: skips if a credit_ledger row for this month already exists.
-- Writes a credit_ledger entry for full audit trail.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_doctor_report_credits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  r              RECORD;
  allotment      INTEGER;
  period_key     TEXT;
BEGIN
  -- YYYY-MM suffix used as idempotency key suffix
  period_key := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');

  FOR r IN
    SELECT
      o.id       AS org_id,
      o.org_type,
      CASE
        WHEN o.org_type = 'enterprise'
          AND EXISTS (
            SELECT 1 FROM org_services os
            WHERE os.org_id = o.id
              AND os.service_key = 'voice'
              AND os.status = 'active'
          ) THEN 999
        WHEN EXISTS (
          SELECT 1 FROM org_services os
          WHERE os.org_id = o.id
            AND os.service_key = 'voice'
            AND os.status = 'active'
        ) THEN 10
        ELSE 0
      END        AS monthly_allotment
    FROM organizations o
    -- Skip orgs that are fully cancelled (immediate) or past end-of-term
    WHERE o.cancellation_status IS DISTINCT FROM 'cancelled_immediate'
      AND (
        o.cancellation_status IS NULL
        OR o.cancellation_status = 'cancelled_end_of_term'
           AND (o.service_ends_at IS NULL OR o.service_ends_at > NOW())
      )
  LOOP
    allotment := r.monthly_allotment;

    -- Sentinel-only orgs get no allotment — skip
    CONTINUE WHEN allotment = 0;

    -- Idempotency: skip if already refreshed this month
    IF EXISTS (
      SELECT 1 FROM credit_ledger cl
      WHERE cl.org_id           = r.org_id
        AND cl.token_key         = 'doctor_report'
        AND cl.source_object_type = 'monthly_refresh'
        AND cl.source_object_id   = period_key
    ) THEN
      CONTINUE;
    END IF;

    -- Ensure wallet row exists (for orgs created mid-month)
    INSERT INTO credit_wallets (org_id, token_key, available_balance)
    VALUES (r.org_id, 'doctor_report', 0)
    ON CONFLICT (org_id, token_key) DO NOTHING;

    -- Reset to monthly allotment (no carry-over)
    UPDATE credit_wallets
    SET available_balance = allotment
    WHERE org_id   = r.org_id
      AND token_key = 'doctor_report';

    -- Audit trail
    INSERT INTO credit_ledger (
      org_id,
      token_key,
      direction,
      amount,
      source_object_type,
      source_object_id,
      note,
      idempotency_key
    ) VALUES (
      r.org_id,
      'doctor_report',
      'credit',
      allotment,
      'monthly_refresh',
      period_key,
      'Monthly Revenue Doctor allotment reset: ' || allotment || ' report(s)',
      'dr_monthly_refresh_' || r.org_id || '_' || period_key
    );
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- pg_cron Job #17: monthly doctor_report credit refresh
-- Runs on 1st of each month at 00:05 UTC
-- Actual jobid assigned by pg_cron at deploy time: 17
-- ─────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'doctor-report-monthly-refresh',   -- job name (unique)
  '5 0 1 * *',                        -- cron: 1st of every month, 00:05 UTC
  'SELECT refresh_doctor_report_credits();'
);

-- ─────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (run after migration to confirm)
-- ─────────────────────────────────────────────────────────────
-- SELECT count(*) FROM revenue_health_snapshots;   -- expect 0
-- SELECT count(*) FROM revenue_doctor_reports;     -- expect 0
-- SELECT count(*) FROM doctor_report_metrics;      -- expect 0
-- SELECT count(*) FROM credit_wallets WHERE token_key = 'doctor_report';  -- expect N orgs
-- SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'doctor-report-monthly-refresh';
