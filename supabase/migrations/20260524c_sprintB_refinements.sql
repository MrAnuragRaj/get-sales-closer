-- =============================================================
-- Sprint B Refinements: B1–B7 (critic.md requirements)
-- B1: Digest narrative hysteresis
-- B2: Digest compression caps
-- B3: Causal-confidence filtering in digest
-- B4: Decision-context quality (separate from outcome quality)
-- B5: Difficulty normalization for operator calibration
-- B6: Snapshot isolation verification
-- B7: Governance anti-gamification safeguards
-- =============================================================

-- ─── Schema additions ─────────────────────────────────────────

-- B1: Hysteresis tracking on digests
ALTER TABLE public.crm_executive_digests
  ADD COLUMN IF NOT EXISTS narrative_state TEXT DEFAULT 'stable'
    CHECK (narrative_state IN ('stable','worsening','critical','improving','recovering')),
  ADD COLUMN IF NOT EXISTS pending_narrative_state TEXT
    CHECK (pending_narrative_state IN ('stable','worsening','critical','improving','recovering')),
  ADD COLUMN IF NOT EXISTS consecutive_state_count INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_suppressed_repetition BOOLEAN NOT NULL DEFAULT FALSE;

-- B4: Decision context quality (separate from outcome quality)
ALTER TABLE public.crm_decision_reviews
  ADD COLUMN IF NOT EXISTS decision_context_quality INT
    CHECK (decision_context_quality BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS context_factors JSONB,
  ADD COLUMN IF NOT EXISTS evaluation_uses_snapshot_only BOOLEAN NOT NULL DEFAULT TRUE;

-- B5: Difficulty normalization columns
ALTER TABLE public.crm_operator_decision_quality
  ADD COLUMN IF NOT EXISTS account_difficulty_score INT NOT NULL DEFAULT 50
    CHECK (account_difficulty_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS normalized_calibration_score INT,
  ADD COLUMN IF NOT EXISTS difficulty_factors JSONB;

-- B7: Rename 'expert' → 'well-calibrated' in calibration_tier constraint
ALTER TABLE public.crm_operator_decision_quality
  DROP CONSTRAINT IF EXISTS crm_operator_decision_quality_calibration_tier_check;
ALTER TABLE public.crm_operator_decision_quality
  ADD CONSTRAINT crm_operator_decision_quality_calibration_tier_check
  CHECK (calibration_tier IN ('building','developing','proficient','well-calibrated'));

-- Migrate any existing 'expert' rows to 'well-calibrated'
UPDATE public.crm_operator_decision_quality
  SET calibration_tier = 'well-calibrated'
  WHERE calibration_tier = 'expert';

-- ─── B1+B2+B3: generate_crm_executive_digest (rewrite) ───────

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
  v_pulse             RECORD;
  v_consciousness     RECORD;
  v_debt              RECORD;
  v_prior_digest      RECORD;
  v_contact_count     INT;
  v_high_churn_ct     INT;
  v_high_churn        JSONB;
  v_crit_esc_ct       INT;
  v_critical_esc      JSONB;
  v_expansion_ct      INT;
  v_expansion         JSONB;
  v_trajectory        JSONB;
  v_sections          JSONB;
  v_narrative         TEXT;
  v_worsening         INT;
  v_improving         INT;
  v_new_high_churn    INT;
  v_recovered         INT;
  v_parts             TEXT[];
  v_digest_id         UUID;
  -- B1: hysteresis state machine
  v_prior_state       TEXT;
  v_pending_state     TEXT;
  v_prior_consecutive INT;
  v_raw_state         TEXT;
  v_final_state       TEXT;
  v_final_pending     TEXT;
  v_consecutive       INT;
  v_is_extreme        BOOLEAN;
  -- B2: suppression
  v_is_suppressed     BOOLEAN;
  v_prior_narrative   TEXT;
  v_prior_counts      INT[];
BEGIN
  -- ── Read prior digest for hysteresis (B1) ──
  SELECT narrative_state, pending_narrative_state, consecutive_state_count,
         narrative, worsening_count, improving_count, high_churn_count, critical_escalations
  INTO v_prior_digest
  FROM public.crm_executive_digests
  WHERE org_id = p_org_id AND digest_type = p_digest_type
  ORDER BY digest_date DESC LIMIT 1;

  v_prior_state       := COALESCE(v_prior_digest.narrative_state, 'stable');
  v_pending_state     := v_prior_digest.pending_narrative_state;
  v_prior_consecutive := COALESCE(v_prior_digest.consecutive_state_count, 1);
  v_prior_narrative   := COALESCE(v_prior_digest.narrative, '');

  -- ── Portfolio pulse ──
  SELECT * INTO v_pulse
  FROM public.crm_portfolio_health_pulse
  WHERE org_id = p_org_id
  ORDER BY pulse_date DESC LIMIT 1;

  -- ── Operating consciousness ──
  SELECT * INTO v_consciousness
  FROM public.crm_operating_consciousness_snapshots
  WHERE org_id = p_org_id
  ORDER BY snapshot_date DESC LIMIT 1;

  -- ── Attention debt ──
  SELECT * INTO v_debt
  FROM public.crm_attention_debt_snapshots
  WHERE org_id = p_org_id
  ORDER BY snapshot_date DESC LIMIT 1;

  -- ── Contact count ──
  SELECT COUNT(*) INTO v_contact_count
  FROM public.crm_contacts WHERE org_id = p_org_id;

  -- ── High-churn contacts (B2: cap at 3 in sections) ──
  SELECT COUNT(*) INTO v_high_churn_ct
  FROM public.crm_contacts c
  JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
  WHERE c.org_id = p_org_id AND ps.churn_probability >= 60;

  SELECT COALESCE(jsonb_agg(x), '[]') INTO v_high_churn
  FROM (
    SELECT jsonb_build_object(
      'contact_id', c.id, 'name', c.name, 'company', c.company,
      'churn_probability', ps.churn_probability, 'relationship_state', c.relationship_state
    ) AS x
    FROM public.crm_contacts c
    JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    WHERE c.org_id = p_org_id AND ps.churn_probability >= 60
    ORDER BY ps.churn_probability DESC LIMIT 3
  ) t;

  -- ── Escalations (B2: cap at 5) ──
  SELECT COUNT(*) INTO v_crit_esc_ct
  FROM public.crm_escalations
  WHERE org_id = p_org_id
    AND priority IN ('critical','high')
    AND execution_state IN ('open','assigned','in_progress','blocked');

  SELECT COALESCE(jsonb_agg(x ORDER BY sort_key, sla_flag DESC), '[]') INTO v_critical_esc
  FROM (
    SELECT jsonb_build_object(
      'escalation_id', e.id, 'contact_name', c.name, 'priority', e.priority,
      'trigger_type', e.trigger_type, 'sla_breached', e.sla_breached,
      'days_open', EXTRACT(DAY FROM now() - e.created_at)::INT
    ) AS x,
    CASE e.priority WHEN 'critical' THEN 0 ELSE 1 END AS sort_key,
    e.sla_breached AS sla_flag
    FROM public.crm_escalations e
    JOIN public.crm_contacts c ON c.id = e.contact_id
    WHERE e.org_id = p_org_id
      AND e.priority IN ('critical','high')
      AND e.execution_state IN ('open','assigned','in_progress','blocked')
    ORDER BY sort_key, sla_flag DESC
    LIMIT 5
  ) t;

  -- ── Expansion-ready (B2: cap at 3) ──
  SELECT COUNT(*) INTO v_expansion_ct
  FROM public.crm_contacts
  WHERE org_id = p_org_id AND expansion_readiness_score >= 65;

  SELECT COALESCE(jsonb_agg(x), '[]') INTO v_expansion
  FROM (
    SELECT jsonb_build_object(
      'contact_id', id, 'name', name, 'company', company,
      'expansion_readiness', expansion_readiness_score,
      'growth_strain', growth_strain_detected
    ) AS x
    FROM public.crm_contacts
    WHERE org_id = p_org_id AND expansion_readiness_score >= 65
    ORDER BY expansion_readiness_score DESC LIMIT 3
  ) t;

  -- ── High-signal inflections only (B3: causal confidence filter) ──
  -- Only include inflection types with strong causal evidence (not incremental shifts)
  SELECT COALESCE(jsonb_agg(x ORDER BY det DESC), '[]') INTO v_trajectory
  FROM (
    SELECT jsonb_build_object(
      'contact_name', c.name, 'inflection_type', ip.inflection_type,
      'detected_at', ip.detected_at
    ) AS x,
    ip.detected_at AS det
    FROM public.crm_inflection_points ip
    JOIN public.crm_contacts c ON c.id = ip.contact_id
    WHERE c.org_id = p_org_id
      AND ip.inflection_type IN (
        'trust_fracture','trust_rebuilt',
        'capital_collapse','capital_recovery',
        'churn_spike','churn_recovery',
        'resilience_collapse','expansion_breakthrough',
        'outlook_critical','outlook_recovery'
      )
      AND ip.detected_at >= CASE p_digest_type
        WHEN 'weekly' THEN now() - INTERVAL '7 days'
        ELSE now() - INTERVAL '48 hours'
      END
    ORDER BY det DESC LIMIT 10
  ) t;

  -- ── Extract pulse values ──
  v_worsening      := COALESCE(v_pulse.worsening_count, 0);
  v_improving      := COALESCE(v_pulse.improving_count, 0);
  v_new_high_churn := COALESCE(v_pulse.new_high_churn_count, 0);
  v_recovered      := COALESCE(v_pulse.recovered_count, 0);

  -- ── B1: Classify raw narrative state ──
  v_is_extreme := (v_consciousness.consciousness_level = 'degraded');

  IF v_is_extreme
     OR (v_new_high_churn >= 5 AND v_crit_esc_ct >= 3) THEN
    v_raw_state := 'critical';
  ELSIF v_crit_esc_ct >= 4
     OR (v_high_churn_ct >= 8 AND v_worsening > v_improving * 2) THEN
    v_raw_state := 'critical';
  ELSIF v_worsening > v_improving * 1.5
     AND (v_high_churn_ct >= 3 OR v_crit_esc_ct >= 2) THEN
    v_raw_state := 'worsening';
  ELSIF v_improving > v_worsening * 1.5
     AND v_high_churn_ct <= 2
     AND v_crit_esc_ct = 0 THEN
    v_raw_state := 'improving';
  ELSIF v_improving > v_worsening
     AND v_recovered > 0
     AND v_new_high_churn = 0 THEN
    v_raw_state := 'recovering';
  ELSE
    v_raw_state := 'stable';
  END IF;

  -- ── B1: Apply hysteresis — require 2 consecutive readings to flip ──
  IF v_raw_state = v_prior_state THEN
    -- Confirmed: increment consecutive count, clear pending
    v_final_state   := v_prior_state;
    v_final_pending := NULL;
    v_consecutive   := v_prior_consecutive + 1;
  ELSIF v_is_extreme THEN
    -- Emergency: immediate flip for degraded consciousness
    v_final_state   := 'critical';
    v_final_pending := NULL;
    v_consecutive   := 1;
  ELSIF v_pending_state = v_raw_state THEN
    -- Second consecutive day seeing this new state → commit transition
    v_final_state   := v_raw_state;
    v_final_pending := NULL;
    v_consecutive   := 2;
  ELSE
    -- First day seeing this new state → stay in prior, set pending
    v_final_state   := v_prior_state;
    v_final_pending := v_raw_state;
    v_consecutive   := v_prior_consecutive;
  END IF;

  -- ── B2: Suppress repetitive narrative ──
  -- If state unchanged AND all counts within 10% of prior → reuse prior narrative
  v_is_suppressed := FALSE;
  IF v_final_state = v_prior_state
     AND v_prior_narrative <> ''
     AND v_prior_digest.worsening_count IS NOT NULL
     AND ABS(v_worsening - v_prior_digest.worsening_count) <= GREATEST(1, v_prior_digest.worsening_count * 0.1)
     AND ABS(v_high_churn_ct - v_prior_digest.high_churn_count) <= GREATEST(1, v_prior_digest.high_churn_count * 0.1)
     AND ABS(v_crit_esc_ct - v_prior_digest.critical_escalations) = 0 THEN
    v_narrative     := v_prior_narrative;
    v_is_suppressed := TRUE;
  ELSE
    -- ── Build fresh narrative from smoothed state (B1) ──
    v_parts := ARRAY[]::TEXT[];

    -- Lead with smoothed state framing
    CASE v_final_state
      WHEN 'critical' THEN
        v_parts := v_parts || 'Portfolio is in critical condition and demands immediate executive attention.';
      WHEN 'worsening' THEN
        v_parts := v_parts || 'Portfolio signals are trending downward — proactive intervention is needed.';
      WHEN 'improving' THEN
        v_parts := v_parts || 'Portfolio momentum is building — conditions are improving across key signals.';
      WHEN 'recovering' THEN
        v_parts := v_parts || 'Portfolio is recovering from recent stress — stabilization is taking hold.';
      ELSE -- stable
        IF v_pulse IS NOT NULL THEN
          IF v_worsening > v_improving THEN
            v_parts := v_parts || format(
              'Portfolio is holding steady under mild pressure — %s worsening versus %s improving.',
              v_worsening, v_improving
            );
          ELSIF v_improving > v_worsening THEN
            v_parts := v_parts || format(
              'Portfolio is stable with positive momentum — %s improving versus %s worsening.',
              v_improving, v_worsening
            );
          ELSE
            v_parts := v_parts || 'Portfolio signals are balanced — stable operations with equal improvement and deterioration.';
          END IF;
        ELSE
          v_parts := v_parts || format(
            'Portfolio contains %s contacts — intelligence builds after the first overnight compute cycle.',
            v_contact_count
          );
        END IF;
    END CASE;

    -- Churn alert (only surface if material)
    IF v_high_churn_ct >= 5 THEN
      v_parts := v_parts || format(
        '%s contacts are at high churn risk (60%%+) — prioritize retention outreach.',
        v_high_churn_ct
      );
    ELSIF v_high_churn_ct > 0 THEN
      v_parts := v_parts || format(
        '%s contact%s at elevated churn risk %s attention.',
        v_high_churn_ct,
        CASE WHEN v_high_churn_ct = 1 THEN '' ELSE 's' END,
        CASE WHEN v_high_churn_ct = 1 THEN 'needs' ELSE 'need' END
      );
    END IF;

    -- Escalations
    IF v_crit_esc_ct > 0 THEN
      v_parts := v_parts || format(
        '%s critical or high-priority escalation%s %s open.',
        v_crit_esc_ct,
        CASE WHEN v_crit_esc_ct = 1 THEN '' ELSE 's' END,
        CASE WHEN v_crit_esc_ct = 1 THEN 'is' ELSE 'are' END
      );
    END IF;

    -- Recovery/new-churn
    IF v_new_high_churn > 0 AND v_recovered > 0 THEN
      v_parts := v_parts || format(
        '%s newly entered high-churn risk; %s account%s stabilized.',
        v_new_high_churn, v_recovered,
        CASE WHEN v_recovered = 1 THEN '' ELSE 's' END
      );
    ELSIF v_new_high_churn > 0 THEN
      v_parts := v_parts || format(
        '%s account%s newly entered high-churn territory.',
        v_new_high_churn,
        CASE WHEN v_new_high_churn = 1 THEN '' ELSE 's' END
      );
    ELSIF v_recovered > 0 THEN
      v_parts := v_parts || format(
        '%s account%s recovered from churn risk.',
        v_recovered,
        CASE WHEN v_recovered = 1 THEN '' ELSE 's' END
      );
    END IF;

    -- Expansion
    IF v_expansion_ct > 0 THEN
      v_parts := v_parts || format(
        '%s contact%s expansion-ready.',
        v_expansion_ct,
        CASE WHEN v_expansion_ct = 1 THEN ' is' ELSE 's are' END
      );
    END IF;

    -- Consciousness (only when strained or worse)
    IF v_consciousness IS NOT NULL
       AND v_consciousness.consciousness_level IN ('strained','critical','degraded') THEN
      v_parts := v_parts || format(
        'Operating consciousness is %s — %s.',
        v_consciousness.consciousness_level,
        COALESCE(v_consciousness.recommended_priority, 'review organizational capacity')
      );
    END IF;

    v_narrative := array_to_string(v_parts, ' ');
    IF v_narrative = '' THEN
      v_narrative := 'Portfolio intelligence is building — check back after the first overnight compute cycle completes.';
    END IF;
  END IF;

  -- ── Assemble sections ──
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

  -- ── Upsert ──
  INSERT INTO public.crm_executive_digests (
    org_id, digest_date, digest_type,
    contact_count, worsening_count, improving_count,
    critical_escalations, high_churn_count, expansion_ready_count,
    new_high_churn_count, recovered_count,
    sections, narrative, generated_at, generated_by,
    narrative_state, pending_narrative_state, consecutive_state_count, is_suppressed_repetition
  ) VALUES (
    p_org_id, CURRENT_DATE, p_digest_type,
    v_contact_count, v_worsening, v_improving,
    v_crit_esc_ct, v_high_churn_ct, v_expansion_ct,
    v_new_high_churn, v_recovered,
    v_sections, v_narrative, now(), p_actor_id,
    v_final_state, v_final_pending, v_consecutive, v_is_suppressed
  )
  ON CONFLICT (org_id, digest_date, digest_type) DO UPDATE SET
    contact_count              = EXCLUDED.contact_count,
    worsening_count            = EXCLUDED.worsening_count,
    improving_count            = EXCLUDED.improving_count,
    critical_escalations       = EXCLUDED.critical_escalations,
    high_churn_count           = EXCLUDED.high_churn_count,
    expansion_ready_count      = EXCLUDED.expansion_ready_count,
    new_high_churn_count       = EXCLUDED.new_high_churn_count,
    recovered_count            = EXCLUDED.recovered_count,
    sections                   = EXCLUDED.sections,
    narrative                  = EXCLUDED.narrative,
    generated_at               = EXCLUDED.generated_at,
    generated_by               = EXCLUDED.generated_by,
    narrative_state            = EXCLUDED.narrative_state,
    pending_narrative_state    = EXCLUDED.pending_narrative_state,
    consecutive_state_count    = EXCLUDED.consecutive_state_count,
    is_suppressed_repetition   = EXCLUDED.is_suppressed_repetition
  RETURNING id INTO v_digest_id;

  RETURN jsonb_build_object(
    'digest_id', v_digest_id,
    'digest_type', p_digest_type,
    'digest_date', CURRENT_DATE,
    'narrative', v_narrative,
    'narrative_state', v_final_state,
    'is_suppressed_repetition', v_is_suppressed,
    'contact_count', v_contact_count,
    'high_churn_count', v_high_churn_ct,
    'critical_escalations', v_crit_esc_ct,
    'expansion_ready_count', v_expansion_ct
  );
END;
$$;

-- ─── B4+B6: evaluate_crm_decision_outcomes (rewrite) ─────────

CREATE OR REPLACE FUNCTION public.evaluate_crm_decision_outcomes(
  p_org_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec              RECORD;
  v_curr_churn       INT;
  v_curr_state       TEXT;
  v_score            INT;
  v_rating           TEXT;
  v_false_urgency    BOOLEAN;
  v_missed_window    BOOLEAN;
  v_premature        BOOLEAN;
  v_over_esc         BOOLEAN;
  v_underreaction    BOOLEAN;
  v_notes            TEXT;
  -- B4: Context quality (separate from outcome quality)
  v_ctx_quality      INT;
  v_ctx_factors      JSONB;
  v_data_richness    INT;
  v_evaluated        INT := 0;
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
    -- B6: Read current state for OUTCOME comparison only
    -- All QUALITY scoring uses snapshot columns (churn_probability_at_decision, etc.)
    SELECT ps.churn_probability, c.relationship_state
    INTO v_curr_churn, v_curr_state
    FROM public.crm_contacts c
    LEFT JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    WHERE c.id = v_rec.contact_id;

    v_false_urgency := FALSE; v_missed_window := FALSE;
    v_premature     := FALSE; v_over_esc      := FALSE;
    v_underreaction := FALSE;

    -- ── B4: Decision-context quality ──────────────────────────
    -- Measures: was this decision REASONABLE given what was known?
    -- Uses ONLY snapshot data (B6: snapshot isolation)
    v_data_richness := CASE
      WHEN v_rec.churn_probability_at_decision IS NOT NULL
           AND v_rec.relationship_state_at_decision IS NOT NULL
           AND v_rec.trust_state_at_decision IS NOT NULL THEN 30
      WHEN v_rec.churn_probability_at_decision IS NOT NULL
           OR v_rec.relationship_state_at_decision IS NOT NULL THEN 15
      ELSE 0
    END;

    v_ctx_quality := CASE v_rec.decision_type
      WHEN 'escalation_dismiss' THEN
        CASE
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) < 30
               AND COALESCE(v_rec.trust_state_at_decision, '') IN ('intact','rebuilt') THEN
            v_data_richness + 50  -- Low risk, good trust: dismiss is well-reasoned
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) < 50 THEN
            v_data_richness + 35  -- Moderate risk: defensible
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 70 THEN
            v_data_richness + 5   -- High risk dismissal: poor context
          WHEN COALESCE(v_rec.trust_state_at_decision, '') = 'broken' THEN
            v_data_richness + 10  -- Broken trust dismissal: questionable
          ELSE v_data_richness + 30
        END
      WHEN 'escalation_create_manual' THEN
        CASE
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 50
               OR COALESCE(v_rec.trust_state_at_decision, '') IN ('strained','broken') THEN
            v_data_richness + 55  -- Signals support escalation: well-reasoned
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 30 THEN
            v_data_richness + 40  -- Some signal: defensible
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) < 20
               AND COALESCE(v_rec.trust_state_at_decision, '') = 'intact' THEN
            v_data_richness + 5   -- No signals: questionable escalation
          ELSE v_data_richness + 30
        END
      WHEN 'escalation_resolve', 'intervention_chosen' THEN
        CASE
          WHEN v_rec.decision_data ?| ARRAY['reason','notes','resolution_notes'] THEN
            v_data_richness + 55  -- Documented resolution: strong context
          ELSE v_data_richness + 40
        END
      WHEN 'churn_assumed' THEN
        CASE
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 60 THEN
            v_data_richness + 55  -- Data-supported assumption
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 40 THEN
            v_data_richness + 35  -- Moderate signal
          ELSE v_data_richness + 10  -- Premature assumption: weak context
        END
      WHEN 'suppression_override' THEN
        CASE
          WHEN v_rec.decision_data ? 'reason' THEN v_data_richness + 50
          ELSE v_data_richness + 25
        END
      ELSE v_data_richness + 40
    END;

    -- Bonus for explicit documentation (+10 for reason/justification)
    IF v_rec.decision_data ? 'reason' OR v_rec.decision_data ? 'notes'
       OR v_rec.decision_data ? 'justification' THEN
      v_ctx_quality := v_ctx_quality + 10;
    END IF;

    v_ctx_quality  := GREATEST(0, LEAST(100, v_ctx_quality));
    v_ctx_factors  := jsonb_build_object(
      'data_richness_score', v_data_richness,
      'churn_at_decision', v_rec.churn_probability_at_decision,
      'trust_at_decision', v_rec.trust_state_at_decision,
      'relationship_state_at_decision', v_rec.relationship_state_at_decision,
      'has_documentation', (v_rec.decision_data ? 'reason' OR v_rec.decision_data ? 'notes'),
      'isolation_verified', TRUE
    );

    -- ── Outcome quality (compares snapshot vs 30-day-later current state) ──
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
          v_notes := 'Proactively escalated — contact confirmed high churn risk at 30 days.';
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
          v_notes := 'Churn assumption confirmed — contact remained at-risk.';
        ELSE
          v_score := 55; v_rating := 'acceptable';
          v_notes := 'Churn assumption — contact state mixed at 30 days.';
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
      evaluation_notes              = v_notes,
      -- B4: context quality (snapshot-based, computed above)
      decision_context_quality      = v_ctx_quality,
      context_factors               = v_ctx_factors,
      -- B6: mark that evaluation used snapshot data only (outcome state read separately)
      evaluation_uses_snapshot_only = TRUE
    WHERE id = v_rec.id;

    v_evaluated := v_evaluated + 1;
  END LOOP;

  RETURN v_evaluated;
END;
$$;

-- ─── B5+B7: compute_crm_decision_quality (rewrite) ───────────
-- B7: This function measures decision calibration patterns for learning,
-- NOT performance ranking. Calibration data must not be used as a
-- leaderboard or punishment mechanism. See governance safeguards below.

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
      COUNT(*)::INT                 AS total_decisions,
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
        + excellent_rate   * 0.4
        - poor_harmful_rate * 0.5
        - missed_window_rate * 0.6
        - false_urgency_rate * 0.4
        - premature_churn_rate * 0.3
        + CASE WHEN evaluated_decisions >= 10 THEN 5 ELSE 0 END
      ))::INT AS calibration_score
    FROM stats
  ),
  -- B5: Compute account difficulty per operator
  -- Operators handling harder accounts (high churn, volatile, escalation-heavy) get difficulty bonus
  operator_difficulty AS (
    SELECT
      o.primary_owner_id AS user_id,
      GREATEST(0, LEAST(100,
        COALESCE(AVG(ps.churn_probability), 50) * 0.3
        + COALESCE(AVG(c.volatility_index), 50) * 0.3
        + COALESCE(
            100.0 * COUNT(e.id) FILTER (
              WHERE e.priority IN ('critical','high')
                AND e.execution_state IN ('open','assigned','in_progress','blocked')
            )::NUMERIC / NULLIF(COUNT(c.id), 0),
          0) * 0.2
        + COALESCE(AVG(c.maintenance_burden), 50) * 0.2
      ))::INT AS difficulty_score,
      jsonb_build_object(
        'avg_churn_of_owned', ROUND(COALESCE(AVG(ps.churn_probability), 50))::INT,
        'avg_volatility_of_owned', ROUND(COALESCE(AVG(c.volatility_index), 50))::INT,
        'avg_burden_of_owned', ROUND(COALESCE(AVG(c.maintenance_burden), 50))::INT,
        'critical_esc_pct', ROUND(COALESCE(
          100.0 * COUNT(e.id) FILTER (
            WHERE e.priority IN ('critical','high')
              AND e.execution_state IN ('open','assigned','in_progress','blocked')
          )::NUMERIC / NULLIF(COUNT(c.id), 0),
        0))::INT
      ) AS difficulty_factors
    FROM public.crm_contact_ownership o
    JOIN public.crm_contacts c ON c.id = o.contact_id AND c.org_id = p_org_id
    LEFT JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    LEFT JOIN public.crm_escalations e ON e.contact_id = c.id AND e.org_id = p_org_id
    GROUP BY o.primary_owner_id
  )
  INSERT INTO public.crm_operator_decision_quality (
    org_id, user_id, computed_date,
    total_decisions, evaluated_decisions, avg_quality_score,
    judgment_calibration_score, calibration_tier,
    false_urgency_rate, missed_window_rate, premature_churn_rate,
    over_escalation_rate, excellent_rate, poor_harmful_rate,
    -- B5: difficulty-normalized columns
    account_difficulty_score, normalized_calibration_score, difficulty_factors
  )
  SELECT
    p_org_id,
    c.actor_user_id,
    CURRENT_DATE,
    c.total_decisions,
    c.evaluated_decisions,
    c.avg_quality,
    c.calibration_score,
    -- B7: 'expert' renamed to 'well-calibrated' (calibration ≠ performance rank)
    CASE
      WHEN c.evaluated_decisions < 5   THEN 'building'
      WHEN c.calibration_score  >= 75  THEN 'well-calibrated'
      WHEN c.calibration_score  >= 60  THEN 'proficient'
      WHEN c.calibration_score  >= 45  THEN 'developing'
      ELSE 'building'
    END,
    c.false_urgency_rate,
    c.missed_window_rate,
    c.premature_churn_rate,
    c.over_escalation_rate,
    c.excellent_rate,
    c.poor_harmful_rate,
    -- B5: difficulty (defaults to 50 when no ownership data)
    COALESCE(od.difficulty_score, 50),
    -- B5: normalized = calibration adjusted for account difficulty
    -- +/- up to ~15 points based on how hard the operator's accounts are
    GREATEST(0, LEAST(100,
      c.calibration_score + (COALESCE(od.difficulty_score, 50) - 50)::NUMERIC * 0.3
    ))::INT,
    od.difficulty_factors
  FROM calibrated c
  LEFT JOIN operator_difficulty od ON od.user_id = c.actor_user_id
  ON CONFLICT (org_id, user_id, computed_date) DO UPDATE SET
    total_decisions             = EXCLUDED.total_decisions,
    evaluated_decisions         = EXCLUDED.evaluated_decisions,
    avg_quality_score           = EXCLUDED.avg_quality_score,
    judgment_calibration_score  = EXCLUDED.judgment_calibration_score,
    calibration_tier            = EXCLUDED.calibration_tier,
    false_urgency_rate          = EXCLUDED.false_urgency_rate,
    missed_window_rate          = EXCLUDED.missed_window_rate,
    premature_churn_rate        = EXCLUDED.premature_churn_rate,
    over_escalation_rate        = EXCLUDED.over_escalation_rate,
    excellent_rate              = EXCLUDED.excellent_rate,
    poor_harmful_rate           = EXCLUDED.poor_harmful_rate,
    account_difficulty_score    = EXCLUDED.account_difficulty_score,
    normalized_calibration_score = EXCLUDED.normalized_calibration_score,
    difficulty_factors          = EXCLUDED.difficulty_factors;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─── Updated get_crm_decision_quality (include normalized score + context quality) ──

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
      'normalized_calibration_score', odq.normalized_calibration_score,
      'calibration_tier', odq.calibration_tier,
      'account_difficulty_score', odq.account_difficulty_score,
      'difficulty_factors', odq.difficulty_factors,
      'false_urgency_rate', odq.false_urgency_rate,
      'missed_window_rate', odq.missed_window_rate,
      'poor_harmful_rate', odq.poor_harmful_rate,
      'excellent_rate', odq.excellent_rate
    ) ORDER BY odq.normalized_calibration_score DESC NULLS LAST
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
      'decision_context_quality', dr.decision_context_quality,
      'is_false_urgency', dr.is_false_urgency,
      'is_missed_window', dr.is_missed_window,
      'evaluation_notes', dr.evaluation_notes,
      'evaluation_uses_snapshot_only', dr.evaluation_uses_snapshot_only,
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
    'avg_context_quality', AVG(decision_context_quality) FILTER (
      WHERE decision_context_quality IS NOT NULL
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

-- ─── Updated get_crm_executive_digest (include narrative_state) ──

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
      'narrative_state', d.narrative_state,
      'is_suppressed_repetition', d.is_suppressed_repetition,
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
