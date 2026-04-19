-- Migration: LGE Worker RPCs + pg_cron jobs
-- Session: LGE Session 2
-- Purpose:
--   lge_claim_batch         — atomically claims pending leads for a worker
--   lge_release_stale_locks — resets enriching leads with expired locks back to pending
--   pg_cron job #18         — lge_release_stale_locks every 5 min (pure SQL)
--   pg_cron job #19         — lge_worker edge function every 2 min (HTTP)

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: lge_claim_batch
-- Claims up to p_batch_size pending leads from active/shadow campaigns.
-- Atomically marks them enriching + sets locked_by/locked_until + increments attempt.
-- Returns full lead + campaign context needed by the worker.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lge_claim_batch(
    p_worker_id    TEXT,
    p_batch_size   INT DEFAULT 10,
    p_lock_minutes INT DEFAULT 5
)
RETURNS TABLE(
    lead_id       UUID,
    campaign_id   UUID,
    org_id        UUID,
    lead_name     TEXT,
    lead_email    TEXT,
    lead_phone    TEXT,
    lead_company  TEXT,
    raw_data      JSONB,
    attempt       INT,
    max_attempts  INT,
    campaign_mode TEXT,
    icp_config    JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH claimed AS (
        SELECT rl.id
        FROM lge_raw_leads rl
        WHERE rl.status IN ('pending', 'enriching')
          AND rl.attempt < rl.max_attempts
          AND (rl.locked_until IS NULL OR rl.locked_until < now())
          AND EXISTS (
              SELECT 1 FROM lge_campaigns c
              WHERE c.id = rl.campaign_id
                AND c.mode IN ('shadow', 'active')
                AND c.status != 'archived'
          )
        ORDER BY rl.created_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ),
    updated AS (
        UPDATE lge_raw_leads rl
        SET locked_by    = p_worker_id,
            locked_until = now() + (p_lock_minutes || ' minutes')::INTERVAL,
            status       = 'enriching',
            attempt      = rl.attempt + 1
        WHERE rl.id IN (SELECT id FROM claimed)
        RETURNING rl.id, rl.campaign_id, rl.org_id, rl.name, rl.email,
                  rl.phone, rl.company, rl.raw_data, rl.attempt, rl.max_attempts
    )
    SELECT
        u.id            AS lead_id,
        u.campaign_id,
        u.org_id,
        u.name          AS lead_name,
        u.email         AS lead_email,
        u.phone         AS lead_phone,
        u.company       AS lead_company,
        u.raw_data,
        u.attempt,
        u.max_attempts,
        c.mode          AS campaign_mode,
        c.icp_config
    FROM updated u
    JOIN lge_campaigns c ON c.id = u.campaign_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: lge_release_stale_locks
-- Resets leads stuck in 'enriching' with expired locks back to 'pending'.
-- Called by pg_cron every 5 minutes as a safety net for crashed workers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lge_release_stale_locks()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE lge_raw_leads
    SET status       = 'pending',
        locked_by    = NULL,
        locked_until = NULL
    WHERE status       = 'enriching'
      AND locked_until < now()
      AND attempt      < max_attempts;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron job #18: lge_release_stale_locks — every 5 min, pure SQL
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
    'lge-release-stale-locks',
    '*/5 * * * *',
    $$SELECT public.lge_release_stale_locks()$$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron job #19: lge_worker — every 2 min, HTTP to edge function
-- lge_worker is deployed with --no-verify-jwt; anon key is the API gateway key.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
    'lge-worker',
    '*/2 * * * *',
    $$
    SELECT net.http_post(
        url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_worker',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8'
        ),
        body    := jsonb_build_object('trigger', 'pg_cron')
    ) AS request_id;
    $$
);
