-- Sprint 18: Meta-Layer 5 — Causality Chains
-- Deterministic causal inference: what caused deterioration, what reversed churn,
-- what stabilized trust. NOT probabilistic AI — SQL temporal pattern matching.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crm_causal_events — atomic cause-effect observations per contact
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_causal_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id          UUID        NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  cause_type          TEXT        NOT NULL CHECK (cause_type IN (
                                    'trust_fracture_high','trust_fracture_critical',
                                    'escalation_opened','escalation_resolved',
                                    'capital_velocity_decline','capital_velocity_recovery',
                                    'champion_role_assigned','blocker_role_assigned',
                                    'silence_gap_21d','silence_gap_42d',
                                    'maintenance_spike','reciprocity_collapse',
                                    'intervention_applied','campaign_activated',
                                    'ownership_change','trajectory_inflection'
                                  )),
  effect_type         TEXT        NOT NULL CHECK (effect_type IN (
                                    'churn_increase','churn_decrease',
                                    'expansion_blocked','expansion_unlocked',
                                    'trust_broken','trust_recovered',
                                    'trajectory_declined','trajectory_improved',
                                    'capital_collapsed','capital_recovered',
                                    'escalation_triggered','escalation_resolved_positive'
                                  )),
  cause_observed_at   TIMESTAMPTZ NOT NULL,
  effect_observed_at  TIMESTAMPTZ NOT NULL,
  lag_days            INT         NOT NULL DEFAULT 0,
  confidence          TEXT        NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  delta_magnitude     INT         NOT NULL DEFAULT 0,   -- size of the effect change (points)
  direction           TEXT        NOT NULL DEFAULT 'negative' CHECK (direction IN ('positive','negative','neutral')),
  evidence            JSONB       DEFAULT '{}',
  source_key          TEXT,       -- dedup: one event per cause instance
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_causal_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_ce_org ON public.crm_causal_events
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_ce_org_contact
  ON public.crm_causal_events (org_id, contact_id, cause_observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_ce_cause_type
  ON public.crm_causal_events (org_id, cause_type);
CREATE INDEX IF NOT EXISTS idx_crm_ce_source_key
  ON public.crm_causal_events (org_id, source_key) WHERE source_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. crm_causal_chains — aggregated causal patterns across the org
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_causal_chains (
  id                  UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  chain_type          TEXT  NOT NULL CHECK (chain_type IN (
                              'deterioration_chain','recovery_chain',
                              'churn_cascade','trust_fracture_chain',
                              'expansion_unlock_chain','maintenance_spiral',
                              'escalation_storm','silence_decay'
                            )),
  cause_type          TEXT  NOT NULL,
  effect_type         TEXT  NOT NULL,
  occurrence_count    INT   NOT NULL DEFAULT 0,
  avg_lag_days        INT   NOT NULL DEFAULT 0,
  avg_delta_magnitude INT   NOT NULL DEFAULT 0,
  confidence          TEXT  NOT NULL DEFAULT 'low' CHECK (confidence IN ('low','medium','high')),
  typical_outcome     TEXT,
  last_detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, chain_type, cause_type, effect_type)
);

ALTER TABLE public.crm_causal_chains ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_cc_org ON public.crm_causal_chains
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_cc_org_type
  ON public.crm_causal_chains (org_id, chain_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. infer_crm_causal_events — temporal pattern matching against known cause→effect pairs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.infer_crm_causal_events(p_org_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT := 0; v_rc INT;
BEGIN

  -- ── Pattern A: Trust fracture (high/critical) → churn increase within 21 days
  INSERT INTO crm_causal_events
    (org_id, contact_id, cause_type, effect_type, cause_observed_at, effect_observed_at,
     lag_days, confidence, delta_magnitude, direction, evidence, source_key)
  SELECT
    p_org_id, tf.contact_id,
    CASE tf.severity WHEN 'critical' THEN 'trust_fracture_critical' ELSE 'trust_fracture_high' END,
    'churn_increase',
    tf.occurred_at,
    s_after.created_at,
    EXTRACT(DAY FROM s_after.created_at - tf.occurred_at)::INT,
    CASE WHEN (s_after.churn_probability - COALESCE(s_before.churn_probability, 0)) >= 20 THEN 'high' ELSE 'medium' END,
    (s_after.churn_probability - COALESCE(s_before.churn_probability, 0))::INT,
    'negative',
    jsonb_build_object(
      'fracture_type', tf.fracture_type,
      'fracture_severity', tf.severity,
      'churn_before', s_before.churn_probability,
      'churn_after', s_after.churn_probability,
      'delta', s_after.churn_probability - COALESCE(s_before.churn_probability, 0)
    ),
    'fracture_churn_' || tf.id::TEXT
  FROM crm_trust_fractures tf
  JOIN crm_contacts c ON c.id = tf.contact_id AND c.org_id = p_org_id
  -- snapshot after fracture (within 21 days)
  JOIN LATERAL (
    SELECT rs.churn_probability, rs.created_at FROM crm_relationship_snapshots rs
    WHERE rs.contact_id = tf.contact_id
      AND rs.created_at > tf.occurred_at
      AND rs.created_at <= tf.occurred_at + INTERVAL '21 days'
    ORDER BY rs.created_at ASC LIMIT 1
  ) s_after ON TRUE
  -- snapshot before fracture
  LEFT JOIN LATERAL (
    SELECT rs.churn_probability FROM crm_relationship_snapshots rs
    WHERE rs.contact_id = tf.contact_id
      AND rs.created_at < tf.occurred_at
    ORDER BY rs.created_at DESC LIMIT 1
  ) s_before ON TRUE
  WHERE tf.org_id = p_org_id
    AND tf.severity IN ('high','critical')
    AND s_after.churn_probability > COALESCE(s_before.churn_probability, 0) + 5
    AND NOT EXISTS (
      SELECT 1 FROM crm_causal_events
      WHERE org_id = p_org_id AND source_key = 'fracture_churn_' || tf.id::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- ── Pattern B: Escalation resolved → churn decrease within 30 days
  INSERT INTO crm_causal_events
    (org_id, contact_id, cause_type, effect_type, cause_observed_at, effect_observed_at,
     lag_days, confidence, delta_magnitude, direction, evidence, source_key)
  SELECT
    p_org_id, e.contact_id,
    'escalation_resolved',
    'churn_decrease',
    e.resolved_at,
    s_after.created_at,
    EXTRACT(DAY FROM s_after.created_at - e.resolved_at)::INT,
    CASE WHEN (COALESCE(s_before.churn_probability,100) - s_after.churn_probability) >= 20 THEN 'high' ELSE 'medium' END,
    (COALESCE(s_before.churn_probability, 100) - s_after.churn_probability)::INT,
    'positive',
    jsonb_build_object(
      'escalation_priority', e.priority,
      'churn_before', s_before.churn_probability,
      'churn_after', s_after.churn_probability,
      'delta', COALESCE(s_before.churn_probability,100) - s_after.churn_probability
    ),
    'esc_resolved_churn_' || e.id::TEXT
  FROM crm_escalations e
  JOIN crm_contacts c ON c.id = e.contact_id AND c.org_id = p_org_id
  JOIN LATERAL (
    SELECT rs.churn_probability, rs.created_at FROM crm_relationship_snapshots rs
    WHERE rs.contact_id = e.contact_id
      AND rs.created_at > e.resolved_at
      AND rs.created_at <= e.resolved_at + INTERVAL '30 days'
    ORDER BY rs.created_at ASC LIMIT 1
  ) s_after ON TRUE
  LEFT JOIN LATERAL (
    SELECT rs.churn_probability FROM crm_relationship_snapshots rs
    WHERE rs.contact_id = e.contact_id
      AND rs.created_at < e.resolved_at
    ORDER BY rs.created_at DESC LIMIT 1
  ) s_before ON TRUE
  WHERE e.org_id = p_org_id
    AND e.execution_state = 'resolved'
    AND e.resolved_at IS NOT NULL
    AND s_after.churn_probability < COALESCE(s_before.churn_probability, 100) - 5
    AND NOT EXISTS (
      SELECT 1 FROM crm_causal_events
      WHERE org_id = p_org_id AND source_key = 'esc_resolved_churn_' || e.id::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- ── Pattern C: Capital velocity decline → trajectory worsened within 14 days
  INSERT INTO crm_causal_events
    (org_id, contact_id, cause_type, effect_type, cause_observed_at, effect_observed_at,
     lag_days, confidence, delta_magnitude, direction, evidence, source_key)
  SELECT
    p_org_id, s1.contact_id,
    'capital_velocity_decline',
    'trajectory_declined',
    s1.created_at,
    s2.created_at,
    EXTRACT(DAY FROM s2.created_at - s1.created_at)::INT,
    'medium',
    ABS(COALESCE(s1.capital_velocity, 0))::INT,
    'negative',
    jsonb_build_object(
      'capital_velocity', s1.capital_velocity,
      'outlook_before', s1.relationship_outlook,
      'outlook_after', s2.relationship_outlook
    ),
    'cap_decline_traj_' || s1.id::TEXT
  FROM crm_relationship_snapshots s1
  JOIN crm_contacts c ON c.id = s1.contact_id AND c.org_id = p_org_id
  JOIN LATERAL (
    SELECT rs.relationship_outlook, rs.created_at FROM crm_relationship_snapshots rs
    WHERE rs.contact_id = s1.contact_id
      AND rs.created_at > s1.created_at
      AND rs.created_at <= s1.created_at + INTERVAL '14 days'
    ORDER BY rs.created_at ASC LIMIT 1
  ) s2 ON TRUE
  WHERE COALESCE(s1.capital_velocity, 0) <= -10
    AND s1.relationship_outlook IN ('improving','stable')
    AND s2.relationship_outlook IN ('deteriorating','critical')
    AND NOT EXISTS (
      SELECT 1 FROM crm_causal_events
      WHERE org_id = p_org_id AND source_key = 'cap_decline_traj_' || s1.id::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- ── Pattern D: Intervention impact → positive (from crm_intervention_impacts)
  INSERT INTO crm_causal_events
    (org_id, contact_id, cause_type, effect_type, cause_observed_at, effect_observed_at,
     lag_days, confidence, delta_magnitude, direction, evidence, source_key)
  SELECT
    p_org_id, ii.contact_id,
    'intervention_applied',
    CASE
      WHEN (ii.after_state->>'churn_probability')::NUMERIC < (ii.before_state->>'churn_probability')::NUMERIC - 10
        THEN 'churn_decrease'
      WHEN (ii.after_state->>'relationship_capital_score')::NUMERIC > (ii.before_state->>'relationship_capital_score')::NUMERIC + 10
        THEN 'capital_recovered'
      ELSE 'trajectory_improved'
    END,
    ii.created_at,
    ii.measured_at,
    EXTRACT(DAY FROM ii.measured_at - ii.created_at)::INT,
    CASE WHEN ii.impact_score >= 70 THEN 'high' WHEN ii.impact_score >= 40 THEN 'medium' ELSE 'low' END,
    ii.impact_score,
    'positive',
    jsonb_build_object(
      'intervention_type', ii.intervention_type,
      'impact_score', ii.impact_score,
      'before_state', ii.before_state,
      'after_state', ii.after_state
    ),
    'intervention_' || ii.id::TEXT
  FROM crm_intervention_impacts ii
  JOIN crm_contacts c ON c.id = ii.contact_id AND c.org_id = p_org_id
  WHERE ii.impact_score >= 30
    AND ii.measured_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM crm_causal_events
      WHERE org_id = p_org_id AND source_key = 'intervention_' || ii.id::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. aggregate_crm_causal_chains — find repeated causal patterns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.aggregate_crm_causal_chains(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO crm_causal_chains
    (org_id, chain_type, cause_type, effect_type, occurrence_count,
     avg_lag_days, avg_delta_magnitude, confidence, typical_outcome, last_detected_at)
  SELECT
    p_org_id,
    CASE
      WHEN cause_type LIKE 'trust_fracture%' AND effect_type = 'churn_increase' THEN 'trust_fracture_chain'
      WHEN cause_type = 'escalation_resolved' AND direction = 'positive' THEN 'recovery_chain'
      WHEN cause_type = 'capital_velocity_decline' THEN 'deterioration_chain'
      WHEN cause_type = 'intervention_applied' AND direction = 'positive' THEN 'recovery_chain'
      WHEN cause_type = 'maintenance_spike' THEN 'maintenance_spiral'
      ELSE 'deterioration_chain'
    END AS chain_type,
    cause_type,
    effect_type,
    COUNT(*)::INT AS occurrence_count,
    ROUND(AVG(lag_days))::INT AS avg_lag_days,
    ROUND(AVG(delta_magnitude))::INT AS avg_delta_magnitude,
    CASE WHEN COUNT(*) >= 10 THEN 'high' WHEN COUNT(*) >= 4 THEN 'medium' ELSE 'low' END AS confidence,
    'Occurs ' || COUNT(*) || ' times; typical effect in ' || ROUND(AVG(lag_days)) || ' days; avg impact ' || ROUND(AVG(delta_magnitude)) || ' pts',
    now()
  FROM crm_causal_events
  WHERE org_id = p_org_id
  GROUP BY cause_type, effect_type, direction
  ON CONFLICT (org_id, chain_type, cause_type, effect_type) DO UPDATE SET
    occurrence_count    = EXCLUDED.occurrence_count,
    avg_lag_days        = EXCLUDED.avg_lag_days,
    avg_delta_magnitude = EXCLUDED.avg_delta_magnitude,
    confidence          = EXCLUDED.confidence,
    typical_outcome     = EXCLUDED.typical_outcome,
    last_detected_at    = now();
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. get_crm_causal_intelligence — query causal events + chains
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_causal_intelligence(
  p_org_id UUID,
  p_contact_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(

    -- Per-contact causal events (when p_contact_id provided)
    'contact_events', CASE WHEN p_contact_id IS NOT NULL THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'cause_type', cause_type, 'effect_type', effect_type,
        'lag_days', lag_days, 'delta_magnitude', delta_magnitude,
        'direction', direction, 'confidence', confidence,
        'cause_observed_at', cause_observed_at,
        'evidence', evidence
      ) ORDER BY cause_observed_at DESC)
      FROM crm_causal_events
      WHERE org_id = p_org_id AND contact_id = p_contact_id
      ORDER BY cause_observed_at DESC LIMIT 10
    ), '[]'::jsonb) ELSE NULL END,

    -- Org-level causal chains (patterns)
    'causal_chains', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'chain_type', chain_type, 'cause_type', cause_type, 'effect_type', effect_type,
        'occurrence_count', occurrence_count, 'avg_lag_days', avg_lag_days,
        'avg_delta_magnitude', avg_delta_magnitude, 'confidence', confidence,
        'typical_outcome', typical_outcome
      ) ORDER BY occurrence_count DESC)
      FROM crm_causal_chains WHERE org_id = p_org_id
    ), '[]'::jsonb),

    -- Most destructive patterns
    'top_negative_causes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cause_type', cause_type, 'effect_type', effect_type,
        'count', cnt, 'avg_delta', avg_delta
      ) ORDER BY cnt DESC)
      FROM (
        SELECT cause_type, effect_type, COUNT(*) AS cnt, ROUND(AVG(delta_magnitude)) AS avg_delta
        FROM crm_causal_events
        WHERE org_id = p_org_id AND direction = 'negative'
        GROUP BY cause_type, effect_type
        ORDER BY COUNT(*) DESC LIMIT 5
      ) t
    ), '[]'::jsonb),

    -- Most effective recovery patterns
    'top_positive_interventions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cause_type', cause_type, 'effect_type', effect_type,
        'count', cnt, 'avg_delta', avg_delta
      ) ORDER BY cnt DESC)
      FROM (
        SELECT cause_type, effect_type, COUNT(*) AS cnt, ROUND(AVG(delta_magnitude)) AS avg_delta
        FROM crm_causal_events
        WHERE org_id = p_org_id AND direction = 'positive'
        GROUP BY cause_type, effect_type
        ORDER BY COUNT(*) DESC LIMIT 5
      ) t
    ), '[]'::jsonb),

    'total_events_logged', (SELECT COUNT(*) FROM crm_causal_events WHERE org_id = p_org_id),
    'total_chains_detected', (SELECT COUNT(*) FROM crm_causal_chains WHERE org_id = p_org_id)

  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. compute_crm_sprint18_nightly + pg_cron
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_sprint18_nightly(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM infer_crm_causal_events(p_org_id);
  PERFORM aggregate_crm_causal_chains(p_org_id);
END;
$$;

SELECT cron.schedule(
  'compute_crm_sprint18_nightly',
  '15 8 * * *',
  $$SELECT compute_crm_sprint18_nightly(id) FROM organizations WHERE cancellation_status IS NULL$$
);

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE cancellation_status IS NULL LOOP
    BEGIN PERFORM compute_crm_sprint18_nightly(r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;
