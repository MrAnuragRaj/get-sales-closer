-- LGE Phase 4 — Controlled Signal Expansion
-- Adds source recency tracking to lge_source_stats.
-- The recency_adj feeds into the total confidence_adj applied by the worker.

ALTER TABLE public.lge_source_stats
  ADD COLUMN IF NOT EXISTS last_upload_at  timestamptz,
  ADD COLUMN IF NOT EXISTS recency_adj     numeric(5,2) DEFAULT 0;

-- Redefine compute function to include recency
CREATE OR REPLACE FUNCTION public.compute_lge_source_stats(p_org_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
BEGIN
  INSERT INTO lge_source_stats (
    org_id, source, total_leads, pushed, discarded, failed, enriched, duplicates,
    replied, booked, push_rate, enrich_rate, reply_rate, book_rate,
    reliability, confidence_adj, last_upload_at, recency_adj, computed_at
  )
  SELECT
    r.org_id,
    coalesce(r.source, 'unknown')                                                AS source,
    COUNT(*)                                                                     AS total_leads,
    SUM(CASE WHEN r.status = 'pushed'    THEN 1 ELSE 0 END)                      AS pushed,
    SUM(CASE WHEN r.status = 'discarded' THEN 1 ELSE 0 END)                      AS discarded,
    SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END)                      AS failed,
    COUNT(DISTINCT CASE WHEN pc.status = 'success' THEN r.id END)                AS enriched,
    GREATEST(0, COUNT(*) - COUNT(DISTINCT coalesce(r.email, r.phone, r.id::text))) AS duplicates,
    COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                   THEN o.raw_lead_id END)                                       AS replied,
    COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('booked','closed')
                   THEN o.raw_lead_id END)                                       AS booked,
    -- Rates
    CASE WHEN COUNT(*) > 0
         THEN ROUND(100.0 * SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) / COUNT(*), 2)
         ELSE 0 END                                                              AS push_rate,
    CASE WHEN COUNT(*) > 0
         THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN pc.status='success' THEN r.id END) / COUNT(*), 2)
         ELSE 0 END                                                              AS enrich_rate,
    CASE WHEN SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) > 0
         THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                              THEN o.raw_lead_id END)
                  / SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END), 2)
         ELSE 0 END                                                              AS reply_rate,
    CASE WHEN SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) > 0
         THEN ROUND(100.0 * COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('booked','closed')
                              THEN o.raw_lead_id END)
                  / SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END), 2)
         ELSE 0 END                                                              AS book_rate,
    -- Reliability: 40% push + 30% enrich + 20% reply + 10% low-dupe
    ROUND(LEAST(100,
      0.40 * CASE WHEN COUNT(*) > 0
                  THEN LEAST(100, 100.0 * SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) / COUNT(*))
                  ELSE 50 END +
      0.30 * CASE WHEN COUNT(*) > 0
                  THEN LEAST(100, 100.0 * COUNT(DISTINCT CASE WHEN pc.status='success' THEN r.id END) / COUNT(*))
                  ELSE 50 END +
      0.20 * CASE WHEN SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) > 0
                  THEN LEAST(100, 200.0 * COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                                          THEN o.raw_lead_id END)
                                / SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END))
                  ELSE 50 END +
      0.10 * 100
    ), 2)                                                                        AS reliability,
    -- confidence_adj: reliability nudge (-10 to +10)
    ROUND((LEAST(100,
      0.40 * CASE WHEN COUNT(*) > 0
                  THEN LEAST(100, 100.0 * SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) / COUNT(*))
                  ELSE 50 END +
      0.30 * CASE WHEN COUNT(*) > 0
                  THEN LEAST(100, 100.0 * COUNT(DISTINCT CASE WHEN pc.status='success' THEN r.id END) / COUNT(*))
                  ELSE 50 END +
      0.20 * CASE WHEN SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END) > 0
                  THEN LEAST(100, 200.0 * COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                                          THEN o.raw_lead_id END)
                                / SUM(CASE WHEN r.status='pushed' THEN 1 ELSE 0 END))
                  ELSE 50 END +
      0.10 * 100
    ) - 50) / 5.0, 2)                                                           AS confidence_adj,
    -- Recency: most recent lead created_at for this source
    MAX(r.created_at)                                                            AS last_upload_at,
    -- Recency adjustment: fresh source = small boost, stale = penalty
    CASE
      WHEN MAX(r.created_at) > now() - INTERVAL '7 days'   THEN  3
      WHEN MAX(r.created_at) > now() - INTERVAL '30 days'  THEN  0
      WHEN MAX(r.created_at) > now() - INTERVAL '90 days'  THEN -2
      ELSE -5
    END                                                                          AS recency_adj,
    now()
  FROM lge_raw_leads r
  LEFT JOIN lge_provider_calls pc ON pc.raw_lead_id = r.id
  LEFT JOIN lge_outcomes o        ON o.raw_lead_id  = r.id
  WHERE (p_org_id IS NULL OR r.org_id = p_org_id)
  GROUP BY r.org_id, coalesce(r.source, 'unknown')
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
    last_upload_at = EXCLUDED.last_upload_at,
    recency_adj    = EXCLUDED.recency_adj,
    computed_at    = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
