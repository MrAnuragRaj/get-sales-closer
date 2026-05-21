-- Sprint B: Fix evaluate_crm_decision_outcomes
-- PostgreSQL simple CASE does not support comma-separated WHEN values
-- Split 'escalation_resolve', 'intervention_chosen' into two identical branches

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
    SELECT ps.churn_probability, c.relationship_state
    INTO v_curr_churn, v_curr_state
    FROM public.crm_contacts c
    LEFT JOIN public.crm_predictive_scores ps ON ps.contact_id = c.id
    WHERE c.id = v_rec.contact_id;

    v_false_urgency := FALSE; v_missed_window := FALSE;
    v_premature     := FALSE; v_over_esc      := FALSE;
    v_underreaction := FALSE;

    -- B4: Decision-context quality (snapshot-based only — B6)
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
               AND COALESCE(v_rec.trust_state_at_decision, '') IN ('intact','rebuilt')
            THEN v_data_richness + 50
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) < 50
            THEN v_data_richness + 35
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 70
            THEN v_data_richness + 5
          WHEN COALESCE(v_rec.trust_state_at_decision, '') = 'broken'
            THEN v_data_richness + 10
          ELSE v_data_richness + 30
        END
      WHEN 'escalation_create_manual' THEN
        CASE
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 50
               OR COALESCE(v_rec.trust_state_at_decision, '') IN ('strained','broken')
            THEN v_data_richness + 55
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 30
            THEN v_data_richness + 40
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) < 20
               AND COALESCE(v_rec.trust_state_at_decision, '') = 'intact'
            THEN v_data_richness + 5
          ELSE v_data_richness + 30
        END
      WHEN 'escalation_resolve' THEN
        CASE
          WHEN v_rec.decision_data ?| ARRAY['reason','notes','resolution_notes']
            THEN v_data_richness + 55
          ELSE v_data_richness + 40
        END
      WHEN 'intervention_chosen' THEN
        CASE
          WHEN v_rec.decision_data ?| ARRAY['reason','notes','resolution_notes']
            THEN v_data_richness + 55
          ELSE v_data_richness + 40
        END
      WHEN 'churn_assumed' THEN
        CASE
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 60
            THEN v_data_richness + 55
          WHEN COALESCE(v_rec.churn_probability_at_decision, 50) >= 40
            THEN v_data_richness + 35
          ELSE v_data_richness + 10
        END
      WHEN 'suppression_override' THEN
        CASE WHEN v_rec.decision_data ? 'reason' THEN v_data_richness + 50
             ELSE v_data_richness + 25 END
      ELSE v_data_richness + 40
    END;

    IF v_rec.decision_data ? 'reason' OR v_rec.decision_data ? 'notes'
       OR v_rec.decision_data ? 'justification' THEN
      v_ctx_quality := v_ctx_quality + 10;
    END IF;

    v_ctx_quality := GREATEST(0, LEAST(100, v_ctx_quality));
    v_ctx_factors := jsonb_build_object(
      'data_richness_score', v_data_richness,
      'churn_at_decision', v_rec.churn_probability_at_decision,
      'trust_at_decision', v_rec.trust_state_at_decision,
      'relationship_state_at_decision', v_rec.relationship_state_at_decision,
      'has_documentation', (v_rec.decision_data ? 'reason' OR v_rec.decision_data ? 'notes'),
      'isolation_verified', TRUE
    );

    -- Outcome quality scoring
    IF v_rec.decision_type = 'escalation_dismiss' THEN
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

    ELSIF v_rec.decision_type IN ('escalation_resolve', 'intervention_chosen') THEN
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

    ELSIF v_rec.decision_type = 'escalation_create_manual' THEN
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

    ELSIF v_rec.decision_type = 'churn_assumed' THEN
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
    END IF;

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
      decision_context_quality      = v_ctx_quality,
      context_factors               = v_ctx_factors,
      evaluation_uses_snapshot_only = TRUE
    WHERE id = v_rec.id;

    v_evaluated := v_evaluated + 1;
  END LOOP;

  RETURN v_evaluated;
END;
$$;
