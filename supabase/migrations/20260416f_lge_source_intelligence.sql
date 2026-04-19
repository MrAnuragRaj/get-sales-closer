-- LGE Phase 3 — Source Intelligence
-- Stores computed per-org, per-source reliability metrics.
-- Refreshed daily by pg_cron and on-demand via compute_lge_source_stats().

CREATE TABLE IF NOT EXISTS public.lge_source_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source          text NOT NULL,
  total_leads     int  NOT NULL DEFAULT 0,
  pushed          int  NOT NULL DEFAULT 0,
  discarded       int  NOT NULL DEFAULT 0,
  failed          int  NOT NULL DEFAULT 0,
  enriched        int  NOT NULL DEFAULT 0,   -- had at least one provider call succeed
  duplicates      int  NOT NULL DEFAULT 0,
  replied         int  NOT NULL DEFAULT 0,
  booked          int  NOT NULL DEFAULT 0,
  push_rate       numeric(5,2) DEFAULT 0,    -- pushed / total %
  enrich_rate     numeric(5,2) DEFAULT 0,    -- enriched / total %
  reply_rate      numeric(5,2) DEFAULT 0,    -- replied / pushed %
  book_rate       numeric(5,2) DEFAULT 0,    -- booked / pushed %
  reliability     numeric(5,2) DEFAULT 50,   -- 0–100 composite score
  confidence_adj  numeric(5,2) DEFAULT 0,    -- applied nudge to confidence score: -10 to +10
  computed_at     timestamptz DEFAULT now(),
  UNIQUE (org_id, source)
);

ALTER TABLE public.lge_source_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can read source stats"
  ON public.lge_source_stats FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE org_id = lge_source_stats.org_id AND user_id = auth.uid()
    )
  );

-- ── Compute function ──────────────────────────────────────────────────────────
-- Recomputes source stats for one org (or all orgs if p_org_id IS NULL).
-- Returns count of source rows upserted.

CREATE OR REPLACE FUNCTION public.compute_lge_source_stats(p_org_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH raw AS (
    SELECT
      r.org_id,
      coalesce(r.source, 'unknown')                                          AS source,
      COUNT(*)                                                               AS total_leads,
      SUM(CASE WHEN r.status = 'pushed'    THEN 1 ELSE 0 END)               AS pushed,
      SUM(CASE WHEN r.status = 'discarded' THEN 1 ELSE 0 END)               AS discarded,
      SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END)               AS failed,
      -- enriched = had a successful provider call
      COUNT(DISTINCT CASE WHEN pc.status = 'success' THEN r.id END)         AS enriched,
      -- duplicates = leads with same email/phone as another lead in same org+campaign (approx via count - distinct contact)
      (COUNT(*) - COUNT(DISTINCT coalesce(r.email, r.phone, r.id::text)))    AS duplicates,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                     THEN o.raw_lead_id END)                                 AS replied,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('booked','closed')
                     THEN o.raw_lead_id END)                                 AS booked
    FROM lge_raw_leads r
    LEFT JOIN lge_provider_calls pc ON pc.raw_lead_id = r.id
    LEFT JOIN lge_outcomes o        ON o.raw_lead_id  = r.id
    WHERE (p_org_id IS NULL OR r.org_id = p_org_id)
    GROUP BY r.org_id, coalesce(r.source, 'unknown')
  ),
  computed AS (
    SELECT
      org_id,
      source,
      total_leads,
      pushed,
      discarded,
      failed,
      enriched,
      GREATEST(0, duplicates)                                                AS duplicates,
      replied,
      booked,
      -- Rates (%)
      CASE WHEN total_leads > 0
           THEN ROUND(100.0 * pushed    / total_leads, 2) ELSE 0 END        AS push_rate,
      CASE WHEN total_leads > 0
           THEN ROUND(100.0 * enriched  / total_leads, 2) ELSE 0 END        AS enrich_rate,
      CASE WHEN pushed > 0
           THEN ROUND(100.0 * replied   / pushed, 2)      ELSE 0 END        AS reply_rate,
      CASE WHEN pushed > 0
           THEN ROUND(100.0 * booked    / pushed, 2)      ELSE 0 END        AS book_rate,
      -- Reliability score (0–100):
      --   40% weight: push rate (normalised to 0–100, cap at 100%)
      --   30% weight: enrich rate
      --   20% weight: reply rate (normalised, cap at 50% = full credit)
      --   10% weight: low-dupe bonus (0 dupes = full credit; ≥20% dupe rate = 0)
      ROUND(
        LEAST(100,
          0.40 * CASE WHEN total_leads > 0 THEN LEAST(100, 100.0 * pushed / total_leads)    ELSE 50 END +
          0.30 * CASE WHEN total_leads > 0 THEN LEAST(100, 100.0 * enriched / total_leads)  ELSE 50 END +
          0.20 * CASE WHEN pushed > 0      THEN LEAST(100, 200.0 * replied / pushed)         ELSE 50 END +
          0.10 * GREATEST(0, 100 - CASE WHEN total_leads > 0
                                        THEN 500.0 * GREATEST(0, total_leads - COUNT(DISTINCT coalesce(source,'x'))) / total_leads
                                        ELSE 0 END)
        )
      , 2)                                                                   AS reliability
    FROM raw
    -- subquery trick: re-expose duplicates for dupe-rate calc
  )
  INSERT INTO lge_source_stats
    (org_id, source, total_leads, pushed, discarded, failed, enriched, duplicates,
     replied, booked, push_rate, enrich_rate, reply_rate, book_rate, reliability,
     confidence_adj, computed_at)
  SELECT
    c.org_id, c.source, c.total_leads, c.pushed, c.discarded, c.failed, c.enriched,
    -- recompute duplicates cleanly
    (SELECT GREATEST(0, COUNT(*) - COUNT(DISTINCT coalesce(r2.email, r2.phone, r2.id::text)))
     FROM lge_raw_leads r2
     WHERE r2.org_id = c.org_id AND coalesce(r2.source,'unknown') = c.source)    AS duplicates,
    c.replied, c.booked, c.push_rate, c.enrich_rate, c.reply_rate, c.book_rate,
    c.reliability,
    -- confidence_adj: map reliability 0–100 → -10 to +10, anchored at 50 = 0
    ROUND((c.reliability - 50) / 5.0, 2)                                          AS confidence_adj,
    now()
  FROM computed c
  ON CONFLICT (org_id, source) DO UPDATE SET
    total_leads    = EXCLUDED.total_leads,
    pushed         = EXCLUDED.pushed,
    discarded      = EXCLUDED.discarded,
    failed         = EXCLUDED.failed,
    enriched       = EXCLUDED.enriched,
    duplicates     = EXCLUDED.duplicates,
    replied        = EXCLUDED.replied,
    booked         = EXCLUDED.booked,
    push_rate      = EXCLUDED.push_rate,
    enrich_rate    = EXCLUDED.enrich_rate,
    reply_rate     = EXCLUDED.reply_rate,
    book_rate      = EXCLUDED.book_rate,
    reliability    = EXCLUDED.reliability,
    confidence_adj = EXCLUDED.confidence_adj,
    computed_at    = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── RPC for frontend ──────────────────────────────────────────────────────────
-- Returns source stats for an org. Auth-gated.

CREATE OR REPLACE FUNCTION public.get_lge_source_stats(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = p_org_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(row_to_json(s) ORDER BY s.total_leads DESC), '[]'::jsonb)
    FROM lge_source_stats s
    WHERE s.org_id = p_org_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_lge_source_stats(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_lge_source_stats(uuid)     TO authenticated;

-- ── pg_cron job #23 — daily source stat refresh ───────────────────────────────
SELECT cron.schedule(
  'lge_source_stats_daily',
  '0 2 * * *',
  $$ SELECT public.compute_lge_source_stats(NULL); $$
);
