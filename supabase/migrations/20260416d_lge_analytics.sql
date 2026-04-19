-- LGE Phase 1.5 — Score Calibration + Operator Analytics RPC
-- Returns all analytics data in a single call: score distribution, outcomes by tier,
-- campaign performance, and operator decisions (manual approvals from review queue).

CREATE OR REPLACE FUNCTION public.get_lge_analytics(
  p_org_id     uuid,
  p_campaign_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_score_dist  jsonb;
  v_outcomes    jsonb;
  v_campaigns   jsonb;
  v_operator    jsonb;
  v_source_perf jsonb;
BEGIN
  -- Auth guard: caller must be a member of the org
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- ── 1. Score distribution by routing tier ────────────────────────────────
  SELECT jsonb_agg(row_to_json(t) ORDER BY t.tier) INTO v_score_dist FROM (
    SELECT
      CASE
        WHEN s.total_score >= 80 THEN 'auto_push'
        WHEN s.total_score >= 60 THEN 'review'
        ELSE                          'discard'
      END                                    AS tier,
      COUNT(*)                               AS total,
      ROUND(AVG(s.total_score)::numeric, 1)  AS avg_score,
      ROUND(AVG(s.fit_score)::numeric, 1)    AS avg_fit,
      ROUND(AVG(s.confidence_score)::numeric, 1) AS avg_confidence,
      SUM(CASE WHEN r.status = 'pushed'       THEN 1 ELSE 0 END) AS pushed,
      SUM(CASE WHEN r.status = 'review_queue' THEN 1 ELSE 0 END) AS in_review,
      SUM(CASE WHEN r.status = 'discarded'    THEN 1 ELSE 0 END) AS discarded,
      SUM(CASE WHEN r.status = 'failed'       THEN 1 ELSE 0 END) AS failed
    FROM lge_raw_leads r
    JOIN lge_scores s ON s.raw_lead_id = r.id
    WHERE r.org_id = p_org_id
      AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
    GROUP BY tier
  ) t;

  -- ── 2. Outcomes by score tier (for pushed leads only) ────────────────────
  SELECT jsonb_agg(row_to_json(t)) INTO v_outcomes FROM (
    SELECT
      CASE
        WHEN s.total_score >= 80 THEN 'auto_push'
        WHEN s.total_score >= 60 THEN 'review'
        ELSE                          'discard'
      END                                                            AS tier,
      COUNT(DISTINCT r.id)                                           AS pushed_count,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                     THEN o.raw_lead_id END)                         AS replied,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('booked','closed')
                     THEN o.raw_lead_id END)                         AS booked,
      COUNT(DISTINCT CASE WHEN o.outcome_stage = 'closed'
                     THEN o.raw_lead_id END)                         AS closed
    FROM lge_raw_leads r
    JOIN lge_scores s ON s.raw_lead_id = r.id
    LEFT JOIN lge_outcomes o ON o.raw_lead_id = r.id
    WHERE r.org_id = p_org_id
      AND r.status = 'pushed'
      AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
    GROUP BY tier
  ) t;

  -- ── 3. Campaign performance ───────────────────────────────────────────────
  SELECT jsonb_agg(row_to_json(t)) INTO v_campaigns FROM (
    SELECT
      c.id                                                                AS campaign_id,
      c.name                                                              AS campaign_name,
      c.status                                                            AS campaign_status,
      COUNT(r.id)                                                         AS total,
      SUM(CASE WHEN r.status = 'pushed'       THEN 1 ELSE 0 END)         AS pushed,
      SUM(CASE WHEN r.status = 'review_queue' THEN 1 ELSE 0 END)         AS in_review,
      SUM(CASE WHEN r.status = 'discarded'    THEN 1 ELSE 0 END)         AS discarded,
      SUM(CASE WHEN r.status = 'pending' OR r.status = 'enriching'
               THEN 1 ELSE 0 END)                                        AS pending,
      SUM(CASE WHEN r.status = 'failed'       THEN 1 ELSE 0 END)         AS failed,
      ROUND(AVG(s.total_score)::numeric, 1)                              AS avg_score,
      ROUND(AVG(s.fit_score)::numeric, 1)                                AS avg_fit,
      ROUND(AVG(s.confidence_score)::numeric, 1)                         AS avg_confidence,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                     THEN o.raw_lead_id END)                             AS replied,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('booked','closed')
                     THEN o.raw_lead_id END)                             AS booked
    FROM lge_campaigns c
    LEFT JOIN lge_raw_leads r   ON r.campaign_id = c.id AND r.org_id = p_org_id
    LEFT JOIN lge_scores s      ON s.raw_lead_id = r.id
    LEFT JOIN lge_outcomes o    ON o.raw_lead_id = r.id
    WHERE c.org_id = p_org_id
      AND (p_campaign_id IS NULL OR c.id = p_campaign_id)
    GROUP BY c.id, c.name, c.status
    ORDER BY COUNT(r.id) DESC
  ) t;

  -- ── 4. Operator decisions (leads that were in review band) ────────────────
  -- "review band" = scored 60–79 (would have been routed to review_queue)
  -- manually_pushed = operator clicked force_push → status=pushed, gsc_handoff_key set
  -- auto_pushed     = scored ≥80, pushed directly by the worker
  -- discarded       = operator clicked discard
  -- still_pending   = sitting in review_queue waiting for action
  SELECT jsonb_build_object(
    'total_review_band',
      COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80),
    'manually_pushed',
      COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                         AND r.status = 'pushed' AND r.gsc_handoff_key IS NOT NULL),
    'operator_discarded',
      COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                         AND r.status = 'discarded'),
    'still_in_review',
      COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                         AND r.status = 'review_queue'),
    'approval_rate_pct',
      CASE WHEN COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                                   AND r.status IN ('pushed','discarded')) = 0
           THEN 0
           ELSE ROUND(
             100.0 * COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                                        AND r.status = 'pushed') /
             NULLIF(COUNT(*) FILTER (WHERE s.total_score >= 60 AND s.total_score < 80
                                      AND r.status IN ('pushed','discarded')), 0)
           , 1)
      END,
    'false_push_candidates',
      -- auto-pushed leads (score ≥80) that got no_reply outcome
      COUNT(*) FILTER (WHERE s.total_score >= 80
                         AND r.status = 'pushed'
                         AND o.outcome_stage = 'no_reply')
  ) INTO v_operator
  FROM lge_raw_leads r
  JOIN lge_scores s ON s.raw_lead_id = r.id
  LEFT JOIN lge_outcomes o ON o.raw_lead_id = r.id
  WHERE r.org_id = p_org_id
    AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id);

  -- ── 5. Source performance ─────────────────────────────────────────────────
  SELECT jsonb_agg(row_to_json(t)) INTO v_source_perf FROM (
    SELECT
      coalesce(r.source, 'unknown')                   AS source,
      COUNT(*)                                        AS total,
      ROUND(AVG(s.total_score)::numeric, 1)           AS avg_score,
      SUM(CASE WHEN r.status = 'pushed'    THEN 1 ELSE 0 END) AS pushed,
      SUM(CASE WHEN r.status = 'discarded' THEN 1 ELSE 0 END) AS discarded,
      SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END) AS failed,
      COUNT(DISTINCT CASE WHEN o.outcome_stage IN ('replied','booked','closed')
                     THEN o.raw_lead_id END)          AS replied
    FROM lge_raw_leads r
    LEFT JOIN lge_scores s   ON s.raw_lead_id = r.id
    LEFT JOIN lge_outcomes o ON o.raw_lead_id = r.id
    WHERE r.org_id = p_org_id
      AND (p_campaign_id IS NULL OR r.campaign_id = p_campaign_id)
    GROUP BY r.source
    ORDER BY COUNT(*) DESC
  ) t;

  RETURN jsonb_build_object(
    'score_distribution',  coalesce(v_score_dist,  '[]'::jsonb),
    'outcomes_by_tier',    coalesce(v_outcomes,     '[]'::jsonb),
    'campaign_performance', coalesce(v_campaigns,   '[]'::jsonb),
    'operator_decisions',  coalesce(v_operator,     '{}'::jsonb),
    'source_performance',  coalesce(v_source_perf,  '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_lge_analytics(uuid, uuid) TO authenticated;
