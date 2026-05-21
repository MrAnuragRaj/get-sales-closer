-- SprintA Hardening: governance adversarial validation fixes
-- H0: Fix merge_crm_contacts parameter order bug (Sprint A introduced wrong order)
-- H1: approve_crm_merge — FOR UPDATE row lock + idempotency + full audit
-- H2: repair_crm_merge_references — comprehensive FK repair for Sprint 1-19 tables
-- H3: get_crm_command_center — escalation visibility_scope filter
-- H4: update_crm_contact_strategic_tier — downgrade protection for high tiers
-- H5: aggregate_crm_causal_chains — is_verifiable tightened (AND not OR)
-- H6: crm_retention_policies + run_crm_retention_purge + pg_cron

-- ─────────────────────────────────────────────────────────────────────────────
-- H0. Fix merge_crm_contacts_safe — wrong call order was (primary, secondary, org)
--     Correct order: (org_id, primary_id, secondary_id)
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
RETURNS JSONB
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

  v_needs_approval := FALSE;
  IF COALESCE(p_merge_confidence, 100) < 70 THEN
    v_needs_approval  := TRUE;
    v_approval_reason := 'merge_confidence_' || COALESCE(p_merge_confidence::TEXT, 'unknown') || '_below_70_threshold';
  END IF;
  IF v_primary.strategic_tier IN ('flagship','anchor','strategic_logo','investor_visible') OR
     v_secondary.strategic_tier IN ('flagship','anchor','strategic_logo','investor_visible') THEN
    v_needs_approval  := TRUE;
    v_approval_reason := COALESCE(v_approval_reason || '; ', '') || 'strategic_tier_contact_involved';
  END IF;

  SELECT ARRAY_AGG(id) INTO v_activity_ids FROM crm_activities       WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_note_ids     FROM crm_notes            WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_task_ids     FROM crm_tasks            WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  SELECT ARRAY_AGG(id) INTO v_lc_ids       FROM crm_lifecycle_changes WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  INSERT INTO crm_merge_log (
    org_id, source_contact_id, target_contact_id,
    conflict_type, merge_confidence, merge_reason, is_reversible,
    source_contact_snapshot, primary_pre_merge_snapshot, merged_record_ids,
    merged_by, approval_status, approval_required_reason
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

  IF NOT v_needs_approval THEN
    -- Repair Sprint 14-19 FKs before merge executes the DELETE
    PERFORM repair_crm_merge_references(p_primary_id, p_secondary_id, p_org_id);
    -- Correct call order: (org_id, primary_id, secondary_id)
    PERFORM merge_crm_contacts(p_org_id, p_primary_id, p_secondary_id);
    RETURN jsonb_build_object('log_id', v_log_id, 'status', 'executed');
  ELSE
    RETURN jsonb_build_object('log_id', v_log_id, 'status', 'pending_approval',
      'reason', v_approval_reason);
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H1. approve_crm_merge — FOR UPDATE lock + idempotency + full audit
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
  IF NOT check_crm_permission(p_org_id, auth.uid(), 'merge_contacts') THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Insufficient permission: merge_contacts required');
  END IF;

  -- Lock the row first to prevent concurrent approval race conditions
  SELECT * INTO v_log FROM crm_merge_log
  WHERE id = p_log_id AND org_id = p_org_id
  FOR UPDATE;

  IF v_log.id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Merge log not found');
  END IF;

  -- Idempotency: reject if not in pending_approval state
  IF v_log.approval_status <> 'pending_approval' THEN
    RETURN jsonb_build_object('success', FALSE, 'error',
      'Merge is not pending approval (current status: ' || v_log.approval_status || ')');
  END IF;

  IF p_approve THEN
    UPDATE crm_merge_log SET
      approval_status = 'approved', approved_by = auth.uid(), approved_at = now()
    WHERE id = p_log_id;

    -- Repair Sprint 14-19 FK references before the merge deletes secondary
    PERFORM repair_crm_merge_references(v_log.target_contact_id, v_log.source_contact_id, p_org_id);
    -- Execute merge (correct parameter order: org_id, primary_id, secondary_id)
    PERFORM merge_crm_contacts(p_org_id, v_log.target_contact_id, v_log.source_contact_id);

    -- Full audit: actor, prior state, resulting merge, confidence, strategic tier, justification
    INSERT INTO crm_governance_audit (org_id, actor_id, action_type, target_type, target_id,
      before_state, after_state)
    VALUES (p_org_id, auth.uid(), 'merge_approved', 'merge_log', p_log_id,
      jsonb_build_object(
        'approval_status',         'pending_approval',
        'primary_contact_id',      v_log.target_contact_id,
        'secondary_contact_id',    v_log.source_contact_id,
        'merge_confidence',        v_log.merge_confidence,
        'approval_required_reason', v_log.approval_required_reason,
        'primary_pre_merge_snapshot', v_log.primary_pre_merge_snapshot
      ),
      jsonb_build_object(
        'approval_status',     'approved',
        'approved_by',         auth.uid(),
        'approved_at',         now(),
        'justification',       COALESCE(p_reason, 'No reason provided'),
        'merge_executed',      true,
        'strategic_tier_involved',
          (v_log.approval_required_reason LIKE '%strategic_tier%')
      ));

    RETURN jsonb_build_object('success', TRUE, 'status', 'approved_and_executed');
  ELSE
    UPDATE crm_merge_log SET
      approval_status = 'rejected', rejected_by = auth.uid(),
      rejected_at = now(), rejected_reason = p_reason
    WHERE id = p_log_id;

    INSERT INTO crm_governance_audit (org_id, actor_id, action_type, target_type, target_id,
      before_state, after_state)
    VALUES (p_org_id, auth.uid(), 'merge_rejected', 'merge_log', p_log_id,
      jsonb_build_object(
        'approval_status',      'pending_approval',
        'primary_contact_id',   v_log.target_contact_id,
        'secondary_contact_id', v_log.source_contact_id,
        'merge_confidence',     v_log.merge_confidence
      ),
      jsonb_build_object(
        'approval_status', 'rejected',
        'rejected_by',     auth.uid(),
        'rejected_at',     now(),
        'rejected_reason', COALESCE(p_reason, 'No reason provided')
      ));

    RETURN jsonb_build_object('success', TRUE, 'status', 'rejected');
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H2. repair_crm_merge_references
--     Updates all FK references from secondary → primary across Sprint 1-19 tables
--     Called BEFORE merge_crm_contacts() which deletes secondary
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.repair_crm_merge_references(
  p_primary_id   UUID,
  p_secondary_id UUID,
  p_org_id       UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ── Phase 3/4 tables ───────────────────────────────────────────────────────
  UPDATE crm_churn_signals  SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_next_actions   SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_contact_memory SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Phase 8: escalations, ownership, team ops ─────────────────────────────
  UPDATE crm_escalations           SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_contact_ownership     SET contact_id = p_primary_id WHERE contact_id = p_secondary_id;
  UPDATE crm_team_observations     SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_success_plans         SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_decision_accountability SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Phase 9: predictive scores (UNIQUE on contact_id → delete secondary) ──
  DELETE FROM crm_predictive_scores WHERE contact_id = p_secondary_id;
  UPDATE crm_predictive_score_history SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Phase 10: learning ────────────────────────────────────────────────────
  UPDATE crm_recommendation_outcomes SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_intervention_impacts     SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 2: trust, maturity, signal conflicts ───────────────────────────
  UPDATE crm_trust_fractures  SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_signal_conflicts SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  -- relationship_maturity: UNIQUE on contact_id → delete secondary's row
  DELETE FROM crm_relationship_maturity WHERE contact_id = p_secondary_id;

  -- ── Sprint 3: applicable principles ──────────────────────────────────────
  -- crm_relationship_principles has no contact_id; skip

  -- ── Sprint 4: resilience (UNIQUE on contact_id) ───────────────────────────
  DELETE FROM crm_resilience_snapshots WHERE contact_id = p_secondary_id;

  -- ── Sprint 5: maintenance (UNIQUE on contact_id) ─────────────────────────
  DELETE FROM crm_maintenance_snapshots WHERE contact_id = p_secondary_id;

  -- ── Sprint 6: relationship snapshots (UNIQUE on contact_id + snapshot_date)
  DELETE FROM crm_relationship_snapshots
  WHERE contact_id = p_secondary_id
    AND snapshot_date IN (
      SELECT snapshot_date FROM crm_relationship_snapshots WHERE contact_id = p_primary_id
    );
  UPDATE crm_relationship_snapshots SET contact_id = p_primary_id WHERE contact_id = p_secondary_id;
  UPDATE crm_inflection_points      SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 7: expansion (UNIQUE on contact_id + opportunity_type) ─────────
  UPDATE crm_loyalty_signals SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  DELETE FROM crm_expansion_opportunities
  WHERE contact_id = p_secondary_id AND org_id = p_org_id
    AND opportunity_type IN (
      SELECT opportunity_type FROM crm_expansion_opportunities
      WHERE contact_id = p_primary_id AND org_id = p_org_id
    );
  UPDATE crm_expansion_opportunities SET contact_id = p_primary_id
  WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Phase 7 / Sprint 7: AI summaries + recommendations (UNIQUE on contact_id)
  DELETE FROM crm_ai_summaries       WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  DELETE FROM crm_ai_recommendations WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  UPDATE crm_insight_confirmations   SET contact_id = p_primary_id WHERE contact_id = p_secondary_id AND org_id = p_org_id;
  -- strategic_segment_members (UNIQUE on contact_id + segment_id)
  DELETE FROM crm_strategic_segment_members
  WHERE contact_id = p_secondary_id
    AND segment_id IN (
      SELECT segment_id FROM crm_strategic_segment_members WHERE contact_id = p_primary_id
    );
  UPDATE crm_strategic_segment_members SET contact_id = p_primary_id WHERE contact_id = p_secondary_id;

  -- ── Sprint 9: briefings (UNIQUE on org_id + contact_id) ──────────────────
  DELETE FROM crm_relationship_briefings WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 10: signal drift (UNIQUE on contact_id + signal_name + detected_date)
  DELETE FROM crm_signal_drift_events
  WHERE contact_id = p_secondary_id AND org_id = p_org_id
    AND (signal_name, detected_date) IN (
      SELECT signal_name, detected_date FROM crm_signal_drift_events
      WHERE contact_id = p_primary_id
    );
  UPDATE crm_signal_drift_events SET contact_id = p_primary_id
  WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 13: signal suppression (UNIQUE on org_id + contact_id + signal_name)
  DELETE FROM crm_signal_suppression
  WHERE contact_id = p_secondary_id AND org_id = p_org_id
    AND signal_name IN (
      SELECT signal_name FROM crm_signal_suppression
      WHERE contact_id = p_primary_id AND org_id = p_org_id
    );
  UPDATE crm_signal_suppression SET contact_id = p_primary_id
  WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 14: relationship edges — deactivate rather than re-map
  --    (topology recomputes nightly; re-mapping bidirectional edges is error-prone)
  UPDATE crm_relationship_edges SET is_active = false
  WHERE org_id = p_org_id
    AND (contact_id_a = p_secondary_id OR contact_id_b = p_secondary_id);

  -- ── Sprint 17: relationship economics (UNIQUE on org_id + contact_id) ────
  DELETE FROM crm_relationship_economics WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Sprint 18: causal events (FK, no UNIQUE on contact_id alone) ─────────
  UPDATE crm_causal_events SET contact_id = p_primary_id
  WHERE contact_id = p_secondary_id AND org_id = p_org_id;

  -- ── Phase 6: revenue (UNIQUE on contact_id) ───────────────────────────────
  DELETE FROM crm_customer_revenue WHERE contact_id = p_secondary_id AND org_id = p_org_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H3. get_crm_command_center — add visibility_scope filter to escalation section
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_crm_command_center(
  p_org_id  UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items        JSONB := '[]'::JSONB;
  v_batch        JSONB;
  v_critical     INT;
  v_high         INT;
  v_normal       INT;
  v_caller_roles TEXT[];
BEGIN

  -- Collect caller's CRM roles for escalation visibility filtering
  SELECT ARRAY_AGG(r.name) INTO v_caller_roles
  FROM crm_user_roles ur
  JOIN crm_roles r ON r.id = ur.role_id
  WHERE ur.org_id = p_org_id AND ur.user_id = auth.uid();

  -- ── 1. SLA-breaching escalations (critical) — filtered by visibility_scope
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'critical',
      'type',         'sla_breach',
      'contact_id',   e.contact_id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      'SLA breached — ' || ROUND(EXTRACT(EPOCH FROM (NOW() - e.due_at))/3600, 1)::TEXT || 'h overdue',
      'action_label', 'Resolve Now',
      'age_days',     EXTRACT(DAY FROM NOW() - e.created_at)::INT,
      'drivers',      jsonb_build_array(
        e.priority || ' priority',
        'Trigger: ' || REPLACE(e.trigger_type, '_', ' ')
      ),
      'metadata',     jsonb_build_object(
        'escalation_id', e.id,
        'trigger_type',  e.trigger_type,
        'priority',      e.priority
      )
    ) AS item
    FROM crm_escalations e
    JOIN crm_contacts c ON c.id = e.contact_id
    WHERE e.org_id = p_org_id
      AND e.sla_breached = true
      AND e.execution_state NOT IN ('resolved','dismissed')
      -- Focus mode filter
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = e.contact_id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
      -- Visibility scope filter: same logic as get_crm_escalations
      AND (
        e.visibility_scope = 'org'
        OR (e.visibility_scope = 'leadership' AND (
              v_caller_roles && ARRAY['founder','executive','manager']
              OR e.assigned_to = auth.uid()))
        OR (e.visibility_scope = 'owner_chain' AND (
              e.assigned_to = auth.uid()
              OR EXISTS (SELECT 1 FROM crm_contact_ownership co
                         WHERE co.contact_id = e.contact_id
                           AND auth.uid() IN (co.primary_owner_id, co.supporting_owner_id,
                                              co.escalation_owner_id, co.cs_owner_id))))
        OR (e.visibility_scope = 'executive_only' AND
              v_caller_roles && ARRAY['founder','executive'])
      )
    ORDER BY e.due_at ASC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── 2. Extreme churn risk ≥80% (critical)
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'critical',
      'type',         'churn_risk',
      'contact_id',   ps.contact_id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      'Churn risk ' || ps.churn_probability || '% — immediate intervention needed',
      'action_label', 'Intervene Now',
      'age_days',     GREATEST(0, 7 - EXTRACT(DAY FROM ps.expires_at - NOW())::INT),
      'drivers',      COALESCE(
        NULLIF((SELECT jsonb_agg(v) FROM jsonb_array_elements(ps.churn_drivers) v LIMIT 3), '[]'::JSONB),
        jsonb_build_array('High churn probability detected')
      ),
      'metadata',     jsonb_build_object(
        'churn_probability',   ps.churn_probability,
        'revenue_trajectory',  ps.revenue_trajectory,
        'engagement_momentum', ps.engagement_momentum
      )
    ) AS item
    FROM crm_predictive_scores ps
    JOIN crm_contacts c ON c.id = ps.contact_id
    WHERE ps.org_id = p_org_id
      AND ps.churn_probability >= 80
      AND ps.expires_at > NOW()
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = ps.contact_id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
    ORDER BY ps.churn_probability DESC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── 3. High churn risk 60–79% (high)
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'high',
      'type',         'churn_risk',
      'contact_id',   ps.contact_id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      'Churn risk ' || ps.churn_probability || '% — needs attention',
      'action_label', 'Reach Out',
      'age_days',     GREATEST(0, 7 - EXTRACT(DAY FROM ps.expires_at - NOW())::INT),
      'drivers',      COALESCE(
        NULLIF((SELECT jsonb_agg(v) FROM jsonb_array_elements(ps.churn_drivers) v LIMIT 3), '[]'::JSONB),
        jsonb_build_array('Elevated churn signal')
      ),
      'metadata',     jsonb_build_object(
        'churn_probability',  ps.churn_probability,
        'revenue_trajectory', ps.revenue_trajectory
      )
    ) AS item
    FROM crm_predictive_scores ps
    JOIN crm_contacts c ON c.id = ps.contact_id
    WHERE ps.org_id = p_org_id
      AND ps.churn_probability >= 60
      AND ps.churn_probability < 80
      AND ps.expires_at > NOW()
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = ps.contact_id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
    ORDER BY ps.churn_probability DESC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── 4. Loyal/active customers silent >21d (high)
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'high',
      'type',         'vip_no_contact',
      'contact_id',   c.id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      'No contact in ' ||
                      EXTRACT(DAY FROM NOW() - COALESCE(c.last_meaningful_interaction_at, c.created_at))::INT ||
                      ' days — relationship cooling',
      'action_label', 'Reconnect',
      'age_days',     EXTRACT(DAY FROM NOW() - COALESCE(c.last_meaningful_interaction_at, c.created_at))::INT,
      'drivers',      jsonb_build_array(
        'Relationship: ' || COALESCE(c.relationship_state, 'unknown'),
        'Stage: ' || COALESCE(c.lifecycle_stage, 'unknown'),
        'Silent ' || EXTRACT(DAY FROM NOW() - COALESCE(c.last_meaningful_interaction_at, c.created_at))::INT || 'd'
      ),
      'metadata',     jsonb_build_object(
        'relationship_state', c.relationship_state,
        'lifecycle_stage',    c.lifecycle_stage,
        'days_silent',        EXTRACT(DAY FROM NOW() - COALESCE(c.last_meaningful_interaction_at, c.created_at))::INT
      )
    ) AS item
    FROM crm_contacts c
    WHERE c.org_id = p_org_id
      AND c.relationship_state IN ('loyal','active')
      AND c.lifecycle_stage = 'customer'
      AND COALESCE(c.last_meaningful_interaction_at, c.created_at) < NOW() - INTERVAL '21 days'
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = c.id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
    ORDER BY COALESCE(c.last_meaningful_interaction_at, c.created_at) ASC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── 5. Expansion opportunities ≥65% (normal)
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'normal',
      'type',         'expansion_opportunity',
      'contact_id',   ps.contact_id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      'Expansion ready — ' || ps.expansion_probability || '% probability',
      'action_label', 'Propose Upsell',
      'age_days',     GREATEST(0, 7 - EXTRACT(DAY FROM ps.expires_at - NOW())::INT),
      'drivers',      jsonb_build_array(
        'Expansion: ' || ps.expansion_probability || '%',
        'Trajectory: ' || COALESCE(REPLACE(ps.revenue_trajectory, '_', ' '), 'unknown'),
        'Momentum: ' || CASE ps.engagement_momentum
                             WHEN 'improving' THEN 'rising'
                             WHEN 'declining' THEN 'declining'
                             ELSE 'stable' END
      ),
      'metadata',     jsonb_build_object(
        'expansion_probability', ps.expansion_probability,
        'revenue_trajectory',    ps.revenue_trajectory
      )
    ) AS item
    FROM crm_predictive_scores ps
    JOIN crm_contacts c ON c.id = ps.contact_id
    WHERE ps.org_id = p_org_id
      AND ps.expansion_probability >= 65
      AND ps.expires_at > NOW()
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = ps.contact_id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
    ORDER BY ps.expansion_probability DESC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── 6. Urgent NBA actions (normal)
  SELECT COALESCE(jsonb_agg(item), '[]'::JSONB)
  INTO v_batch
  FROM (
    SELECT jsonb_build_object(
      'priority',     'normal',
      'type',         'urgent_nba',
      'contact_id',   na.contact_id,
      'contact_name', c.name,
      'company',      c.company,
      'message',      na.reasoning,
      'action_label', 'Take Action',
      'age_days',     EXTRACT(DAY FROM NOW() - na.computed_at)::INT,
      'drivers',      jsonb_build_array(
        'Action: ' || REPLACE(COALESCE(na.action_type, 'follow_up'), '_', ' '),
        'Urgency: ' || na.urgency
      ),
      'metadata',     jsonb_build_object(
        'action_type', na.action_type,
        'nba_id',      na.id
      )
    ) AS item
    FROM crm_next_actions na
    JOIN crm_contacts c ON c.id = na.contact_id
    WHERE na.org_id = p_org_id
      AND na.urgency = 'urgent'
      AND (na.snoozed_until IS NULL OR na.snoozed_until < NOW())
      AND (
        p_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM crm_contact_ownership o
          WHERE o.contact_id = na.contact_id
            AND p_user_id IN (o.primary_owner_id, o.supporting_owner_id, o.escalation_owner_id, o.cs_owner_id)
        )
      )
    ORDER BY na.computed_at DESC
    LIMIT 5
  ) t;
  v_items := v_items || v_batch;

  -- ── Deduplicate: one item per contact, highest priority wins
  WITH ranked AS (
    SELECT
      item,
      ROW_NUMBER() OVER (
        PARTITION BY item->>'contact_id'
        ORDER BY
          CASE item->>'priority'
            WHEN 'critical' THEN 1
            WHEN 'high'     THEN 2
            ELSE 3
          END
      ) AS rn
    FROM jsonb_array_elements(v_items) AS item
  )
  SELECT COALESCE(
    jsonb_agg(item ORDER BY
      CASE item->>'priority'
        WHEN 'critical' THEN 1
        WHEN 'high'     THEN 2
        ELSE 3
      END,
      (item->>'age_days')::INT DESC NULLS LAST
    ),
    '[]'::JSONB
  )
  INTO v_items
  FROM ranked
  WHERE rn = 1;

  SELECT
    COUNT(*) FILTER (WHERE item->>'priority' = 'critical'),
    COUNT(*) FILTER (WHERE item->>'priority' = 'high'),
    COUNT(*) FILTER (WHERE item->>'priority' = 'normal')
  INTO v_critical, v_high, v_normal
  FROM jsonb_array_elements(v_items) AS item;

  RETURN jsonb_build_object(
    'items',        v_items,
    'summary',      jsonb_build_object(
      'critical',     v_critical,
      'high',         v_high,
      'normal',       v_normal,
      'total',        v_critical + v_high + v_normal
    ),
    'generated_at', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_crm_command_center(UUID, UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- H4. update_crm_contact_strategic_tier — downgrade protection
--     Demoting FROM a high tier now also requires view_strategic_accounts
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
  v_old_tier   TEXT;
  v_high_tiers TEXT[] := ARRAY['flagship','anchor','investor_visible'];
BEGIN
  SELECT strategic_tier INTO v_old_tier
  FROM crm_contacts WHERE id = p_contact_id AND org_id = p_org_id;

  IF v_old_tier IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Contact not found');
  END IF;

  -- Promoting TO a high tier requires view_strategic_accounts
  IF p_new_tier = ANY(v_high_tiers) THEN
    IF NOT check_crm_permission(p_org_id, auth.uid(), 'view_strategic_accounts') THEN
      RETURN jsonb_build_object('success', FALSE,
        'error', 'Promoting to ' || p_new_tier || ' requires executive or founder role');
    END IF;
  END IF;

  -- Demoting FROM a high tier also requires view_strategic_accounts
  -- Prevents accidental demotion of flagship/anchor/investor_visible contacts
  IF v_old_tier = ANY(v_high_tiers) AND NOT (p_new_tier = ANY(v_high_tiers)) THEN
    IF NOT check_crm_permission(p_org_id, auth.uid(), 'view_strategic_accounts') THEN
      RETURN jsonb_build_object('success', FALSE,
        'error', 'Demoting from ' || v_old_tier || ' requires executive or founder role');
    END IF;
  END IF;

  UPDATE crm_contacts SET strategic_tier = p_new_tier
  WHERE id = p_contact_id AND org_id = p_org_id;

  INSERT INTO crm_governance_audit (org_id, actor_id, action_type, target_type, target_id,
    before_state, after_state)
  VALUES (p_org_id, auth.uid(), 'strategic_tier_updated', 'contact', p_contact_id,
    jsonb_build_object('strategic_tier', v_old_tier),
    jsonb_build_object('strategic_tier', p_new_tier,
      'is_demotion', (v_old_tier = ANY(v_high_tiers) AND NOT (p_new_tier = ANY(v_high_tiers)))));

  RETURN jsonb_build_object('success', TRUE, 'old_tier', v_old_tier, 'new_tier', p_new_tier);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H5. aggregate_crm_causal_chains — tighten is_verifiable semantics
--     Definition: a chain is verifiable when ≥3 events have BOTH snapshot_before
--     AND snapshot_after in their evidence (pre+post state both captured,
--     enabling deterministic replay of the cause→effect transition)
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
     avg_lag_days, avg_delta_magnitude, confidence,
     confidence_bound, causal_sample_count, is_verifiable, suppressed,
     typical_outcome, last_detected_at)
  SELECT
    p_org_id,
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
    -- Verifiability: ≥3 events must have BOTH snapshot_before AND snapshot_after
    -- (pre-state AND post-state captured → transition is replay-verifiable)
    (COUNT(*) FILTER (WHERE ce.evidence ? 'snapshot_before' AND ce.evidence ? 'snapshot_after') >= 3) AS is_verifiable,
    -- Suppress speculative chains (bound < 35 — fewer than 3 occurrences without high confidence)
    (LEAST(100, CASE
      WHEN COUNT(*) >= 25 THEN 85
      WHEN COUNT(*) >= 10 THEN 65
      WHEN COUNT(*) >=  3 THEN 40
      ELSE 20
    END + CASE WHEN bool_or(ce.confidence = 'high') THEN 5 ELSE 0 END) < 35) AS suppressed,
    CASE
      WHEN COUNT(*) >= 10 THEN 'Established pattern: ' || ce.cause_type || ' reliably leads to ' || ce.effect_type || ' within ' || ROUND(AVG(ce.lag_days))::TEXT || ' days'
      WHEN COUNT(*) >=  3 THEN 'Emerging pattern: ' || ce.cause_type || ' may lead to ' || ce.effect_type
      ELSE 'Early signal: ' || ce.cause_type || ' → ' || ce.effect_type || ' (insufficient data — suppressed from UI)'
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

-- ─────────────────────────────────────────────────────────────────────────────
-- H6a. crm_retention_policies table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_retention_policies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  resource_type   TEXT        NOT NULL,
  retention_days  INT         NOT NULL DEFAULT 365
    CHECK (retention_days BETWEEN 30 AND 3650),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, resource_type)
);

ALTER TABLE public.crm_retention_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_retention_policies_select ON public.crm_retention_policies;
CREATE POLICY crm_retention_policies_select ON public.crm_retention_policies
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS crm_retention_policies_modify ON public.crm_retention_policies;
CREATE POLICY crm_retention_policies_modify ON public.crm_retention_policies
  FOR ALL USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- H6b. ensure_crm_retention_policies — seed defaults per org (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_crm_retention_policies(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO crm_retention_policies (org_id, resource_type, retention_days, notes) VALUES
    (p_org_id, 'webhook_deliveries',       90,   'Delivered/failed/skipped webhook attempts'),
    (p_org_id, 'causal_events',           730,   '2 years — causal event raw records'),
    (p_org_id, 'signal_drift_events',     365,   '1 year — threshold crossing events'),
    (p_org_id, 'portfolio_pulse',         365,   '1 year — daily org-level pulse'),
    (p_org_id, 'operating_consciousness', 365,   '1 year — daily consciousness snapshots'),
    (p_org_id, 'relationship_snapshots',  730,   '2 years — per-contact daily snapshots'),
    (p_org_id, 'portfolio_snapshots',     365,   '1 year — org portfolio climate'),
    (p_org_id, 'integrity_violations',    180,   '6 months — auto-resolved violations'),
    (p_org_id, 'epistemic_drift',         365,   '1 year — organizational knowledge drift'),
    -- Sensitive records: listed for visibility but NOT purged automatically
    (p_org_id, 'governance_audit',       2555,   '7 years — immutable audit trail (not auto-purged)'),
    (p_org_id, 'merge_log',             2555,   '7 years — merge audit trail (not auto-purged)'),
    (p_org_id, 'executive_reviews',      730,   '2 years — weekly exec review snapshots')
  ON CONFLICT (org_id, resource_type) DO NOTHING;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H6c. run_crm_retention_purge — delete aged operational records per policy
--      governance_audit and merge_log are excluded from auto-purge (too sensitive)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_crm_retention_purge(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy RECORD;
  v_deleted INT := 0;
  v_report  JSONB := '{}';
  v_cutoff  DATE;
BEGIN
  PERFORM ensure_crm_retention_policies(p_org_id);

  FOR v_policy IN
    SELECT resource_type, retention_days
    FROM crm_retention_policies
    WHERE org_id = p_org_id AND is_active = TRUE
      -- Never auto-purge immutable governance records
      AND resource_type NOT IN ('governance_audit', 'merge_log')
  LOOP
    v_deleted := 0;
    v_cutoff  := now()::DATE - v_policy.retention_days;

    IF v_policy.resource_type = 'webhook_deliveries' THEN
      DELETE FROM crm_webhook_deliveries
      WHERE org_id = p_org_id
        AND status IN ('delivered', 'failed', 'skipped')
        AND created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'causal_events' THEN
      DELETE FROM crm_causal_events
      WHERE org_id = p_org_id
        AND cause_observed_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'signal_drift_events' THEN
      DELETE FROM crm_signal_drift_events
      WHERE org_id = p_org_id
        AND detected_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'portfolio_pulse' THEN
      DELETE FROM crm_portfolio_health_pulse
      WHERE org_id = p_org_id
        AND pulse_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'operating_consciousness' THEN
      DELETE FROM crm_operating_consciousness_snapshots
      WHERE org_id = p_org_id
        AND snapshot_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'relationship_snapshots' THEN
      -- Preserve the 30 most recent snapshots per contact regardless of age
      DELETE FROM crm_relationship_snapshots
      WHERE contact_id IN (SELECT id FROM crm_contacts WHERE org_id = p_org_id)
        AND snapshot_date < v_cutoff
        AND id NOT IN (
          SELECT id FROM (
            SELECT id,
              ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY snapshot_date DESC) AS rn
            FROM crm_relationship_snapshots
            WHERE contact_id IN (SELECT id FROM crm_contacts WHERE org_id = p_org_id)
          ) ranked WHERE rn <= 30
        );
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'portfolio_snapshots' THEN
      DELETE FROM crm_portfolio_snapshots
      WHERE org_id = p_org_id
        AND snapshot_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'integrity_violations' THEN
      DELETE FROM crm_integrity_violations
      WHERE org_id = p_org_id
        AND auto_resolved = TRUE
        AND violation_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'epistemic_drift' THEN
      DELETE FROM crm_epistemic_drift_snapshots
      WHERE org_id = p_org_id
        AND snapshot_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSIF v_policy.resource_type = 'executive_reviews' THEN
      DELETE FROM crm_executive_reviews
      WHERE org_id = p_org_id
        AND review_date < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;

    IF v_deleted > 0 THEN
      v_report := v_report || jsonb_build_object(v_policy.resource_type, v_deleted);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'org_id',     p_org_id,
    'purged_at',  now(),
    'deleted',    v_report
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H6d. Seed retention policies for all existing active orgs
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_org_id UUID;
BEGIN
  FOR v_org_id IN
    SELECT DISTINCT org_id FROM org_members
    WHERE org_id IN (SELECT id FROM organizations WHERE cancellation_status IS NULL)
  LOOP
    PERFORM ensure_crm_retention_policies(v_org_id);
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H6e. pg_cron: nightly retention purge for all active orgs at 3:30 UTC
-- ─────────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'crm_retention_purge',
  '30 3 * * *',
  $cron_body$
  DO $$
  DECLARE v_org_id UUID;
  BEGIN
    FOR v_org_id IN
      SELECT DISTINCT org_id FROM org_members
      WHERE org_id IN (SELECT id FROM organizations WHERE cancellation_status IS NULL)
    LOOP
      PERFORM run_crm_retention_purge(v_org_id);
    END LOOP;
  END;
  $$;
  $cron_body$
);
