-- ============================================================
-- Sprint A Validation Patch
-- Fix 1: get_crm_churn_review   — cr.role_name → cr.name
-- Fix 2: get_crm_contact_state_at — remove non-existent
--        psh.churn_score_delta from crm_predictive_score_history
-- Fix 3: get_crm_customer_journey — ml.created_at → ml.merged_at
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- FIX 1: get_crm_churn_review — role column name
-- crm_roles.name (not role_name)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_crm_churn_review(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result          JSONB;
  v_caller_roles    TEXT[];
  v_caller_is_exec  BOOLEAN;
BEGIN
  -- Determine caller's role set for escalation visibility filtering
  SELECT COALESCE(ARRAY_AGG(cr.name), '{}')
  INTO v_caller_roles
  FROM crm_user_roles cur
  JOIN crm_roles cr ON cr.id = cur.role_id
  WHERE cur.org_id = p_org_id AND cur.user_id = auth.uid();

  v_caller_is_exec := v_caller_roles && ARRAY['founder','executive'];

  SELECT jsonb_build_object(
    'generated_at', now(),
    'high_churn_contacts', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'contact_id',        c.id,
        'name',              c.name,
        'company',           c.company,
        'churn_probability', COALESCE(cps.churn_probability, 0),
        'trajectory_acceleration', c.trajectory_acceleration,
        'trajectory_narrative',    c.trajectory_narrative,
        'days_silent',       EXTRACT(DAY FROM now() - c.last_meaningful_interaction_at)::INT,
        'trust_state',       c.trust_state,
        'maintenance_burden', c.maintenance_burden,
        'capital_velocity',  c.capital_velocity,
        'open_escalations', (
          SELECT COUNT(*) FROM public.crm_escalations e
          WHERE e.contact_id = c.id AND e.org_id = p_org_id
            AND e.execution_state NOT IN ('resolved','dismissed')
            AND (
              e.visibility_scope = 'org'
              OR (e.visibility_scope = 'leadership' AND v_caller_roles && ARRAY['founder','executive','manager'])
              OR (e.visibility_scope = 'owner_chain' AND e.assigned_to = auth.uid())
              OR (e.visibility_scope = 'executive_only' AND v_caller_is_exec)
            )
        ),
        'recent_drift', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'signal', d.signal_name, 'direction', d.direction,
            'severity', d.severity, 'delta', d.delta
          ) ORDER BY d.detected_date DESC), '[]'::JSONB)
          FROM public.crm_signal_drift_events d
          WHERE d.contact_id = c.id AND d.org_id = p_org_id AND d.detected_date >= CURRENT_DATE - 14
        ),
        'recoverability', CASE
          WHEN c.trust_state = 'broken'
               AND COALESCE(cps.churn_probability, 0) >= 80
               AND COALESCE(c.capital_velocity, 0) <= 0
               AND COALESCE(c.resilience_index, 100) < 40
            THEN 'terminal'
          WHEN c.trust_state = 'broken'
               AND COALESCE(cps.churn_probability, 0) >= 60
               AND c.trajectory_acceleration IN ('collapsing','deteriorating')
            THEN 'structurally_broken'
          WHEN (
            SELECT COUNT(*) FROM public.crm_escalations e
            WHERE e.contact_id = c.id AND e.org_id = p_org_id
              AND e.priority IN ('critical','high')
              AND e.execution_state NOT IN ('resolved','dismissed')
              AND (
                e.visibility_scope = 'org'
                OR (e.visibility_scope = 'leadership' AND v_caller_roles && ARRAY['founder','executive','manager'])
                OR (e.visibility_scope = 'owner_chain' AND e.assigned_to = auth.uid())
                OR (e.visibility_scope = 'executive_only' AND v_caller_is_exec)
              )
          ) > 0
               AND COALESCE(cps.churn_probability, 0) >= 60
            THEN 'escalation_dependent'
          WHEN COALESCE(cps.churn_probability, 0) >= 60
               AND COALESCE(c.capital_velocity, 0) < 0
               AND COALESCE(c.resilience_index, 100) < 50
            THEN 'fragile'
          ELSE 'recoverable'
        END,
        'recoverability_confidence', CASE
          WHEN cps.churn_probability IS NULL OR COALESCE(c.identity_confidence, 0) < 40 THEN 'sparse'
          WHEN COALESCE(c.identity_confidence, 0) < 65
               OR NOT EXISTS (SELECT 1 FROM public.crm_relationship_snapshots rs WHERE rs.contact_id = c.id LIMIT 1)
            THEN 'moderate'
          ELSE 'confident'
        END,
        'primary_recovery_driver', CASE
          WHEN (
            SELECT COUNT(*) FROM public.crm_escalations e
            WHERE e.contact_id = c.id AND e.org_id = p_org_id
              AND e.priority IN ('critical','high')
              AND e.execution_state NOT IN ('resolved','dismissed')
              AND (
                e.visibility_scope = 'org'
                OR (e.visibility_scope = 'leadership' AND v_caller_roles && ARRAY['founder','executive','manager'])
                OR (e.visibility_scope = 'owner_chain' AND e.assigned_to = auth.uid())
                OR (e.visibility_scope = 'executive_only' AND v_caller_is_exec)
              )
          ) > 0
            THEN 'active_escalation'
          WHEN COALESCE(c.capital_velocity, 0) > 5
            THEN 'rising_capital'
          WHEN c.reciprocity_trend = 'improving'
            THEN 'improving_reciprocity'
          WHEN COALESCE(c.loyalty_score, 0) >= 60
            THEN 'loyal_history'
          WHEN COALESCE(c.resilience_index, 0) >= 65
            THEN 'resilient_account'
          WHEN EXISTS (
            SELECT 1 FROM public.crm_contact_roles cr
            WHERE cr.contact_id = c.id AND cr.role = 'executive_sponsor'
          )
            THEN 'executive_sponsor_stability'
          ELSE NULL
        END,
        'recovery_blocker', CASE
          WHEN c.trust_state = 'broken'
            THEN 'trust_fracture'
          WHEN (
            SELECT COUNT(*) FROM public.crm_escalations e
            WHERE e.contact_id = c.id AND e.org_id = p_org_id
              AND e.priority IN ('critical','high')
              AND e.execution_state NOT IN ('resolved','dismissed')
              AND (
                e.visibility_scope = 'org'
                OR (e.visibility_scope = 'leadership' AND v_caller_roles && ARRAY['founder','executive','manager'])
                OR (e.visibility_scope = 'owner_chain' AND e.assigned_to = auth.uid())
                OR (e.visibility_scope = 'executive_only' AND v_caller_is_exec)
              )
          ) > 0
            THEN 'unresolved_escalation'
          WHEN c.reciprocity_trend = 'declining'
            THEN 'declining_reciprocity'
          WHEN COALESCE(c.maintenance_burden, 0) >= 70
            THEN 'burden_overload'
          WHEN COALESCE(c.capital_velocity, 0) < -10
            THEN 'declining_capital'
          ELSE NULL
        END
      ) ORDER BY COALESCE(cps.churn_probability, 0) DESC), '[]'::JSONB)
      FROM public.crm_contacts c
      LEFT JOIN public.crm_predictive_scores cps ON cps.contact_id = c.id
      WHERE c.org_id = p_org_id AND COALESCE(cps.churn_probability, 0) >= 60
      LIMIT 20
    ),
    'churn_distribution', (
      SELECT jsonb_build_object(
        'critical_80plus', COUNT(*) FILTER (WHERE cps.churn_probability >= 80),
        'high_60_79',      COUNT(*) FILTER (WHERE cps.churn_probability BETWEEN 60 AND 79),
        'moderate_40_59',  COUNT(*) FILTER (WHERE cps.churn_probability BETWEEN 40 AND 59),
        'low_under_40',    COUNT(*) FILTER (WHERE COALESCE(cps.churn_probability, 0) < 40)
      )
      FROM public.crm_contacts c
      LEFT JOIN public.crm_predictive_scores cps ON cps.contact_id = c.id
      WHERE c.org_id = p_org_id
    ),
    'recoverability_summary', (
      SELECT jsonb_build_object(
        'terminal',             COUNT(*) FILTER (WHERE
          c.trust_state = 'broken'
          AND COALESCE(cps.churn_probability, 0) >= 80
          AND COALESCE(c.capital_velocity, 0) <= 0
          AND COALESCE(c.resilience_index, 100) < 40
        ),
        'structurally_broken',  COUNT(*) FILTER (WHERE
          c.trust_state = 'broken'
          AND COALESCE(cps.churn_probability, 0) >= 60
          AND c.trajectory_acceleration IN ('collapsing','deteriorating')
        ),
        'escalation_dependent', COUNT(*) FILTER (WHERE
          COALESCE(cps.churn_probability, 0) >= 60
          AND EXISTS (
            SELECT 1 FROM public.crm_escalations e
            WHERE e.contact_id = c.id AND e.org_id = p_org_id
              AND e.priority IN ('critical','high')
              AND e.execution_state NOT IN ('resolved','dismissed')
              AND (
                e.visibility_scope = 'org'
                OR (e.visibility_scope = 'leadership' AND v_caller_roles && ARRAY['founder','executive','manager'])
                OR (e.visibility_scope = 'owner_chain' AND e.assigned_to = auth.uid())
                OR (e.visibility_scope = 'executive_only' AND v_caller_is_exec)
              )
          )
        ),
        'fragile', COUNT(*) FILTER (WHERE
          COALESCE(cps.churn_probability, 0) >= 60
          AND COALESCE(c.capital_velocity, 0) < 0
          AND COALESCE(c.resilience_index, 100) < 50
        ),
        'recoverable', COUNT(*) FILTER (WHERE
          COALESCE(cps.churn_probability, 0) >= 60
        )
      )
      FROM public.crm_contacts c
      LEFT JOIN public.crm_predictive_scores cps ON cps.contact_id = c.id
      WHERE c.org_id = p_org_id
    ),
    'blocker_summary', (
      SELECT jsonb_build_object(
        'trust_fracture',        COUNT(*) FILTER (WHERE c.trust_state = 'broken'),
        'burden_overload',       COUNT(*) FILTER (WHERE COALESCE(c.maintenance_burden, 0) >= 70),
        'declining_capital',     COUNT(*) FILTER (WHERE COALESCE(c.capital_velocity, 0) < -10),
        'declining_reciprocity', COUNT(*) FILTER (WHERE c.reciprocity_trend = 'declining')
      )
      FROM public.crm_contacts c
      LEFT JOIN public.crm_predictive_scores cps ON cps.contact_id = c.id
      WHERE c.org_id = p_org_id AND COALESCE(cps.churn_probability, 0) >= 60
    ),
    'recent_drift_summary', (
      SELECT jsonb_build_object(
        'new_high_churn_7d', new_high_churn_count,
        'recovered_7d',      recovered_count,
        'worsening_7d',      worsening_count
      )
      FROM public.crm_portfolio_health_pulse
      WHERE org_id = p_org_id ORDER BY pulse_date DESC LIMIT 1
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::JSONB);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- FIX 2: get_crm_contact_state_at
-- crm_predictive_score_history has no churn_score_delta column
-- (that GENERATED column lives on crm_predictive_scores only)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_crm_contact_state_at(
  p_contact_id UUID,
  p_org_id     UUID,
  p_timestamp  TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot         RECORD;
  v_pred_history     RECORD;
  v_briefing_ts      TIMESTAMPTZ;
  v_escalations      JSONB;
  v_days_since_snap  INT;
  v_certainty_level  TEXT;
  v_missing_signals  JSONB;
  v_reconstruction   TEXT;
  v_result           JSONB;
  v_retention_days   INT;
  v_purge_context    TEXT;
BEGIN

  SELECT
    rs.snapshot_date,
    rs.capital_score,
    rs.capital_velocity,
    rs.trust_state,
    rs.resilience_index,
    rs.reciprocity_score,
    rs.maintenance_burden,
    rs.churn_probability,
    rs.expansion_probability,
    rs.relationship_outlook,
    rs.volatility_index
  INTO v_snapshot
  FROM public.crm_relationship_snapshots rs
  WHERE rs.contact_id = p_contact_id
    AND rs.snapshot_date <= p_timestamp::DATE
  ORDER BY rs.snapshot_date DESC
  LIMIT 1;

  -- churn_score_delta is a GENERATED column on crm_predictive_scores (live table).
  -- crm_predictive_score_history does NOT have this column — exclude it here.
  SELECT
    psh.snapshot_date,
    psh.churn_probability,
    psh.expansion_probability,
    psh.renewal_probability
  INTO v_pred_history
  FROM public.crm_predictive_score_history psh
  WHERE psh.contact_id = p_contact_id
    AND psh.snapshot_date <= p_timestamp::DATE
  ORDER BY psh.snapshot_date DESC
  LIMIT 1;

  SELECT generated_at INTO v_briefing_ts
  FROM public.crm_relationship_briefings
  WHERE contact_id = p_contact_id AND org_id = p_org_id
    AND generated_at <= p_timestamp
  ORDER BY generated_at DESC
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'trigger_type',    e.trigger_type,
    'priority',        e.priority,
    'execution_state', e.execution_state,
    'created_at',      e.created_at
  )), '[]'::JSONB)
  INTO v_escalations
  FROM public.crm_escalations e
  WHERE e.contact_id = p_contact_id
    AND e.org_id = p_org_id
    AND e.created_at <= p_timestamp
    AND (e.resolved_at IS NULL OR e.resolved_at > p_timestamp);

  IF v_snapshot.snapshot_date IS NULL THEN
    v_days_since_snap := NULL;
    v_certainty_level := 'low';
    v_reconstruction := 'No relationship snapshots exist for this contact at or before the requested date. State reconstruction is not possible.';
  ELSE
    v_days_since_snap := (p_timestamp::DATE - v_snapshot.snapshot_date)::INT;
    v_certainty_level := CASE
      WHEN v_days_since_snap <= 7  THEN 'high'
      WHEN v_days_since_snap <= 30 THEN 'medium'
      ELSE 'low'
    END;
    v_reconstruction := CASE
      WHEN v_days_since_snap <= 7
        THEN 'Reconstructed from snapshot ' || v_days_since_snap || ' day(s) before requested date. High confidence.'
      WHEN v_days_since_snap <= 30
        THEN 'Closest snapshot is ' || v_days_since_snap || ' days before requested date. Some signals may have changed.'
      ELSE
        'Closest snapshot is ' || v_days_since_snap || ' days before requested date. Reconstruction confidence is LOW — significant state changes may be missing.'
    END;
  END IF;

  -- V5c: Detect potential purge context for missing predictive history.
  IF v_pred_history.snapshot_date IS NULL THEN
    SELECT retention_days INTO v_retention_days
    FROM crm_retention_policies
    WHERE org_id = p_org_id
      AND resource_type = 'predictive_score_history'
      AND is_active = TRUE;

    IF v_retention_days IS NOT NULL
       AND p_timestamp < NOW() - (v_retention_days || ' days')::INTERVAL THEN
      v_purge_context := 'Predictive score history may have been purged per the '
        || v_retention_days || '-day retention policy. Historical predictive state before this date cannot be reconstructed.';
    END IF;
  END IF;

  v_missing_signals := jsonb_build_array(
    CASE WHEN v_snapshot.snapshot_date IS NULL           THEN 'relationship_snapshot' END,
    CASE WHEN v_pred_history.snapshot_date IS NULL       THEN 'predictive_scores'     END,
    CASE WHEN v_briefing_ts IS NULL                      THEN 'briefing'              END
  );
  SELECT jsonb_agg(s) INTO v_missing_signals
  FROM jsonb_array_elements_text(v_missing_signals) s
  WHERE s IS NOT NULL;

  v_result := jsonb_build_object(
    'contact_id',   p_contact_id,
    'at_timestamp', p_timestamp,
    'certainty', jsonb_build_object(
      'level',               v_certainty_level,
      'days_since_snapshot', v_days_since_snap,
      'missing_signals',     COALESCE(v_missing_signals, '[]'::JSONB),
      'reconstruction_note', v_reconstruction,
      'purge_context',       v_purge_context
    ),
    'snapshot', CASE WHEN v_snapshot.snapshot_date IS NULL THEN NULL ELSE jsonb_build_object(
      'date',                v_snapshot.snapshot_date,
      'capital_score',       v_snapshot.capital_score,
      'capital_velocity',    v_snapshot.capital_velocity,
      'trust_state',         v_snapshot.trust_state,
      'resilience_index',    v_snapshot.resilience_index,
      'reciprocity_score',   v_snapshot.reciprocity_score,
      'maintenance_burden',  v_snapshot.maintenance_burden,
      'churn_probability',   v_snapshot.churn_probability,
      'expansion_probability', v_snapshot.expansion_probability,
      'relationship_outlook', v_snapshot.relationship_outlook,
      'volatility_index',    v_snapshot.volatility_index
    ) END,
    'predictive_at_date', CASE WHEN v_pred_history.snapshot_date IS NULL THEN NULL ELSE jsonb_build_object(
      'date',               v_pred_history.snapshot_date,
      'churn_probability',  v_pred_history.churn_probability,
      'expansion_probability', v_pred_history.expansion_probability,
      'renewal_probability', v_pred_history.renewal_probability
    ) END,
    'briefing_available_at', v_briefing_ts,
    'active_escalations',    COALESCE(v_escalations, '[]'::JSONB)
  );

  RETURN v_result;
END;
$$;

-- ────────────────────────────────────────────────────────────
-- FIX 3: get_crm_customer_journey — ml.created_at → ml.merged_at
-- crm_merge_log has no created_at; the merge timestamp is merged_at.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_crm_customer_journey(
  p_contact_id UUID,
  p_org_id     UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email        TEXT;
  v_gsc_lead_id  UUID;
  v_lge_lead_id  UUID;
  v_converted_at TIMESTAMPTZ;
  v_result       JSONB;
BEGIN
  SELECT email INTO v_email
  FROM crm_contacts
  WHERE id = p_contact_id AND org_id = p_org_id;

  IF NOT FOUND THEN RETURN '{}'::JSONB; END IF;

  SELECT changed_at INTO v_converted_at
  FROM crm_lifecycle_changes
  WHERE contact_id = p_contact_id AND to_stage = 'customer'
  ORDER BY changed_at ASC LIMIT 1;

  IF v_email IS NOT NULL THEN
    SELECT l.id INTO v_gsc_lead_id
    FROM leads l
    WHERE l.email = v_email
      AND l.profile_id IN (SELECT user_id FROM org_members WHERE org_id = p_org_id)
    ORDER BY l.created_at DESC LIMIT 1;
  END IF;

  IF v_gsc_lead_id IS NOT NULL THEN
    SELECT id INTO v_lge_lead_id
    FROM lge_raw_leads
    WHERE gsc_lead_id = v_gsc_lead_id AND org_id = p_org_id
    LIMIT 1;
  END IF;
  IF v_lge_lead_id IS NULL AND v_email IS NOT NULL THEN
    SELECT id INTO v_lge_lead_id
    FROM lge_raw_leads
    WHERE email = v_email AND org_id = p_org_id
    ORDER BY created_at DESC LIMIT 1;
  END IF;

  WITH

  score_shifts AS (
    SELECT
      h.snapshot_date::TIMESTAMPTZ AS occurred_at,
      h.churn_probability,
      h.expansion_probability,
      h.revenue_trajectory,
      LAG(h.churn_probability) OVER (ORDER BY h.snapshot_date) AS prev_churn
    FROM crm_predictive_score_history h
    WHERE h.contact_id = p_contact_id
  ),

  raw_events AS (

    SELECT
      lr.created_at                                      AS occurred_at,
      'acquisition'                                      AS phase,
      'lge_import'                                       AS event_type,
      'Lead imported'                                    AS title,
      'Source: ' || COALESCE(lr.source, 'CSV upload')   AS detail,
      'neutral'                                          AS sentiment
    FROM lge_raw_leads lr
    WHERE lr.id = v_lge_lead_id

    UNION ALL

    SELECT
      le.enriched_at, 'acquisition', 'lge_enriched', 'Lead enriched',
      'Email verified: ' || le.email_verified::TEXT
        || CASE WHEN le.confidence_score IS NOT NULL THEN '   Confidence: ' || le.confidence_score ELSE '' END,
      'positive'
    FROM lge_enrichment le
    WHERE le.raw_lead_id = v_lge_lead_id

    UNION ALL

    SELECT
      ls.scored_at, 'acquisition', 'lge_scored',
      'Lead scored   ' || ls.total_score || '/100',
      'Fit: ' || ls.fit_score || '   Confidence: ' || ls.confidence_score,
      CASE WHEN ls.total_score >= 80 THEN 'positive' WHEN ls.total_score >= 60 THEN 'neutral' ELSE 'negative' END
    FROM lge_scores ls
    WHERE ls.raw_lead_id = v_lge_lead_id

    UNION ALL

    SELECT
      lr.updated_at, 'acquisition', 'lge_pushed',
      'Pushed to sales pipeline',
      'Score cleared threshold   AI outreach initiated', 'positive'
    FROM lge_raw_leads lr
    WHERE lr.id = v_lge_lead_id AND lr.status = 'pushed'

    UNION ALL

    SELECT
      l.created_at, 'acquisition', 'gsc_lead_created',
      'Entered sales pipeline', 'GSC lead created', 'positive'
    FROM leads l
    WHERE l.id = v_gsc_lead_id

    UNION ALL

    SELECT
      i.created_at,
      CASE WHEN v_converted_at IS NULL OR i.created_at < v_converted_at THEN 'engagement' ELSE 'relationship' END,
      CASE WHEN i.direction = 'inbound' THEN 'gsc_reply' ELSE 'gsc_outreach' END,
      CASE WHEN i.direction = 'inbound' THEN 'Lead replied' ELSE 'Outreach sent' END,
      LEFT(COALESCE(i.content, ''), 120),
      CASE WHEN i.direction = 'inbound' THEN 'positive' ELSE 'neutral' END
    FROM (
      SELECT content, direction, created_at
      FROM interactions
      WHERE lead_id = v_gsc_lead_id
      ORDER BY created_at LIMIT 15
    ) i

    UNION ALL

    SELECT
      lc.changed_at,
      CASE WHEN lc.to_stage = 'customer' THEN 'conversion'
           WHEN v_converted_at IS NULL OR lc.changed_at <= v_converted_at THEN 'engagement'
           ELSE 'relationship' END,
      'lifecycle_change',
      'Stage: ' || COALESCE(lc.from_stage, 'new') || '   ' || lc.to_stage,
      COALESCE(lc.reason, ''),
      CASE WHEN lc.to_stage IN ('customer','opportunity') THEN 'positive'
           WHEN lc.to_stage IN ('lost','churned') THEN 'negative'
           ELSE 'neutral' END
    FROM crm_lifecycle_changes lc
    WHERE lc.contact_id = p_contact_id

    UNION ALL

    SELECT
      a.occurred_at,
      CASE WHEN v_converted_at IS NULL OR a.occurred_at < v_converted_at THEN 'engagement' ELSE 'relationship' END,
      'crm_activity',
      COALESCE(a.subject, REPLACE(COALESCE(a.activity_type, 'activity'), '_', ' ')),
      LEFT(COALESCE(a.body, ''), 120),
      CASE WHEN a.direction = 'inbound' THEN 'positive' ELSE 'neutral' END
    FROM (
      SELECT occurred_at, activity_type, direction, subject, body
      FROM crm_activities
      WHERE contact_id = p_contact_id AND org_id = p_org_id
      ORDER BY occurred_at LIMIT 30
    ) a

    UNION ALL

    SELECT
      re.occurred_at, 'relationship',
      'revenue_' || re.event_type,
      CASE re.event_type
        WHEN 'purchase'     THEN 'Purchase   $' || re.amount::INT
        WHEN 'renewal'      THEN 'Renewal   $' || re.amount::INT
        WHEN 'upsell'       THEN 'Upsell   +$' || re.amount::INT
        WHEN 'downgrade'    THEN 'Downgrade'
        WHEN 'refund'       THEN 'Refund   -$' || re.amount::INT
        WHEN 'cancellation' THEN 'Cancellation'
        ELSE REPLACE(re.event_type, '_', ' ')
      END,
      COALESCE(re.description, ''),
      CASE WHEN re.event_type IN ('purchase','renewal','upsell') THEN 'positive'
           WHEN re.event_type IN ('refund','cancellation','downgrade') THEN 'negative'
           ELSE 'neutral' END
    FROM (
      SELECT occurred_at, event_type, amount, description
      FROM crm_revenue_events
      WHERE contact_id = p_contact_id AND org_id = p_org_id
      ORDER BY occurred_at LIMIT 20
    ) re

    UNION ALL

    -- e.priority not e.severity (Known Gotcha #24)
    SELECT
      e.created_at, 'relationship',
      CASE WHEN e.execution_state IN ('resolved','dismissed') THEN 'escalation_resolved' ELSE 'escalation_created' END,
      CASE WHEN e.execution_state IN ('resolved','dismissed')
        THEN 'Escalation resolved: ' || REPLACE(COALESCE(e.trigger_type,'manual'), '_', ' ')
        ELSE 'Escalation raised: ' || REPLACE(COALESCE(e.trigger_type,'manual'), '_', ' ')
      END,
      e.priority || ' priority',
      CASE WHEN e.execution_state IN ('resolved','dismissed') THEN 'positive' ELSE 'negative' END
    FROM crm_escalations e
    WHERE e.contact_id = p_contact_id AND e.org_id = p_org_id

    UNION ALL

    SELECT
      ss.occurred_at, 'relationship',
      CASE WHEN ss.churn_probability >= 70 THEN 'prediction_risk'
           WHEN ss.expansion_probability >= 65 THEN 'prediction_opportunity'
           ELSE 'prediction_update' END,
      'Prediction update   Churn: ' || ss.churn_probability || '%   Expansion: ' || ss.expansion_probability || '%',
      'Trajectory: ' || COALESCE(REPLACE(ss.revenue_trajectory,'_',' '), ' '),
      CASE WHEN ss.churn_probability >= 70 THEN 'negative'
           WHEN ss.expansion_probability >= 65 THEN 'positive'
           ELSE 'neutral' END
    FROM score_shifts ss
    WHERE ABS(COALESCE(ss.churn_probability - ss.prev_churn, 0)) >= 15
       OR (ss.prev_churn IS NULL AND ss.churn_probability >= 60)

    UNION ALL

    -- V2: Merge provenance — surface identity merges in relationship timeline.
    -- merged_at is the actual merge timestamp on crm_merge_log (not created_at).
    SELECT
      ml.merged_at,
      'relationship',
      'identity_merge',
      'Identity merged',
      'Source: ' || COALESCE(
        ml.source_contact_snapshot->>'email',
        ml.source_contact_snapshot->>'name',
        'unknown'
      ) || CASE WHEN ml.merge_reason IS NOT NULL AND ml.merge_reason <> 'manual'
        THEN ' (' || REPLACE(ml.merge_reason,'_',' ') || ')' ELSE '' END,
      'neutral'
    FROM crm_merge_log ml
    WHERE ml.target_contact_id = p_contact_id
      AND ml.org_id = p_org_id
      AND ml.approval_status IN ('approved','auto_approved')

  ),

  phased AS (
    SELECT
      phase,
      jsonb_agg(
        jsonb_build_object(
          'occurred_at', occurred_at,
          'event_type',  event_type,
          'title',       title,
          'detail',      NULLIF(TRIM(COALESCE(detail,'')), ''),
          'sentiment',   sentiment
        )
        ORDER BY occurred_at
      ) AS events,
      COUNT(*) AS event_count
    FROM raw_events
    GROUP BY phase
  )

  SELECT jsonb_build_object(
    'phases', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'phase',       phase,
          'event_count', event_count,
          'events',      events
        )
        ORDER BY
          CASE phase
            WHEN 'acquisition' THEN 1
            WHEN 'engagement'  THEN 2
            WHEN 'conversion'  THEN 3
            ELSE 4
          END
      ), '[]'::JSONB
    ),
    'total_events', COALESCE(SUM(event_count), 0),
    'has_lge',      v_lge_lead_id IS NOT NULL,
    'has_gsc',      v_gsc_lead_id IS NOT NULL,
    'converted_at', v_converted_at,
    'generated_at', NOW()
  )
  INTO v_result
  FROM phased;

  RETURN COALESCE(v_result, jsonb_build_object(
    'phases', '[]'::JSONB,
    'total_events', 0,
    'has_lge', false,
    'has_gsc', false,
    'generated_at', NOW()
  ));
END;
$$;
