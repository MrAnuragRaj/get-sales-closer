-- =============================================================
-- Sprint B: Executive Digest Engine + Decision Quality Engine
-- =============================================================

-- ─── 1. crm_executive_digests ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_executive_digests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  digest_date           DATE        NOT NULL DEFAULT CURRENT_DATE,
  digest_type           TEXT        NOT NULL CHECK (digest_type IN ('daily','weekly')),
  contact_count         INT         NOT NULL DEFAULT 0,
  worsening_count       INT         NOT NULL DEFAULT 0,
  improving_count       INT         NOT NULL DEFAULT 0,
  critical_escalations  INT         NOT NULL DEFAULT 0,
  high_churn_count      INT         NOT NULL DEFAULT 0,
  expansion_ready_count INT         NOT NULL DEFAULT 0,
  new_high_churn_count  INT         NOT NULL DEFAULT 0,
  recovered_count       INT         NOT NULL DEFAULT 0,
  sections              JSONB       NOT NULL DEFAULT '{}',
  narrative             TEXT        NOT NULL DEFAULT '',
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by          UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (org_id, digest_date, digest_type)
);

ALTER TABLE public.crm_executive_digests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_digests" ON public.crm_executive_digests;
CREATE POLICY "org_members_read_digests" ON public.crm_executive_digests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = crm_executive_digests.org_id
        AND om.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_crm_executive_digests_org_date
  ON public.crm_executive_digests (org_id, digest_date DESC, digest_type);

-- ─── 2. generate_crm_executive_digest ────────────────────────

CREATE OR REPLACE FUNCTION public.generate_crm_executive_digest(
  p_org_id      UUID,
  p_digest_type TEXT DEFAULT 'daily',
  p_actor_id    UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pulse           RECORD;
  v_consciousness   RECORD;
  v_debt            RECORD;
  v_contact_count   INT;
  v_high_churn_ct   INT;
  v_high_churn      JSONB;
  v_crit_esc_ct     INT;
  v_critical_esc    JSONB;
  v_expansion_ct    INT;
  v_expansion       JSONB;
  v_trajectory      JSONB;
  v_sections        JSONB;
  v_narrative       TEXT;
  v_worsening       INT;
  v_improving       INT;
  v_new_high_churn  INT;
  v_recovered       INT;
  v_parts           TEXT[];
  v_digest_id       UUID;
BEGIN
  -- Portfolio pulse (pulse_date column per gotcha #103)
  SELECT * INTO v_pulse
  FROM public.crm_portfolio_health_pulse
  WHERE org_id = p_org_id
  ORDER BY pulse_date DESC LIMIT 1;

  -- Operating consciousness
  SELECT * INTO v_consciousness
  FROM public.crm_operating_consciousness_snapshots
  WHERE org_id = p_org_id
  ORDER BY snapshot_date DESC LIMIT 1;

  -- Attention debt
  SELECT * INTO v_debt
  FROM public.crm_attention_debt_snapshots
  WHERE org_id = p_org_id
  ORDER BY snapshot_date DESC LIMIT 1;

  -- Contact count
  SELECT COUNT(*) INTO v_contact_count
  FROM public.crm_contacts WHERE org_id = p_org_id;

  -- High-churn count
  SELECT COUNT(*) INTO v_high_churn_ct
  FROM public.crm_contacts c
  JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
  WHERE c.org_id = p_org_id AND ps.churn_probability >= 60;

  -- High-churn list (top 10)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'contact_id', sub.id, 'name', sub.name, 'company', sub.company,
      'churn_probability', sub.churn_probability, 'relationship_state', sub.relationship_state
    )
  ), '[]') INTO v_high_churn
  FROM (
    SELECT c.id, c.name, c.company, ps.churn_probability, c.relationship_state
    FROM public.crm_contacts c
    JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    WHERE c.org_id = p_org_id AND ps.churn_probability >= 60
    ORDER BY ps.churn_probability DESC LIMIT 10
  ) sub;

  -- Critical/high escalation count (priority column per gotcha #24, execution_state per gotcha #24)
  SELECT COUNT(*) INTO v_crit_esc_ct
  FROM public.crm_escalations e
  WHERE e.org_id = p_org_id
    AND e.priority IN ('critical','high')
    AND e.execution_state IN ('open','assigned','in_progress','blocked');

  -- Escalation list (top 10)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'escalation_id', sub.id, 'contact_name', sub.cname, 'priority', sub.priority,
      'trigger_type', sub.trigger_type, 'sla_breached', sub.sla_breached,
      'days_open', sub.days_open
    ) ORDER BY CASE sub.priority WHEN 'critical' THEN 0 ELSE 1 END, sub.sla_breached DESC
  ), '[]') INTO v_critical_esc
  FROM (
    SELECT e.id, c.name AS cname, e.priority, e.trigger_type, e.sla_breached,
           EXTRACT(DAY FROM now() - e.created_at)::INT AS days_open
    FROM public.crm_escalations e
    JOIN public.crm_contacts c ON c.id = e.contact_id
    WHERE e.org_id = p_org_id
      AND e.priority IN ('critical','high')
      AND e.execution_state IN ('open','assigned','in_progress','blocked')
    ORDER BY CASE e.priority WHEN 'critical' THEN 0 ELSE 1 END, e.sla_breached DESC
    LIMIT 10
  ) sub;

  -- Expansion-ready count
  SELECT COUNT(*) INTO v_expansion_ct
  FROM public.crm_contacts
  WHERE org_id = p_org_id AND expansion_readiness_score >= 65;

  -- Expansion list (top 10)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'contact_id', sub.id, 'name', sub.name, 'company', sub.company,
      'expansion_readiness', sub.expansion_readiness_score,
      'growth_strain', sub.growth_strain_detected
    )
  ), '[]') INTO v_expansion
  FROM (
    SELECT id, name, company, expansion_readiness_score, growth_strain_detected
    FROM public.crm_contacts
    WHERE org_id = p_org_id AND expansion_readiness_score >= 65
    ORDER BY expansion_readiness_score DESC LIMIT 10
  ) sub;

  -- Recent inflections (join through contacts to get org scope)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'contact_name', sub.cname, 'inflection_type', sub.inflection_type,
      'detected_at', sub.detected_at
    ) ORDER BY sub.detected_at DESC
  ), '[]') INTO v_trajectory
  FROM (
    SELECT c.name AS cname, ip.inflection_type, ip.detected_at
    FROM public.crm_inflection_points ip
    JOIN public.crm_contacts c ON c.id = ip.contact_id
    WHERE c.org_id = p_org_id
      AND ip.detected_at >= CASE p_digest_type
        WHEN 'weekly' THEN now() - INTERVAL '7 days'
        ELSE now() - INTERVAL '48 hours'
      END
    ORDER BY ip.detected_at DESC LIMIT 20
  ) sub;

  -- Extract pulse values
  v_worsening      := COALESCE(v_pulse.worsening_count, 0);
  v_improving      := COALESCE(v_pulse.improving_count, 0);
  v_new_high_churn := COALESCE(v_pulse.new_high_churn_count, 0);
  v_recovered      := COALESCE(v_pulse.recovered_count, 0);

  -- Assemble sections
  v_sections := jsonb_build_object(
    'portfolio_pulse', jsonb_build_object(
      'worsening_count', v_worsening,
      'improving_count', v_improving,
      'new_high_churn', v_new_high_churn,
      'recovered', v_recovered,
      'net_capital_change', COALESCE(v_pulse.net_capital_change, 0),
      'pulse_narrative', COALESCE(v_pulse.pulse_narrative, 'No pulse data available yet.')
    ),
    'churn_alerts', jsonb_build_object(
      'high_churn_count', v_high_churn_ct,
      'contacts', v_high_churn
    ),
    'escalation_summary', jsonb_build_object(
      'critical_high_count', v_crit_esc_ct,
      'escalations', v_critical_esc
    ),
    'expansion_opportunities', jsonb_build_object(
      'expansion_ready_count', v_expansion_ct,
      'contacts', v_expansion
    ),
    'trajectory_shifts', jsonb_build_object(
      'inflections', v_trajectory
    ),
    'attention_summary', jsonb_build_object(
      'debt_score', COALESCE(v_debt.debt_score, 0),
      'debt_level', COALESCE(v_debt.debt_level, 'healthy'),
      'debt_velocity', COALESCE(v_debt.debt_velocity, 'stable')
    ),
    'consciousness_summary', CASE
      WHEN v_consciousness IS NULL THEN
        jsonb_build_object('level', 'unknown', 'synthesis', 'Consciousness data not yet computed.')
      ELSE jsonb_build_object(
        'level', v_consciousness.consciousness_level,
        'overall_risk', v_consciousness.overall_risk_score,
        'highest_risk_domain', v_consciousness.highest_risk_domain,
        'synthesis', v_consciousness.synthesis_narrative,
        'recommended_priority', v_consciousness.recommended_priority
      )
    END
  );

  -- Build deterministic narrative
  v_parts := ARRAY[]::TEXT[];

  IF v_pulse IS NOT NULL THEN
    IF v_worsening > v_improving THEN
      v_parts := v_parts || format(
        'Portfolio is under pressure — %s accounts worsening versus %s improving.',
        v_worsening, v_improving
      );
    ELSIF v_improving > v_worsening THEN
      v_parts := v_parts || format(
        'Portfolio momentum is positive — %s accounts improving versus %s worsening.',
        v_improving, v_worsening
      );
    ELSE
      v_parts := v_parts || 'Portfolio signals are balanced with equal improvement and deterioration signals.';
    END IF;
  ELSE
    v_parts := v_parts || format(
      'Portfolio contains %s contacts — intelligence builds after the first overnight compute cycle.',
      v_contact_count
    );
  END IF;

  IF v_high_churn_ct >= 5 THEN
    v_parts := v_parts || format(
      '%s contacts are at high churn risk (60%%+) — immediate attention required.',
      v_high_churn_ct
    );
  ELSIF v_high_churn_ct > 0 THEN
    v_parts := v_parts || format(
      '%s contact%s at elevated churn risk %s proactive outreach.',
      v_high_churn_ct,
      CASE WHEN v_high_churn_ct = 1 THEN '' ELSE 's' END,
      CASE WHEN v_high_churn_ct = 1 THEN 'needs' ELSE 'need' END
    );
  END IF;

  IF v_crit_esc_ct > 0 THEN
    v_parts := v_parts || format(
      '%s critical or high-priority escalation%s %s open.',
      v_crit_esc_ct,
      CASE WHEN v_crit_esc_ct = 1 THEN '' ELSE 's' END,
      CASE WHEN v_crit_esc_ct = 1 THEN 'is' ELSE 'are' END
    );
  END IF;

  IF v_new_high_churn > 0 AND v_recovered > 0 THEN
    v_parts := v_parts || format(
      '%s new high-churn signals detected; %s account%s recovered from prior risk.',
      v_new_high_churn, v_recovered,
      CASE WHEN v_recovered = 1 THEN '' ELSE 's' END
    );
  ELSIF v_new_high_churn > 0 THEN
    v_parts := v_parts || format(
      '%s account%s newly entered high-churn risk territory.',
      v_new_high_churn,
      CASE WHEN v_new_high_churn = 1 THEN ' has' ELSE 's have' END
    );
  ELSIF v_recovered > 0 THEN
    v_parts := v_parts || format(
      '%s account%s recovered from churn risk — stabilization is working.',
      v_recovered,
      CASE WHEN v_recovered = 1 THEN ' has' ELSE 's have' END
    );
  END IF;

  IF v_expansion_ct > 0 THEN
    v_parts := v_parts || format(
      '%s contact%s %s expansion-ready and represent immediate growth opportunity.',
      v_expansion_ct,
      CASE WHEN v_expansion_ct = 1 THEN '' ELSE 's' END,
      CASE WHEN v_expansion_ct = 1 THEN 'is' ELSE 'are' END
    );
  END IF;

  IF v_consciousness IS NOT NULL AND v_consciousness.consciousness_level IN ('strained','critical','degraded') THEN
    v_parts := v_parts || format(
      'Operating consciousness is %s — %s.',
      v_consciousness.consciousness_level,
      COALESCE(v_consciousness.recommended_priority, 'review organizational capacity immediately')
    );
  END IF;

  v_narrative := array_to_string(v_parts, ' ');
  IF v_narrative = '' THEN
    v_narrative := 'Portfolio intelligence is building — check back after the first overnight compute cycle completes.';
  END IF;

  -- Upsert
  INSERT INTO public.crm_executive_digests (
    org_id, digest_date, digest_type,
    contact_count, worsening_count, improving_count,
    critical_escalations, high_churn_count, expansion_ready_count,
    new_high_churn_count, recovered_count,
    sections, narrative, generated_at, generated_by
  ) VALUES (
    p_org_id, CURRENT_DATE, p_digest_type,
    v_contact_count, v_worsening, v_improving,
    v_crit_esc_ct, v_high_churn_ct, v_expansion_ct,
    v_new_high_churn, v_recovered,
    v_sections, v_narrative, now(), p_actor_id
  )
  ON CONFLICT (org_id, digest_date, digest_type) DO UPDATE SET
    contact_count         = EXCLUDED.contact_count,
    worsening_count       = EXCLUDED.worsening_count,
    improving_count       = EXCLUDED.improving_count,
    critical_escalations  = EXCLUDED.critical_escalations,
    high_churn_count      = EXCLUDED.high_churn_count,
    expansion_ready_count = EXCLUDED.expansion_ready_count,
    new_high_churn_count  = EXCLUDED.new_high_churn_count,
    recovered_count       = EXCLUDED.recovered_count,
    sections              = EXCLUDED.sections,
    narrative             = EXCLUDED.narrative,
    generated_at          = EXCLUDED.generated_at,
    generated_by          = EXCLUDED.generated_by
  RETURNING id INTO v_digest_id;

  RETURN jsonb_build_object(
    'digest_id', v_digest_id,
    'digest_type', p_digest_type,
    'digest_date', CURRENT_DATE,
    'narrative', v_narrative,
    'contact_count', v_contact_count,
    'high_churn_count', v_high_churn_ct,
    'critical_escalations', v_crit_esc_ct,
    'expansion_ready_count', v_expansion_ct
  );
END;
$$;

-- ─── 3. get_crm_executive_digest ─────────────────────────────

CREATE OR REPLACE FUNCTION public.get_crm_executive_digest(
  p_org_id      UUID,
  p_digest_type TEXT DEFAULT 'daily',
  p_days        INT  DEFAULT 7
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current JSONB;
  v_trend   JSONB;
BEGIN
  SELECT to_jsonb(d.*) INTO v_current
  FROM public.crm_executive_digests d
  WHERE d.org_id = p_org_id AND d.digest_type = p_digest_type
  ORDER BY d.digest_date DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'digest_date', d.digest_date,
      'worsening_count', d.worsening_count,
      'improving_count', d.improving_count,
      'critical_escalations', d.critical_escalations,
      'high_churn_count', d.high_churn_count,
      'expansion_ready_count', d.expansion_ready_count,
      'narrative', d.narrative
    ) ORDER BY d.digest_date DESC
  ), '[]') INTO v_trend
  FROM public.crm_executive_digests d
  WHERE d.org_id = p_org_id
    AND d.digest_type = p_digest_type
    AND d.digest_date >= CURRENT_DATE - p_days;

  RETURN jsonb_build_object(
    'current', COALESCE(v_current, 'null'::JSONB),
    'trend', v_trend
  );
END;
$$;

-- ─── 4. crm_decision_reviews ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_decision_reviews (
  id                               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                           UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id                       UUID        REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  actor_user_id                    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_type                    TEXT        NOT NULL CHECK (decision_type IN (
    'escalation_dismiss','escalation_resolve','escalation_create_manual',
    'churn_assumed','intervention_chosen','merge_approved',
    'suppression_override','tier_change'
  )),
  decision_made_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_data                    JSONB       NOT NULL DEFAULT '{}',
  churn_probability_at_decision    INT,
  expansion_probability_at_decision INT,
  relationship_state_at_decision   TEXT,
  trust_state_at_decision          TEXT,
  outcome_evaluated_at             TIMESTAMPTZ,
  outcome_data                     JSONB,
  decision_quality_score           INT         CHECK (decision_quality_score BETWEEN 0 AND 100),
  quality_rating                   TEXT        CHECK (quality_rating IN ('excellent','good','acceptable','poor','harmful')),
  is_false_urgency                 BOOLEAN     NOT NULL DEFAULT FALSE,
  is_missed_window                 BOOLEAN     NOT NULL DEFAULT FALSE,
  is_premature_churn_assumption    BOOLEAN     NOT NULL DEFAULT FALSE,
  is_over_escalation               BOOLEAN     NOT NULL DEFAULT FALSE,
  is_underreaction                 BOOLEAN     NOT NULL DEFAULT FALSE,
  evaluation_notes                 TEXT
);

ALTER TABLE public.crm_decision_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_decisions" ON public.crm_decision_reviews;
CREATE POLICY "org_members_read_decisions" ON public.crm_decision_reviews
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = crm_decision_reviews.org_id
        AND om.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_crm_decision_reviews_org_date
  ON public.crm_decision_reviews (org_id, decision_made_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_decision_reviews_actor
  ON public.crm_decision_reviews (org_id, actor_user_id, decision_made_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_decision_reviews_unevaluated
  ON public.crm_decision_reviews (org_id, decision_made_at)
  WHERE outcome_evaluated_at IS NULL;

-- ─── 5. crm_operator_decision_quality ────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_operator_decision_quality (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id                     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  computed_date               DATE        NOT NULL DEFAULT CURRENT_DATE,
  total_decisions             INT         NOT NULL DEFAULT 0,
  evaluated_decisions         INT         NOT NULL DEFAULT 0,
  avg_quality_score           INT,
  judgment_calibration_score  INT         NOT NULL DEFAULT 50
                                          CHECK (judgment_calibration_score BETWEEN 0 AND 100),
  calibration_tier            TEXT        NOT NULL DEFAULT 'building'
                                          CHECK (calibration_tier IN ('building','developing','proficient','expert')),
  false_urgency_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  missed_window_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  premature_churn_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
  over_escalation_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
  excellent_rate              NUMERIC(5,2) NOT NULL DEFAULT 0,
  poor_harmful_rate           NUMERIC(5,2) NOT NULL DEFAULT 0,
  UNIQUE (org_id, user_id, computed_date)
);

ALTER TABLE public.crm_operator_decision_quality ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_odq" ON public.crm_operator_decision_quality;
CREATE POLICY "org_members_read_odq" ON public.crm_operator_decision_quality
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = crm_operator_decision_quality.org_id
        AND om.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_crm_odq_org_date
  ON public.crm_operator_decision_quality (org_id, computed_date DESC);

-- ─── 6. log_crm_decision_review ──────────────────────────────

CREATE OR REPLACE FUNCTION public.log_crm_decision_review(
  p_org_id        UUID,
  p_contact_id    UUID,
  p_decision_type TEXT,
  p_actor_user_id UUID  DEFAULT NULL,
  p_decision_data JSONB DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_churn     INT;
  v_expansion INT;
  v_rel_state TEXT;
  v_trust     TEXT;
  v_id        UUID;
BEGIN
  SELECT ps.churn_probability, ps.expansion_probability, c.relationship_state, c.trust_state
  INTO v_churn, v_expansion, v_rel_state, v_trust
  FROM public.crm_contacts c
  LEFT JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
  WHERE c.id = p_contact_id AND c.org_id = p_org_id;

  INSERT INTO public.crm_decision_reviews (
    org_id, contact_id, actor_user_id, decision_type,
    decision_made_at, decision_data,
    churn_probability_at_decision, expansion_probability_at_decision,
    relationship_state_at_decision, trust_state_at_decision
  ) VALUES (
    p_org_id, p_contact_id,
    COALESCE(p_actor_user_id, auth.uid()),
    p_decision_type, now(), p_decision_data,
    v_churn, v_expansion, v_rel_state, v_trust
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ─── 7. evaluate_crm_decision_outcomes ───────────────────────

CREATE OR REPLACE FUNCTION public.evaluate_crm_decision_outcomes(
  p_org_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec            RECORD;
  v_curr_churn     INT;
  v_curr_state     TEXT;
  v_score          INT;
  v_rating         TEXT;
  v_false_urgency  BOOLEAN;
  v_missed_window  BOOLEAN;
  v_premature      BOOLEAN;
  v_over_esc       BOOLEAN;
  v_underreaction  BOOLEAN;
  v_notes          TEXT;
  v_evaluated      INT := 0;
BEGIN
  FOR v_rec IN
    SELECT dr.*
    FROM public.crm_decision_reviews dr
    WHERE dr.org_id = p_org_id
      AND dr.outcome_evaluated_at IS NULL
      AND dr.decision_made_at <= now() - INTERVAL '30 days'
      AND dr.contact_id IS NOT NULL
    LIMIT 100
  LOOP
    SELECT ps.churn_probability, c.relationship_state
    INTO v_curr_churn, v_curr_state
    FROM public.crm_contacts c
    LEFT JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    WHERE c.id = v_rec.contact_id;

    v_false_urgency := FALSE; v_missed_window := FALSE;
    v_premature     := FALSE; v_over_esc      := FALSE;
    v_underreaction := FALSE;

    CASE v_rec.decision_type
      WHEN 'escalation_dismiss' THEN
        IF COALESCE(v_rec.churn_probability_at_decision, 0) >= 60
           AND COALESCE(v_curr_churn, 0) >= 80
           AND COALESCE(v_curr_state, '') IN ('churned','at_risk') THEN
          v_missed_window := TRUE;
          v_score := 15; v_rating := 'poor';
          v_notes := 'Dismissed escalation for high-churn contact — contact subsequently deteriorated.';
        ELSIF COALESCE(v_rec.churn_probability_at_decision, 0) >= 60
              AND COALESCE(v_curr_churn, 0) < 40 THEN
          v_score := 70; v_rating := 'acceptable';
          v_notes := 'Dismissed escalation — churn risk subsided.';
        ELSIF COALESCE(v_rec.churn_probability_at_decision, 0) < 40
              AND COALESCE(v_curr_churn, 0) >= 70 THEN
          v_underreaction := TRUE;
          v_score := 30; v_rating := 'poor';
          v_notes := 'Dismissed low-risk escalation — contact churn risk has since risen significantly.';
        ELSE
          v_score := 60; v_rating := 'acceptable';
          v_notes := 'Escalation dismissed; contact trajectory neutral.';
        END IF;

      WHEN 'escalation_resolve', 'intervention_chosen' THEN
        IF COALESCE(v_rec.churn_probability_at_decision, 0) >= 60
           AND COALESCE(v_curr_churn, 0) < 40 THEN
          v_score := 90; v_rating := 'excellent';
          v_notes := 'Resolved escalation — contact churn risk significantly reduced.';
        ELSIF COALESCE(v_rec.churn_probability_at_decision, 0) >= 60
              AND COALESCE(v_curr_churn, 0) >= 70 THEN
          v_score := 40; v_rating := 'acceptable';
          v_notes := 'Escalation resolved but churn risk remains elevated.';
        ELSE
          v_score := 75; v_rating := 'good';
          v_notes := 'Escalation resolved — contact state stable.';
        END IF;

      WHEN 'escalation_create_manual' THEN
        IF COALESCE((v_rec.decision_data->>'priority'), '') IN ('critical','high')
           AND COALESCE(v_curr_churn, 0) <= 20
           AND COALESCE(v_curr_state, '') IN ('active','loyal') THEN
          v_false_urgency := TRUE; v_over_esc := TRUE;
          v_score := 35; v_rating := 'poor';
          v_notes := 'Created critical/high escalation — contact showed no deterioration (possible false urgency).';
        ELSIF COALESCE(v_curr_churn, 0) >= 70 THEN
          v_score := 85; v_rating := 'excellent';
          v_notes := 'Proactively escalated — contact does show high churn risk.';
        ELSE
          v_score := 65; v_rating := 'good';
          v_notes := 'Manual escalation — outcome within expected range.';
        END IF;

      WHEN 'churn_assumed' THEN
        IF COALESCE(v_curr_state, '') IN ('loyal','active')
           AND COALESCE(v_curr_churn, 100) < 30 THEN
          v_premature := TRUE;
          v_score := 25; v_rating := 'poor';
          v_notes := 'Churn was assumed, but contact appears healthy 30 days later.';
        ELSIF COALESCE(v_curr_state, '') IN ('churned','at_risk')
              AND COALESCE(v_curr_churn, 0) >= 70 THEN
          v_score := 85; v_rating := 'excellent';
          v_notes := 'Churn assumption confirmed.';
        ELSE
          v_score := 55; v_rating := 'acceptable';
          v_notes := 'Churn assumption — contact state mixed.';
        END IF;

      ELSE
        v_score := 65; v_rating := 'acceptable';
        v_notes := 'Decision evaluated — outcome within normal parameters.';
    END CASE;

    UPDATE public.crm_decision_reviews SET
      outcome_evaluated_at          = now(),
      outcome_data                  = jsonb_build_object(
        'churn_probability_current', v_curr_churn,
        'relationship_state_current', v_curr_state
      ),
      decision_quality_score        = v_score,
      quality_rating                = v_rating,
      is_false_urgency              = v_false_urgency,
      is_missed_window              = v_missed_window,
      is_premature_churn_assumption = v_premature,
      is_over_escalation            = v_over_esc,
      is_underreaction              = v_underreaction,
      evaluation_notes              = v_notes
    WHERE id = v_rec.id;

    v_evaluated := v_evaluated + 1;
  END LOOP;

  RETURN v_evaluated;
END;
$$;

-- ─── 8. compute_crm_decision_quality ─────────────────────────

CREATE OR REPLACE FUNCTION public.compute_crm_decision_quality(
  p_org_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH stats AS (
    SELECT
      dr.actor_user_id,
      COUNT(*)::INT AS total_decisions,
      COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL)::INT AS evaluated_decisions,
      AVG(dr.decision_quality_score) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL)::INT AS avg_quality,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.quality_rating = 'excellent') /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS excellent_rate,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.quality_rating IN ('poor','harmful')) /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS poor_harmful_rate,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.is_missed_window) /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS missed_window_rate,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.is_false_urgency) /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS false_urgency_rate,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.is_premature_churn_assumption) /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS premature_churn_rate,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE dr.is_over_escalation) /
        NULLIF(COUNT(*) FILTER (WHERE dr.outcome_evaluated_at IS NOT NULL), 0), 2), 0) AS over_escalation_rate
    FROM public.crm_decision_reviews dr
    WHERE dr.org_id = p_org_id
      AND dr.actor_user_id IS NOT NULL
      AND dr.decision_made_at >= now() - INTERVAL '90 days'
    GROUP BY dr.actor_user_id
  ),
  calibrated AS (
    SELECT *,
      GREATEST(0, LEAST(100,
        50
        + excellent_rate * 0.4
        - poor_harmful_rate * 0.5
        - missed_window_rate * 0.6
        - false_urgency_rate * 0.4
        - premature_churn_rate * 0.3
        + CASE WHEN evaluated_decisions >= 10 THEN 5 ELSE 0 END
      ))::INT AS calibration_score
    FROM stats
  )
  INSERT INTO public.crm_operator_decision_quality (
    org_id, user_id, computed_date,
    total_decisions, evaluated_decisions, avg_quality_score,
    judgment_calibration_score, calibration_tier,
    false_urgency_rate, missed_window_rate, premature_churn_rate,
    over_escalation_rate, excellent_rate, poor_harmful_rate
  )
  SELECT
    p_org_id,
    actor_user_id,
    CURRENT_DATE,
    total_decisions,
    evaluated_decisions,
    avg_quality,
    calibration_score,
    CASE
      WHEN evaluated_decisions < 5   THEN 'building'
      WHEN calibration_score  >= 75  THEN 'expert'
      WHEN calibration_score  >= 60  THEN 'proficient'
      WHEN calibration_score  >= 45  THEN 'developing'
      ELSE 'building'
    END,
    false_urgency_rate,
    missed_window_rate,
    premature_churn_rate,
    over_escalation_rate,
    excellent_rate,
    poor_harmful_rate
  FROM calibrated
  ON CONFLICT (org_id, user_id, computed_date) DO UPDATE SET
    total_decisions            = EXCLUDED.total_decisions,
    evaluated_decisions        = EXCLUDED.evaluated_decisions,
    avg_quality_score          = EXCLUDED.avg_quality_score,
    judgment_calibration_score = EXCLUDED.judgment_calibration_score,
    calibration_tier           = EXCLUDED.calibration_tier,
    false_urgency_rate         = EXCLUDED.false_urgency_rate,
    missed_window_rate         = EXCLUDED.missed_window_rate,
    premature_churn_rate       = EXCLUDED.premature_churn_rate,
    over_escalation_rate       = EXCLUDED.over_escalation_rate,
    excellent_rate             = EXCLUDED.excellent_rate,
    poor_harmful_rate          = EXCLUDED.poor_harmful_rate;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─── 9. get_crm_decision_quality ─────────────────────────────

CREATE OR REPLACE FUNCTION public.get_crm_decision_quality(
  p_org_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operators   JSONB;
  v_recent      JSONB;
  v_org_summary JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'user_id', odq.user_id,
      'full_name', p.full_name,
      'email', p.email,
      'total_decisions', odq.total_decisions,
      'evaluated_decisions', odq.evaluated_decisions,
      'avg_quality_score', odq.avg_quality_score,
      'judgment_calibration_score', odq.judgment_calibration_score,
      'calibration_tier', odq.calibration_tier,
      'false_urgency_rate', odq.false_urgency_rate,
      'missed_window_rate', odq.missed_window_rate,
      'poor_harmful_rate', odq.poor_harmful_rate,
      'excellent_rate', odq.excellent_rate
    ) ORDER BY odq.judgment_calibration_score DESC
  ), '[]') INTO v_operators
  FROM (
    SELECT DISTINCT ON (odq.user_id) odq.*
    FROM public.crm_operator_decision_quality odq
    WHERE odq.org_id = p_org_id
    ORDER BY odq.user_id, odq.computed_date DESC
  ) odq
  LEFT JOIN public.profiles p ON p.id = odq.user_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'decision_id', dr.id,
      'contact_name', c.name,
      'contact_company', c.company,
      'decision_type', dr.decision_type,
      'decision_made_at', dr.decision_made_at,
      'quality_rating', dr.quality_rating,
      'decision_quality_score', dr.decision_quality_score,
      'is_false_urgency', dr.is_false_urgency,
      'is_missed_window', dr.is_missed_window,
      'evaluation_notes', dr.evaluation_notes,
      'actor_name', p.full_name
    ) ORDER BY dr.decision_made_at DESC
  ), '[]') INTO v_recent
  FROM (
    SELECT * FROM public.crm_decision_reviews
    WHERE org_id = p_org_id AND outcome_evaluated_at IS NOT NULL
    ORDER BY decision_made_at DESC LIMIT 30
  ) dr
  LEFT JOIN public.crm_contacts c ON c.id = dr.contact_id
  LEFT JOIN public.profiles p ON p.id = dr.actor_user_id;

  SELECT jsonb_build_object(
    'total_decisions', COUNT(*),
    'evaluated_decisions', COUNT(*) FILTER (WHERE outcome_evaluated_at IS NOT NULL),
    'pending_evaluation', COUNT(*) FILTER (
      WHERE outcome_evaluated_at IS NULL
        AND decision_made_at <= now() - INTERVAL '30 days'
    ),
    'avg_quality_score', AVG(decision_quality_score) FILTER (
      WHERE outcome_evaluated_at IS NOT NULL
    )::INT,
    'false_urgency_count', COUNT(*) FILTER (WHERE is_false_urgency),
    'missed_window_count', COUNT(*) FILTER (WHERE is_missed_window),
    'excellent_count', COUNT(*) FILTER (WHERE quality_rating = 'excellent'),
    'poor_harmful_count', COUNT(*) FILTER (WHERE quality_rating IN ('poor','harmful'))
  ) INTO v_org_summary
  FROM public.crm_decision_reviews
  WHERE org_id = p_org_id
    AND decision_made_at >= now() - INTERVAL '90 days';

  RETURN jsonb_build_object(
    'org_summary', v_org_summary,
    'operators', v_operators,
    'recent_reviews', v_recent
  );
END;
$$;

-- ─── 10. compute_crm_sprintB_nightly ─────────────────────────

CREATE OR REPLACE FUNCTION public.compute_crm_sprintB_nightly(
  p_org_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.evaluate_crm_decision_outcomes(p_org_id);
  PERFORM public.compute_crm_decision_quality(p_org_id);
  PERFORM public.generate_crm_executive_digest(p_org_id, 'daily');
  IF EXTRACT(DOW FROM CURRENT_DATE) = 0 THEN
    PERFORM public.generate_crm_executive_digest(p_org_id, 'weekly');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'compute_crm_sprintB_nightly failed for org %: %', p_org_id, SQLERRM;
END;
$$;

-- ─── 11. pg_cron (45 8 UTC — after consciousness at 30 8) ────

SELECT cron.schedule(
  'crm-sprintB-nightly',
  '45 8 * * *',
  $$
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT DISTINCT org_id FROM public.crm_contacts
        WHERE org_id IN (SELECT id FROM public.organizations WHERE cancellation_status IS NULL)
      LOOP
        PERFORM public.compute_crm_sprintB_nightly(r.org_id);
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  $$
);

-- ─── 12. Initial seed ─────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT org_id FROM public.crm_contacts
    WHERE org_id IN (SELECT id FROM public.organizations WHERE cancellation_status IS NULL)
  LOOP
    BEGIN
      PERFORM public.generate_crm_executive_digest(r.org_id, 'daily');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Initial digest failed for org %: %', r.org_id, SQLERRM;
    END;
  END LOOP;
END;
$$;
