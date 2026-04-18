-- LGE Phase 11: Score Calibration Analytics — Performance Indexes
-- These support the get_calibration handler in lge_campaign_manage without adding new tables.

-- Index on total_score for band distribution queries
CREATE INDEX IF NOT EXISTS idx_lge_scores_total_score
  ON public.lge_scores(raw_lead_id, total_score);

-- Index on outcome_stage for false-push / false-reject detection
CREATE INDEX IF NOT EXISTS idx_lge_outcomes_outcome_stage
  ON public.lge_outcomes(raw_lead_id, outcome_stage);

-- Index on source for source-aware calibration (used in lge_ingest / future source analytics)
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_source
  ON public.lge_raw_leads(org_id, source)
  WHERE source IS NOT NULL;

-- Index on is_manual_override for override analytics
CREATE INDEX IF NOT EXISTS idx_lge_scores_manual_override
  ON public.lge_scores(raw_lead_id, is_manual_override)
  WHERE is_manual_override = true;
