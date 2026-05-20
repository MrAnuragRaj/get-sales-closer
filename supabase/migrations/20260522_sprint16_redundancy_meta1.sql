-- Sprint 16: Relationship Redundancy Scoring + Meta-Layer 1 (Organizational Knowledge Engine)
-- Critic suggestion: single-threaded champion dependency, sponsor backup coverage,
-- blocker counterweight presence, relationship diversification

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Redundancy columns on crm_contacts
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.crm_contacts
  ADD COLUMN IF NOT EXISTS redundancy_score  INT  DEFAULT 50
    CHECK (redundancy_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS redundancy_tier   TEXT DEFAULT 'moderate'
    CHECK (redundancy_tier IN ('critical','thin','moderate','resilient','redundant')),
  ADD COLUMN IF NOT EXISTS redundancy_drivers JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_crm_contacts_redundancy
  ON public.crm_contacts (org_id, redundancy_tier)
  WHERE redundancy_tier IN ('critical','thin');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. compute_crm_redundancy_scores
-- Per-company role landscape → redundancy score applied to all contacts at that company
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_redundancy_scores(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH company_roles AS (
    SELECT
      c.company,
      COUNT(DISTINCT cr.role)::INT                                                           AS role_diversity,
      COUNT(*) FILTER (WHERE cr.role = 'champion')::INT                                     AS champion_count,
      COUNT(*) FILTER (WHERE cr.role IN ('executive_sponsor','economic_buyer'))::INT        AS sponsor_count,
      COUNT(*) FILTER (WHERE cr.role = 'blocker')::INT                                      AS blocker_count,
      COUNT(DISTINCT c.id)::INT                                                              AS total_contacts
    FROM crm_contacts c
    LEFT JOIN crm_contact_roles cr ON cr.contact_id = c.id AND cr.org_id = p_org_id
    WHERE c.org_id = p_org_id AND c.company IS NOT NULL
    GROUP BY c.company
  ),
  hub_presence AS (
    SELECT c.company,
           bool_or(c.hub_type IN ('trust_hub','champion_hub')) AS has_protective_hub
    FROM crm_contacts c
    WHERE c.org_id = p_org_id AND c.company IS NOT NULL
    GROUP BY c.company
  ),
  company_scores AS (
    SELECT
      cr.company,
      LEAST(100, GREATEST(0,
        40                                                                     -- base
        + LEAST(20, cr.role_diversity * 7)                                    -- role diversity (max 20 at 3+ roles)
        + CASE WHEN cr.sponsor_count >= 2 THEN 20
               WHEN cr.sponsor_count = 1  THEN 8
               ELSE 0 END                                                      -- sponsor backup coverage
        + CASE WHEN cr.blocker_count = 0                    THEN 10
               WHEN COALESCE(hp.has_protective_hub, FALSE)  THEN  5           -- blocker counterweighted by hub
               ELSE -15 END                                                    -- unmitigated blocker penalty
        - CASE WHEN cr.champion_count = 1 AND cr.total_contacts >= 3 THEN 20
               ELSE 0 END                                                      -- single-threaded champion risk
        - CASE WHEN cr.champion_count = 0 THEN 15 ELSE 0 END                  -- no champion at all
      ))::INT AS redundancy_score,
      jsonb_build_object(
        'role_diversity',              cr.role_diversity,
        'champion_count',              cr.champion_count,
        'sponsor_count',               cr.sponsor_count,
        'blocker_count',               cr.blocker_count,
        'total_contacts',              cr.total_contacts,
        'single_threaded_champion',    (cr.champion_count = 1 AND cr.total_contacts >= 3),
        'sponsor_backup',              (cr.sponsor_count >= 2),
        'blocker_unmitigated',         (cr.blocker_count > 0 AND NOT COALESCE(hp.has_protective_hub, FALSE)),
        'blocker_counterweighted',     (cr.blocker_count > 0 AND COALESCE(hp.has_protective_hub, FALSE)),
        'no_champion',                 (cr.champion_count = 0)
      ) AS drivers
    FROM company_roles cr
    LEFT JOIN hub_presence hp ON hp.company = cr.company
  )
  UPDATE crm_contacts c
  SET
    redundancy_score  = cs.redundancy_score,
    redundancy_tier   = CASE
                          WHEN cs.redundancy_score >= 81 THEN 'redundant'
                          WHEN cs.redundancy_score >= 66 THEN 'resilient'
                          WHEN cs.redundancy_score >= 46 THEN 'moderate'
                          WHEN cs.redundancy_score >= 26 THEN 'thin'
                          ELSE 'critical'
                        END,
    redundancy_drivers = cs.drivers
  FROM company_scores cs
  WHERE c.org_id = p_org_id AND c.company = cs.company;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. get_crm_redundancy_summary — org-level redundancy overview
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_redundancy_summary(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'tier_distribution', (
      SELECT jsonb_object_agg(redundancy_tier, cnt) FROM (
        SELECT redundancy_tier, COUNT(DISTINCT company) AS cnt
        FROM crm_contacts WHERE org_id = p_org_id AND company IS NOT NULL
        GROUP BY redundancy_tier
      ) t
    ),
    'critical_accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'company', company, 'redundancy_score', MIN(redundancy_score),
        'total_contacts', COUNT(*),
        'drivers', MAX(redundancy_drivers)
      ) ORDER BY MIN(redundancy_score) ASC)
      FROM crm_contacts
      WHERE org_id = p_org_id AND redundancy_tier IN ('critical','thin') AND company IS NOT NULL
      GROUP BY company
      LIMIT 10
    ), '[]'::jsonb),
    'single_threaded_companies', (
      SELECT COUNT(DISTINCT company) FROM crm_contacts
      WHERE org_id = p_org_id AND company IS NOT NULL
        AND (redundancy_drivers->>'single_threaded_champion')::BOOLEAN = TRUE
    ),
    'no_sponsor_backup_companies', (
      SELECT COUNT(DISTINCT company) FROM crm_contacts
      WHERE org_id = p_org_id AND company IS NOT NULL
        AND (redundancy_drivers->>'sponsor_backup')::BOOLEAN = FALSE
    ),
    'unmitigated_blocker_companies', (
      SELECT COUNT(DISTINCT company) FROM crm_contacts
      WHERE org_id = p_org_id AND company IS NOT NULL
        AND (redundancy_drivers->>'blocker_unmitigated')::BOOLEAN = TRUE
    ),
    'avg_redundancy_score', (
      SELECT ROUND(AVG(redundancy_score)) FROM crm_contacts
      WHERE org_id = p_org_id AND company IS NOT NULL
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Meta-Layer 1: Organizational Knowledge Engine
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_organizational_learning_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL CHECK (event_type IN (
                            'principle_created','principle_reinforced','principle_contradicted',
                            'principle_deprecated','intervention_succeeded','intervention_failed',
                            'intervention_repeated_success','escalation_archetype_detected',
                            'contradiction_emerged','recovery_succeeded',
                            'playbook_invalidated','expansion_pattern_confirmed'
                          )),
  entity_type TEXT        NOT NULL DEFAULT 'system'
                            CHECK (entity_type IN ('contact','account','operator','team','principle','pattern','system')),
  entity_id   TEXT,
  description TEXT,
  evidence    JSONB       DEFAULT '{}',
  confidence  TEXT        NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  actor_type  TEXT        NOT NULL DEFAULT 'cron' CHECK (actor_type IN ('system','operator','cron')),
  actor_id    UUID,
  source_key  TEXT,       -- dedup key; unique identifier for this event instance within a window
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_organizational_learning_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_ole_org ON public.crm_organizational_learning_events
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_ole_org_type
  ON public.crm_organizational_learning_events (org_id, event_type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_ole_source_key
  ON public.crm_organizational_learning_events (org_id, source_key)
  WHERE source_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. crm_epistemic_drift_snapshots
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_epistemic_drift_snapshots (
  id                    UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_date         DATE  NOT NULL,
  drift_score           INT   NOT NULL DEFAULT 0 CHECK (drift_score BETWEEN 0 AND 100),
  drift_level           TEXT  NOT NULL DEFAULT 'stable'
                                CHECK (drift_level IN ('stable','drifting','diverging','collapsing')),
  principles_total      INT   DEFAULT 0,
  principles_aging      INT   DEFAULT 0,   -- not reinforced in 60+ days
  principles_contradicted INT DEFAULT 0,
  principles_confirmed  INT   DEFAULT 0,   -- reinforced in last 30d
  heuristics_failing    INT   DEFAULT 0,   -- patterns with declining effectiveness
  learning_velocity     TEXT  NOT NULL DEFAULT 'moderate'
                                CHECK (learning_velocity IN ('fast','moderate','slow','stagnant')),
  adaptation_summary    TEXT,
  UNIQUE (org_id, snapshot_date)
);

ALTER TABLE public.crm_epistemic_drift_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_eds_org ON public.crm_epistemic_drift_snapshots
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_eds_org_date
  ON public.crm_epistemic_drift_snapshots (org_id, snapshot_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. log_crm_learning_event — operator-triggered event logging
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_crm_learning_event(
  p_org_id    UUID,
  p_event_type TEXT,
  p_entity_type TEXT,
  p_entity_id  TEXT,
  p_description TEXT,
  p_evidence   JSONB DEFAULT '{}',
  p_confidence TEXT DEFAULT 'medium',
  p_actor_id   UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, actor_id)
  VALUES
    (p_org_id, p_event_type, p_entity_type, p_entity_id, p_description, p_evidence, p_confidence, 'operator', p_actor_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. compute_crm_learning_events — nightly scan of existing tables → log events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_learning_events(p_org_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT := 0; v_rc INT;
BEGIN
  -- 1. Principle reinforcements (newly reinforced in last 2 days, not yet logged today)
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, source_key)
  SELECT p_org_id, 'principle_reinforced', 'principle', rp.id::TEXT,
    'Principle "' || rp.name || '" confirmed — effectiveness=' || ROUND(COALESCE(rp.effectiveness_rate,0)*100) || '%',
    jsonb_build_object('effectiveness_rate', rp.effectiveness_rate,
                       'reinforcement_trend', rp.reinforcement_trend,
                       'memory_class', rp.memory_class),
    CASE WHEN COALESCE(rp.effectiveness_rate,0) >= 0.75 THEN 'high'
         WHEN COALESCE(rp.effectiveness_rate,0) >= 0.5  THEN 'medium' ELSE 'low' END,
    'cron', 'reinforced_' || rp.id::TEXT || '_' || CURRENT_DATE::TEXT
  FROM crm_relationship_principles rp
  WHERE rp.org_id = p_org_id
    AND rp.last_reinforced_at >= now() - INTERVAL '2 days'
    AND COALESCE(rp.effectiveness_rate, 0) >= 0.5
    AND NOT EXISTS (
      SELECT 1 FROM crm_organizational_learning_events
      WHERE org_id = p_org_id
        AND source_key = 'reinforced_' || rp.id::TEXT || '_' || CURRENT_DATE::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- 2. Principle contradictions (newly contradicted, not yet logged this week)
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, source_key)
  SELECT p_org_id, 'principle_contradicted', 'principle', rp.id::TEXT,
    'Principle "' || rp.name || '" is losing reliability — ' || COALESCE(rp.contradiction_count,0) || ' contradictions',
    jsonb_build_object('contradiction_count', rp.contradiction_count,
                       'memory_class', rp.memory_class,
                       'effectiveness_rate', rp.effectiveness_rate),
    'medium', 'cron', 'contradicted_' || rp.id::TEXT || '_' || DATE_TRUNC('week', CURRENT_DATE)::TEXT
  FROM crm_relationship_principles rp
  WHERE rp.org_id = p_org_id
    AND COALESCE(rp.contradiction_count, 0) > 0
    AND rp.reinforcement_trend IN ('declining','unknown')
    AND NOT EXISTS (
      SELECT 1 FROM crm_organizational_learning_events
      WHERE org_id = p_org_id
        AND source_key = 'contradicted_' || rp.id::TEXT || '_' || DATE_TRUNC('week', CURRENT_DATE)::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- 3. Successful recoveries: contacts that were high churn, got resolved escalation, now churn < 40
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, source_key)
  SELECT p_org_id, 'recovery_succeeded', 'contact', e.contact_id::TEXT,
    'Contact at ' || COALESCE(c.company,'unknown') || ' recovered: churn ' ||
      COALESCE(ps.churn_probability,0) || '% (was critical, escalation resolved)',
    jsonb_build_object('current_churn', ps.churn_probability,
                       'escalation_id', e.id,
                       'resolution_type', e.resolution_notes,
                       'company', c.company),
    'high', 'cron',
    'recovery_' || e.contact_id::TEXT || '_' || e.id::TEXT
  FROM crm_escalations e
  JOIN crm_contacts c ON c.id = e.contact_id AND c.org_id = p_org_id
  LEFT JOIN crm_predictive_scores ps ON ps.contact_id = e.contact_id
  WHERE e.org_id = p_org_id
    AND e.execution_state = 'resolved'
    AND e.resolved_at >= now() - INTERVAL '7 days'
    AND COALESCE(ps.churn_probability, 100) < 40
    AND NOT EXISTS (
      SELECT 1 FROM crm_organizational_learning_events
      WHERE org_id = p_org_id
        AND source_key = 'recovery_' || e.contact_id::TEXT || '_' || e.id::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- 4. Repeated intervention successes: operational patterns with high effectiveness
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, source_key)
  SELECT p_org_id, 'intervention_repeated_success', 'pattern', op.id::TEXT,
    'Pattern "' || op.pattern_type || '" is consistently effective — ' ||
      ROUND(COALESCE(op.effectiveness_rate,0)*100) || '% effectiveness (' || COALESCE(op.sample_size,0) || ' samples)',
    jsonb_build_object('pattern_type', op.pattern_type,
                       'effectiveness_rate', op.effectiveness_rate,
                       'sample_size', op.sample_size,
                       'learning_confidence', op.learning_confidence),
    CASE WHEN COALESCE(op.learning_confidence,'low') = 'high' THEN 'high' ELSE 'medium' END,
    'cron', 'pattern_success_' || op.id::TEXT || '_' || DATE_TRUNC('week', CURRENT_DATE)::TEXT
  FROM crm_operational_patterns op
  WHERE op.org_id = p_org_id
    AND COALESCE(op.effectiveness_rate, 0) >= 0.70
    AND COALESCE(op.sample_size, 0) >= 5
    AND NOT EXISTS (
      SELECT 1 FROM crm_organizational_learning_events
      WHERE org_id = p_org_id
        AND source_key = 'pattern_success_' || op.id::TEXT || '_' || DATE_TRUNC('week', CURRENT_DATE)::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  -- 5. Expansion pattern confirmed: orgs with 3+ expansion_opportunities resolved positively
  INSERT INTO crm_organizational_learning_events
    (org_id, event_type, entity_type, entity_id, description, evidence, confidence, actor_type, source_key)
  SELECT p_org_id, 'expansion_pattern_confirmed', 'system', NULL,
    'Expansion pattern confirmed: ' || cnt || ' expansion-ready contacts identified this cycle',
    jsonb_build_object('expansion_ready_count', cnt, 'avg_readiness', avg_readiness),
    'medium', 'cron', 'expansion_pattern_' || CURRENT_DATE::TEXT
  FROM (
    SELECT COUNT(*)::INT AS cnt, ROUND(AVG(expansion_readiness_score)) AS avg_readiness
    FROM crm_contacts
    WHERE org_id = p_org_id AND expansion_readiness_score >= 60
  ) t
  WHERE cnt >= 3
    AND NOT EXISTS (
      SELECT 1 FROM crm_organizational_learning_events
      WHERE org_id = p_org_id AND source_key = 'expansion_pattern_' || CURRENT_DATE::TEXT
    );
  GET DIAGNOSTICS v_rc = ROW_COUNT; v_count := v_count + v_rc;

  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. compute_crm_epistemic_drift — nightly snapshot of knowledge health
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_epistemic_drift(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total INT; v_aging INT; v_contradicted INT; v_confirmed INT;
  v_failing INT; v_drift_score INT; v_drift_level TEXT; v_velocity TEXT;
  v_summary TEXT;
BEGIN
  -- Count principle states
  SELECT
    COUNT(*)::INT,
    COUNT(*) FILTER (WHERE COALESCE(last_reinforced_at, created_at) < now() - INTERVAL '60 days')::INT,
    COUNT(*) FILTER (WHERE COALESCE(contradiction_count,0) > 0 AND reinforcement_trend = 'declining')::INT,
    COUNT(*) FILTER (WHERE last_reinforced_at >= now() - INTERVAL '30 days' AND COALESCE(effectiveness_rate,0) >= 0.5)::INT
  INTO v_total, v_aging, v_contradicted, v_confirmed
  FROM crm_relationship_principles
  WHERE org_id = p_org_id AND is_active;

  -- Count failing operational patterns
  SELECT COUNT(*)::INT INTO v_failing
  FROM crm_operational_patterns
  WHERE org_id = p_org_id AND COALESCE(effectiveness_rate, 0) < 0.30;

  -- Compute drift score (higher = worse)
  v_drift_score := LEAST(100, GREATEST(0,
    COALESCE(v_aging, 0) * 5
    + COALESCE(v_contradicted, 0) * 12
    + COALESCE(v_failing, 0) * 8
    - COALESCE(v_confirmed, 0) * 6
  ));

  -- Drift level
  v_drift_level := CASE
    WHEN v_drift_score >= 70 THEN 'collapsing'
    WHEN v_drift_score >= 45 THEN 'diverging'
    WHEN v_drift_score >= 20 THEN 'drifting'
    ELSE 'stable'
  END;

  -- Learning velocity (how fast the org updates its knowledge)
  v_velocity := CASE
    WHEN v_confirmed >= 5 AND v_contradicted <= 1 THEN 'fast'
    WHEN v_confirmed >= 3 THEN 'moderate'
    WHEN v_confirmed >= 1 THEN 'slow'
    ELSE 'stagnant'
  END;

  -- Deterministic narrative
  v_summary := CASE
    WHEN v_drift_level = 'collapsing' THEN
      'Organizational knowledge is critically degraded — ' || COALESCE(v_contradicted,0) ||
      ' failing heuristics, ' || COALESCE(v_aging,0) || ' stale principles. Immediate review required.'
    WHEN v_drift_level = 'diverging' THEN
      'Knowledge base is diverging from reality — ' || COALESCE(v_aging,0) || ' principles aging without validation.'
    WHEN v_drift_level = 'drifting' THEN
      COALESCE(v_confirmed,0) || ' principles confirmed this month but ' ||
      COALESCE(v_contradicted,0) || ' showing contradictions. Monitor closely.'
    ELSE
      COALESCE(v_confirmed,0) || ' of ' || COALESCE(v_total,0) ||
      ' active principles reinforced this month. Knowledge base is current.'
  END;

  INSERT INTO crm_epistemic_drift_snapshots
    (org_id, snapshot_date, drift_score, drift_level, principles_total,
     principles_aging, principles_contradicted, principles_confirmed,
     heuristics_failing, learning_velocity, adaptation_summary)
  VALUES
    (p_org_id, CURRENT_DATE, v_drift_score, v_drift_level, COALESCE(v_total,0),
     COALESCE(v_aging,0), COALESCE(v_contradicted,0), COALESCE(v_confirmed,0),
     COALESCE(v_failing,0), v_velocity, v_summary)
  ON CONFLICT (org_id, snapshot_date) DO UPDATE SET
    drift_score             = EXCLUDED.drift_score,
    drift_level             = EXCLUDED.drift_level,
    principles_total        = EXCLUDED.principles_total,
    principles_aging        = EXCLUDED.principles_aging,
    principles_contradicted = EXCLUDED.principles_contradicted,
    principles_confirmed    = EXCLUDED.principles_confirmed,
    heuristics_failing      = EXCLUDED.heuristics_failing,
    learning_velocity       = EXCLUDED.learning_velocity,
    adaptation_summary      = EXCLUDED.adaptation_summary;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. get_crm_organizational_knowledge — unified knowledge engine query
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_organizational_knowledge(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'epistemic_drift', (
      SELECT to_jsonb(eds.*) FROM crm_epistemic_drift_snapshots eds
      WHERE org_id = p_org_id ORDER BY snapshot_date DESC LIMIT 1
    ),
    'drift_trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'date', snapshot_date, 'drift_score', drift_score, 'drift_level', drift_level
      ) ORDER BY snapshot_date DESC)
      FROM crm_epistemic_drift_snapshots WHERE org_id = p_org_id
      ORDER BY snapshot_date DESC LIMIT 7
    ), '[]'::jsonb),
    'recent_learning_events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'event_type', event_type, 'entity_type', entity_type,
        'description', description, 'confidence', confidence, 'recorded_at', recorded_at
      ) ORDER BY recorded_at DESC)
      FROM crm_organizational_learning_events
      WHERE org_id = p_org_id AND recorded_at >= now() - INTERVAL '30 days'
      ORDER BY recorded_at DESC LIMIT 20
    ), '[]'::jsonb),
    'event_type_counts', (
      SELECT jsonb_object_agg(event_type, cnt) FROM (
        SELECT event_type, COUNT(*) AS cnt
        FROM crm_organizational_learning_events
        WHERE org_id = p_org_id AND recorded_at >= now() - INTERVAL '30 days'
        GROUP BY event_type
      ) t
    ),
    'recovery_count_30d', (
      SELECT COUNT(*) FROM crm_organizational_learning_events
      WHERE org_id = p_org_id AND event_type = 'recovery_succeeded'
        AND recorded_at >= now() - INTERVAL '30 days'
    ),
    'intervention_success_rate', (
      SELECT CASE WHEN total > 0 THEN ROUND(successes::NUMERIC / total * 100) ELSE 0 END
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'intervention_succeeded') AS successes,
          COUNT(*) FILTER (WHERE event_type IN ('intervention_succeeded','intervention_failed')) AS total
        FROM crm_organizational_learning_events
        WHERE org_id = p_org_id AND recorded_at >= now() - INTERVAL '30 days'
      ) t
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. compute_crm_sprint16_nightly wrapper
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_sprint16_nightly(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM compute_crm_redundancy_scores(p_org_id);
  PERFORM compute_crm_learning_events(p_org_id);
  PERFORM compute_crm_epistemic_drift(p_org_id);
END;
$$;

-- pg_cron: after sprint 15 (30 7 UTC). Use 45 7 UTC.
SELECT cron.schedule(
  'compute_crm_sprint16_nightly',
  '45 7 * * *',
  $$SELECT compute_crm_sprint16_nightly(id) FROM organizations WHERE cancellation_status IS NULL$$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Initial compute for all active orgs
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE cancellation_status IS NULL LOOP
    BEGIN
      PERFORM compute_crm_sprint16_nightly(r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;
