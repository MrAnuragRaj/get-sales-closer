-- Sprint A: Governance Completion + Causal Accuracy Calibration
-- A1: Approval flows for merge, tier promotion, principle deletion
-- A2: Escalation visibility_scope
-- A3: Causal chain confidence bounds + verifiability

-- ─────────────────────────────────────────────────────────────────────────────
-- A1a. crm_merge_log — add approval columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.crm_merge_log
  ADD COLUMN IF NOT EXISTS approval_status  TEXT DEFAULT 'auto_approved'
    CHECK (approval_status IN ('auto_approved','pending_approval','approved','rejected')),
  ADD COLUMN IF NOT EXISTS approval_required_reason TEXT,
  ADD COLUMN IF NOT EXISTS approved_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS rejected_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_merge_log_approval
  ON public.crm_merge_log (org_id, approval_status) WHERE approval_status = 'pending_approval';

-- ─────────────────────────────────────────────────────────────────────────────
-- A1b. merge_crm_contacts_safe — gate on confidence < 70 → pending_approval
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.merge_crm_contacts_safe(UUID,UUID,UUID,TEXT,INT,TEXT);
CREATE OR REPLACE FUNCTION public.merge_crm_contacts_safe(
  p_org_id           UUID,
  p_primary_id       UUID,
  p_secondary_id     UUID,
  p_conflict_type    TEXT DEFAULT NULL,
  p_merge_confidence INT  DEFAULT NULL,
  p_reason           TEXT DEFAULT 'manual'
)
RETURNS JSONB   -- { log_id, status: 'executed'|'pending_approval' }
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary        crm_contacts%ROWTYPE;
  v_secondary      crm_contacts%ROWTYPE;
  v_log_id         UUID;
  v_activity_ids   UUID[];
  v_note_ids       UUID[];
  v_task_ids       UUID[];
  v_lc_ids         UUID[];
  v_needs_approval BOOLEAN;
  v_approval_reason TEXT;
BEGIN
  SELECT * INTO v_primary   FROM crm_contacts WHERE id = p_primary_id   AND org_id = p_org_id;
  SELECT * INTO v_secondary FROM crm_contacts WHERE id = p_secondary_id AND org_id = p_org_id;

  IF v_primary.id IS NULL OR v_secondary.id IS NULL THEN
    RAISE EXCEPTION 'contacts_not_found_or_wrong_org';
  END IF;

  IF v_primary.is_merge_protected THEN
    RAISE EXCEPTION 'merge_blocked_target_protected';
  END IF;
  IF v_secondary.is_merge_protected THEN
    RAISE EXCEPTION 'merge_blocked_source_protected';
  END IF;

  -- Determine if approval is needed
  v_needs_approval := FALSE;
  IF COALESCE(p_merge_confidence, 100) < 70 THEN
    v_needs_approval := TRUE;
    v_approval_reason := 'merge_confidence_' || COALESCE(p_merge_confidence::TEXT, 'unknown') || '_below_70_threshold';
  END IF;
  -- Strategic contacts always require approval
  IF v_primary.strategic_tier IN ('flagship','anchor','strategic_logo','investor_visible') OR
     v_secondary.strategic_tier IN ('flagship','anchor','strategic_logo','investor_visible') THEN
    v_needs_approval := TRUE;
    v_approval_reason := COALESCE(v_approval_reason || '; ', '') || 'strategic_tier_contact_involved';
  END IF;

  -- Capture IDs of records belonging to secondary
  SELECT ARRAY_AGG(id) INTO v_activity_ids FROM crm_activities WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_note_ids     FROM crm_notes     WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_task_ids     FROM crm_tasks     WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_lc_ids       FROM crm_lifecycle_changes WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  INSERT INTO crm_merge_log (
    org_id, source_contact_id, target_contact_id,
    conflict_type, merge_confidence, merge_reason, is_reversible,
    source_contact_snapshot, primary_pre_merge_snapshot, merged_record_ids,
    merged_by,
    approval_status, approval_required_reason
  ) VALUES (
    p_org_id, p_secondary_id, p_primary_id,
    p_conflict_type, p_merge_confidence, p_reason, true,
    to_jsonb(v_secondary),
    jsonb_build_object(
      'email', v_primary.email, 'phone', v_primary.phone,
      'company', v_primary.company, 'title', v_primary.title,
      'strategic_tier', v_primary.strategic_tier
    ),
    jsonb_build_object(
      'activities', COALESCE(to_jsonb(v_activity_ids), '[]'::jsonb),
      'notes',      COALESCE(to_jsonb(v_note_ids),     '[]'::jsonb),
      'tasks',      COALESCE(to_jsonb(v_task_ids),     '[]'::jsonb),
      'lifecycles', COALESCE(to_jsonb(v_lc_ids),       '[]'::jsonb)
    ),
    auth.uid(),
    CASE WHEN v_needs_approval THEN 'pending_approval' ELSE 'auto_approved' END,
    CASE WHEN v_needs_approval THEN v_approval_reason ELSE NULL END
  ) RETURNING id INTO v_log_id;

  -- Only execute merge if no approval needed
  IF NOT v_needs_approval THEN
    PERFORM merge_crm_contacts(p_primary_id, p_secondary_id, p_org_id);
    RETURN jsonb_build_object('log_id', v_log_id, 'status', 'executed');
  ELSE
    RETURN jsonb_build_object('log_id', v_log_id, 'status', 'pending_approval',
      'reason', v_approval_reason);
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A1c. approve_crm_merge — manager/executive approves pending merge
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_crm_merge(
  p_org_id  UUID,
  p_log_id  UUID,
  p_approve BOOLEAN DEFAULT TRUE,
  p_reason  TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log crm_merge_log%ROWTYPE;
BEGIN
  -- Caller must have merge_contacts permission
  IF NOT check_crm_permission(p_org_id, auth.uid(), 'merge_contacts') THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Insufficient permission: merge_contacts required');
  END IF;

  SELECT * INTO v_log FROM crm_merge_log WHERE id = p_log_id AND org_id = p_org_id;
  IF v_log.id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Merge log not found');
  END IF;
  IF v_log.approval_status <> 'pending_approval' THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Merge is not pending approval');
  END IF;

  IF p_approve THEN
    UPDATE crm_merge_log SET
      approval_status = 'approved', approved_by = auth.uid(), approved_at = now()
    WHERE id = p_log_id;
    -- Execute the actual merge
    PERFORM merge_crm_contacts(v_log.target_contact_id, v_log.source_contact_id, p_org_id);
    -- Governance audit
    INSERT INTO crm_governance_audit (org_id, actor_id, action_type, target_type, target_id,
      after_state)
    VALUES (p_org_id, auth.uid(), 'merge_approved', 'merge_log', p_log_id,
      jsonb_build_object('primary_id', v_log.target_contact_id, 'secondary_id', v_log.source_contact_id));
    RETURN jsonb_build_object('success', TRUE, 'status', 'approved_and_executed');
  ELSE
    UPDATE crm_merge_log SET
      approval_status = 'rejected', rejected_by = auth.uid(),
      rejected_at = now(), rejected_reason = p_reason
    WHERE id = p_log_id;
    RETURN jsonb_build_object('success', TRUE, 'status', 'rejected');
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A1d. get_crm_pending_merges — list merges awaiting approval
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_pending_merges(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'log_id',               ml.id,
    'primary_contact_id',   ml.target_contact_id,
    'primary_name',         pc.name,
    'primary_company',      pc.company,
    'secondary_contact_id', ml.source_contact_id,
    'secondary_name',       sc.name,
    'secondary_company',    sc.company,
    'merge_confidence',     ml.merge_confidence,
    'approval_reason',      ml.approval_required_reason,
    'requested_by',         ml.merged_by,
    'created_at',           ml.created_at
  ) ORDER BY ml.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM crm_merge_log ml
  JOIN crm_contacts pc ON pc.id = ml.target_contact_id
  JOIN crm_contacts sc ON sc.id = ml.source_contact_id
  WHERE ml.org_id = p_org_id AND ml.approval_status = 'pending_approval';

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A1e. update_crm_contact_strategic_tier — require executive permission for
--      promotions to flagship/anchor/investor_visible
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_crm_contact_strategic_tier(UUID,UUID,TEXT);
CREATE OR REPLACE FUNCTION public.update_crm_contact_strategic_tier(
  p_org_id     UUID,
  p_contact_id UUID,
  p_new_tier   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_tier TEXT;
  v_high_tiers TEXT[] := ARRAY['flagship','anchor','investor_visible'];
BEGIN
  SELECT strategic_tier INTO v_old_tier FROM crm_contacts WHERE id = p_contact_id AND org_id = p_org_id;
  IF v_old_tier IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Contact not found');
  END IF;

  -- Promoting TO a high tier requires view_strategic_accounts permission
  IF p_new_tier = ANY(v_high_tiers) THEN
    IF NOT check_crm_permission(p_org_id, auth.uid(), 'view_strategic_accounts') THEN
      RETURN jsonb_build_object('success', FALSE,
        'error', 'Promoting to ' || p_new_tier || ' requires executive or founder role');
    END IF;
  END IF;

  UPDATE crm_contacts SET strategic_tier = p_new_tier WHERE id = p_contact_id AND org_id = p_org_id;

  INSERT INTO crm_governance_audit (org_id, actor_id, action_type, target_type, target_id,
    before_state, after_state)
  VALUES (p_org_id, auth.uid(), 'strategic_tier_updated', 'contact', p_contact_id,
    jsonb_build_object('strategic_tier', v_old_tier),
    jsonb_build_object('strategic_tier', p_new_tier));

  RETURN jsonb_build_object('success', TRUE, 'old_tier', v_old_tier, 'new_tier', p_new_tier);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A2. Escalation visibility_scope
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.crm_escalations
  ADD COLUMN IF NOT EXISTS visibility_scope TEXT NOT NULL DEFAULT 'org'
    CHECK (visibility_scope IN ('org','leadership','owner_chain','executive_only'));

CREATE INDEX IF NOT EXISTS idx_crm_esc_visibility
  ON public.crm_escalations (org_id, visibility_scope);

-- Update get_crm_escalations to respect visibility_scope
DROP FUNCTION IF EXISTS public.get_crm_escalations(UUID,TEXT,INT);
CREATE OR REPLACE FUNCTION public.get_crm_escalations(
  p_org_id UUID,
  p_state  TEXT DEFAULT 'open',
  p_limit  INT  DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_roles TEXT[];
  v_result       JSONB;
BEGIN
  -- Collect caller's roles for visibility filtering
  SELECT ARRAY_AGG(r.name) INTO v_caller_roles
  FROM crm_user_roles ur
  JOIN crm_roles r ON r.id = ur.role_id
  WHERE ur.org_id = p_org_id AND ur.user_id = auth.uid();

  SELECT COALESCE(jsonb_agg(row_data ORDER BY (row_data->>'sla_breached')::BOOLEAN DESC,
    (row_data->>'created_at') DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id',              e.id,
      'contact_id',      e.contact_id,
      'contact_name',    c.name,
      'contact_company', c.company,
      'trigger_type',    e.trigger_type,
      'priority',        e.priority,
      'execution_state', e.execution_state,
      'assigned_to',     e.assigned_to,
      'due_at',          e.due_at,
      'sla_breached',    e.sla_breached,
      'ai_context',      e.ai_context,
      'lifetime_value',  cr.total_ltv,
      'visibility_scope', e.visibility_scope,
      'created_at',      e.created_at
    ) AS row_data
    FROM crm_escalations e
    JOIN crm_contacts c ON c.id = e.contact_id
    LEFT JOIN crm_customer_revenue cr ON cr.contact_id = e.contact_id AND cr.org_id = p_org_id
    WHERE e.org_id = p_org_id
      AND (
        p_state = 'all'
        OR (p_state IN ('open','assigned','in_progress') AND e.execution_state = p_state)
        OR (p_state = 'open' AND e.execution_state IN ('open','assigned','in_progress'))
      )
      -- Visibility scope filter
      AND (
        e.visibility_scope = 'org'
        OR (e.visibility_scope = 'leadership' AND
            (v_caller_roles && ARRAY['founder','executive','manager'] OR
             e.assigned_to = auth.uid()))
        OR (e.visibility_scope = 'owner_chain' AND (
            e.assigned_to = auth.uid()
            OR EXISTS (SELECT 1 FROM crm_contact_ownership co
                       WHERE co.contact_id = e.contact_id
                       AND auth.uid() IN (co.primary_owner_id, co.supporting_owner_id,
                                          co.escalation_owner_id, co.cs_owner_id))))
        OR (e.visibility_scope = 'executive_only' AND
            v_caller_roles && ARRAY['founder','executive'])
      )
    LIMIT p_limit
  ) sub;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- create_manual_crm_escalation — add visibility_scope param
CREATE OR REPLACE FUNCTION public.create_manual_crm_escalation(
  p_org_id         UUID,
  p_contact_id     UUID,
  p_priority       TEXT DEFAULT 'medium',
  p_reason         TEXT DEFAULT NULL,
  p_assigned_to    UUID DEFAULT NULL,
  p_visibility_scope TEXT DEFAULT 'org'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO crm_escalations
    (org_id, contact_id, trigger_type, priority, execution_state, ai_context, assigned_to, visibility_scope,
     due_at)
  VALUES
    (p_org_id, p_contact_id, 'manual', p_priority, 'open', p_reason, p_assigned_to,
     COALESCE(p_visibility_scope, 'org'),
     CASE p_priority
       WHEN 'critical' THEN now() + INTERVAL '12 hours'
       WHEN 'high'     THEN now() + INTERVAL '24 hours'
       WHEN 'medium'   THEN now() + INTERVAL '72 hours'
       ELSE now() + INTERVAL '7 days'
     END)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', TRUE, 'escalation_id', v_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A3. Causal chain calibration — confidence_bound, causal_sample_count, is_verifiable
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.crm_causal_chains
  ADD COLUMN IF NOT EXISTS confidence_bound     INT  NOT NULL DEFAULT 30
    CHECK (confidence_bound BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS causal_sample_count  INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_verifiable        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suppressed           BOOLEAN NOT NULL DEFAULT FALSE;

-- confidence_bound logic:
--   < 3 occurrences  → 20  (very uncertain)
--   3–9 occurrences  → 40  (emerging pattern)
--   10–24 occurrences → 65  (established)
--   ≥25 occurrences  → 85  (strong)
--   is_verifiable adds +5 (causal event can be confirmed via snapshot replay)
--   suppressed = TRUE when bound < 35 (hidden from UI to prevent speculative storytelling)

CREATE OR REPLACE FUNCTION public.aggregate_crm_causal_chains(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO crm_causal_chains
    (org_id, chain_type, cause_type, effect_type, occurrence_count,
     avg_lag_days, avg_delta_magnitude, confidence,
     confidence_bound, causal_sample_count, is_verifiable, suppressed,
     typical_outcome, last_detected_at)
  SELECT
    p_org_id,
    -- Classify chain type from cause→effect pair
    CASE
      WHEN ce.cause_type IN ('trust_fracture_high','trust_fracture_critical')
           AND ce.effect_type IN ('churn_increase','capital_collapsed') THEN 'trust_fracture_chain'
      WHEN ce.cause_type = 'escalation_resolved'
           AND ce.effect_type IN ('churn_decrease','trajectory_improved') THEN 'recovery_chain'
      WHEN ce.cause_type IN ('silence_gap_21d','silence_gap_42d')
           AND ce.effect_type IN ('churn_increase','trajectory_declined') THEN 'silence_decay'
      WHEN ce.cause_type = 'maintenance_spike'
           AND ce.effect_type IN ('trajectory_declined','capital_collapsed') THEN 'maintenance_spiral'
      WHEN ce.cause_type IN ('intervention_applied','campaign_activated')
           AND ce.direction = 'positive' THEN 'recovery_chain'
      WHEN ce.effect_type IN ('churn_increase','capital_collapsed','expansion_blocked') THEN 'deterioration_chain'
      ELSE 'deterioration_chain'
    END                           AS chain_type,
    ce.cause_type,
    ce.effect_type,
    COUNT(*)::INT                  AS occurrence_count,
    ROUND(AVG(ce.lag_days))::INT   AS avg_lag_days,
    ROUND(AVG(ce.delta_magnitude))::INT AS avg_delta_magnitude,
    -- Qualitative confidence label
    CASE
      WHEN COUNT(*) >= 10 THEN 'high'
      WHEN COUNT(*) >=  3 THEN 'medium'
      ELSE 'low'
    END                           AS confidence,
    -- Quantitative confidence bound (0–100)
    LEAST(100, CASE
      WHEN COUNT(*) >= 25 THEN 85
      WHEN COUNT(*) >= 10 THEN 65
      WHEN COUNT(*) >=  3 THEN 40
      ELSE 20
    END + CASE WHEN bool_or(ce.confidence = 'high') THEN 5 ELSE 0 END)::INT AS confidence_bound,
    COUNT(*)::INT                  AS causal_sample_count,
    -- Verifiable when at least 3 events have snapshot-backed evidence
    (COUNT(*) FILTER (WHERE ce.evidence ? 'snapshot_before' OR ce.evidence ? 'snapshot_after') >= 3) AS is_verifiable,
    -- Suppress speculative chains (bound < 35)
    (LEAST(100, CASE
      WHEN COUNT(*) >= 25 THEN 85
      WHEN COUNT(*) >= 10 THEN 65
      WHEN COUNT(*) >=  3 THEN 40
      ELSE 20
    END + CASE WHEN bool_or(ce.confidence = 'high') THEN 5 ELSE 0 END) < 35) AS suppressed,
    -- Human-readable outcome
    CASE
      WHEN COUNT(*) >= 10 THEN 'Established pattern: ' || ce.cause_type || ' reliably leads to ' || ce.effect_type || ' within ' || ROUND(AVG(ce.lag_days))::TEXT || ' days'
      WHEN COUNT(*) >=  3 THEN 'Emerging pattern: ' || ce.cause_type || ' may lead to ' || ce.effect_type
      ELSE 'Early signal: ' || ce.cause_type || ' → ' || ce.effect_type || ' (insufficient data)'
    END,
    now()
  FROM crm_causal_events ce
  WHERE ce.org_id = p_org_id
  GROUP BY ce.cause_type, ce.effect_type, ce.direction
  ON CONFLICT (org_id, chain_type, cause_type, effect_type) DO UPDATE SET
    occurrence_count    = EXCLUDED.occurrence_count,
    avg_lag_days        = EXCLUDED.avg_lag_days,
    avg_delta_magnitude = EXCLUDED.avg_delta_magnitude,
    confidence          = EXCLUDED.confidence,
    confidence_bound    = EXCLUDED.confidence_bound,
    causal_sample_count = EXCLUDED.causal_sample_count,
    is_verifiable       = EXCLUDED.is_verifiable,
    suppressed          = EXCLUDED.suppressed,
    typical_outcome     = EXCLUDED.typical_outcome,
    last_detected_at    = EXCLUDED.last_detected_at;
END;
$$;

-- get_crm_causal_intelligence — only surface non-suppressed chains by default
CREATE OR REPLACE FUNCTION public.get_crm_causal_intelligence(
  p_org_id     UUID,
  p_contact_id UUID  DEFAULT NULL,
  p_include_suppressed BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'causal_chains', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',                 cc.id,
        'chain_type',         cc.chain_type,
        'cause_type',         cc.cause_type,
        'effect_type',        cc.effect_type,
        'occurrence_count',   cc.occurrence_count,
        'avg_lag_days',       cc.avg_lag_days,
        'confidence',         cc.confidence,
        'confidence_bound',   cc.confidence_bound,
        'causal_sample_count', cc.causal_sample_count,
        'is_verifiable',      cc.is_verifiable,
        'suppressed',         cc.suppressed,
        'typical_outcome',    cc.typical_outcome,
        'last_detected_at',   cc.last_detected_at
      ) ORDER BY cc.confidence_bound DESC, cc.occurrence_count DESC)
      FROM crm_causal_chains cc
      WHERE cc.org_id = p_org_id
        AND (p_include_suppressed OR NOT cc.suppressed)
    ), '[]'::jsonb),

    'contact_events', CASE WHEN p_contact_id IS NOT NULL THEN
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',               ce.id,
          'cause_type',       ce.cause_type,
          'effect_type',      ce.effect_type,
          'lag_days',         ce.lag_days,
          'direction',        ce.direction,
          'confidence',       ce.confidence,
          'delta_magnitude',  ce.delta_magnitude,
          'cause_observed_at', ce.cause_observed_at
        ) ORDER BY ce.cause_observed_at DESC)
        FROM crm_causal_events ce
        WHERE ce.org_id = p_org_id AND ce.contact_id = p_contact_id
      ), '[]'::jsonb)
    ELSE NULL END,

    'calibration_summary', (
      SELECT jsonb_build_object(
        'total_chains',      COUNT(*),
        'suppressed_chains', COUNT(*) FILTER (WHERE suppressed),
        'verifiable_chains', COUNT(*) FILTER (WHERE is_verifiable),
        'high_confidence',   COUNT(*) FILTER (WHERE confidence_bound >= 65),
        'avg_bound',         ROUND(AVG(confidence_bound))
      )
      FROM crm_causal_chains WHERE org_id = p_org_id
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;
