-- LGE Phase 7: Operator Ergonomics + Pipeline Hygiene
-- 1. Per-campaign review queue TTL
-- 2. Threshold change versioning
-- 3. Re-process job tracking
-- 4. Auto-discard stale reviews (pg_cron)

-- ── 1. Review TTL ─────────────────────────────────────────────────────────────
ALTER TABLE public.lge_campaigns
  ADD COLUMN IF NOT EXISTS review_ttl_days integer NOT NULL DEFAULT 10;

-- ── 2. Threshold History ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_threshold_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  org_id         uuid        NOT NULL,
  changed_by     uuid        NOT NULL,
  old_auto_push  integer,
  new_auto_push  integer,
  old_review     integer,
  new_review     integer,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lge_threshold_history_campaign
  ON public.lge_threshold_history(campaign_id, created_at DESC);

-- ── 3. Re-process Jobs ────────────────────────────────────────────────────────
-- Tracks every bulk re-process operation for auditability and idempotency.
-- mode: score_only = keep enrichment, re-score inline
--        full      = clear enrichment, reset to pending (worker re-enriches)
CREATE TABLE IF NOT EXISTS public.lge_reprocess_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL,
  campaign_id     uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  mode            text        NOT NULL DEFAULT 'score_only'
                                CHECK (mode IN ('score_only', 'full')),
  lead_ids        uuid[]      NOT NULL,     -- snapshot of targeted lead IDs at job creation
  lead_count      integer     NOT NULL,
  status          text        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'done', 'failed')),
  processed_count integer     NOT NULL DEFAULT 0,
  pushed_count    integer     NOT NULL DEFAULT 0,  -- leads that auto-pushed as a result
  initiated_by    uuid        NOT NULL,
  reason          text,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lge_reprocess_jobs_campaign
  ON public.lge_reprocess_jobs(campaign_id, created_at DESC);

-- ── 4. Auto-Discard Function ─────────────────────────────────────────────────
-- Moves stale review_queue leads to discarded based on per-campaign TTL.
-- Returns row count for logging.
CREATE OR REPLACE FUNCTION public.lge_auto_discard_stale_reviews()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0;
BEGIN
  UPDATE public.lge_raw_leads rl
  SET    status = 'discarded',
         updated_at = now()
  FROM   public.lge_campaigns c
  WHERE  rl.campaign_id = c.id
    AND  rl.status = 'review_queue'
    AND  c.review_ttl_days IS NOT NULL
    AND  now() - rl.updated_at > (c.review_ttl_days || ' days')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── 5. pg_cron #24 ───────────────────────────────────────────────────────────
SELECT cron.schedule(
  'lge_auto_discard_stale_reviews',
  '30 3 * * *',  -- daily 03:30 UTC (offset from other crons)
  'SELECT public.lge_auto_discard_stale_reviews();'
) WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'lge_auto_discard_stale_reviews'
);
