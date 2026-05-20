-- Sprint 19: Meta-Layer 6 — Strategic Operating Consciousness
-- The final synthesis layer: cross-system aggregation into a single organizational
-- strategic self-awareness snapshot. Six dimensions — from attention collapse to
-- strategic fragility — produce a consciousness_level and synthesis narrative.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crm_operating_consciousness_snapshots
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_operating_consciousness_snapshots (
  id                           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                       UUID  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_date                DATE  NOT NULL,
  -- Six strategic dimensions (0-100, higher = worse)
  attention_collapse_score     INT   NOT NULL DEFAULT 0 CHECK (attention_collapse_score BETWEEN 0 AND 100),
  trust_erosion_index          INT   NOT NULL DEFAULT 0 CHECK (trust_erosion_index BETWEEN 0 AND 100),
  expansion_sustainability_score INT NOT NULL DEFAULT 50 CHECK (expansion_sustainability_score BETWEEN 0 AND 100),
  cognition_overload_score     INT   NOT NULL DEFAULT 0 CHECK (cognition_overload_score BETWEEN 0 AND 100),
  memory_degradation_score     INT   NOT NULL DEFAULT 0 CHECK (memory_degradation_score BETWEEN 0 AND 100),
  strategic_fragility_score    INT   NOT NULL DEFAULT 0 CHECK (strategic_fragility_score BETWEEN 0 AND 100),
  -- Overall assessment
  overall_risk_score           INT   NOT NULL DEFAULT 0 CHECK (overall_risk_score BETWEEN 0 AND 100),
  consciousness_level          TEXT  NOT NULL DEFAULT 'monitoring'
                                       CHECK (consciousness_level IN ('aware','monitoring','strained','critical','degraded')),
  highest_risk_domain          TEXT,   -- which of the 6 dimensions is worst
  synthesis_narrative          TEXT,   -- deterministic 2-3 sentence summary
  recommended_priority         TEXT,   -- what operational area needs attention first
  UNIQUE (org_id, snapshot_date)
);

ALTER TABLE public.crm_operating_consciousness_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_ocs_org ON public.crm_operating_consciousness_snapshots
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_ocs_org_date
  ON public.crm_operating_consciousness_snapshots (org_id, snapshot_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. compute_crm_operating_consciousness
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_operating_consciousness(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Dimension scores
  v_attention_collapse    INT := 0;
  v_trust_erosion         INT := 0;
  v_expansion_sustainability INT := 50;  -- inverted: high = GOOD
  v_cognition_overload    INT := 0;
  v_memory_degradation    INT := 0;
  v_strategic_fragility   INT := 0;
  -- Derived
  v_overall_risk          INT := 0;
  v_level                 TEXT;
  v_highest_domain        TEXT;
  v_narrative             TEXT;
  v_priority              TEXT;
  -- Source values
  v_debt_score            INT := 0;
  v_calmness              INT := 100;
  v_fatigue_avg           INT := 0;
  v_broken_pct            NUMERIC := 0;
  v_strained_pct          NUMERIC := 0;
  v_total_contacts        INT := 0;
  v_cognitive_heavy_pct   NUMERIC := 0;
  v_drift_score           INT := 0;
  v_critical_fragility_pct NUMERIC := 0;
  v_isolation_pct         NUMERIC := 0;
  v_expansion_ready_count INT := 0;
  v_high_churn_count      INT := 0;
BEGIN
  -- ── Source: attention debt
  SELECT COALESCE(debt_score, 0) INTO v_debt_score
  FROM crm_attention_debt_snapshots
  WHERE org_id = p_org_id ORDER BY snapshot_date DESC LIMIT 1;

  -- ── Source: queue calmness (inverted — low calmness = high collapse)
  SELECT COALESCE(calmness_score, 100) INTO v_calmness
  FROM crm_org_calmness_snapshots
  WHERE org_id = p_org_id ORDER BY snapshot_date DESC LIMIT 1;

  -- ── Source: operator fatigue average
  SELECT COALESCE(ROUND(AVG(fatigue_score)), 0) INTO v_fatigue_avg
  FROM crm_operator_fatigue WHERE org_id = p_org_id
    AND computed_date = CURRENT_DATE;

  -- ── Dimension 1: Attention Collapse
  -- = debt (40%) + calmness_inverse (35%) + fatigue (25%)
  v_attention_collapse := LEAST(100, (
    COALESCE(v_debt_score, 0) * 0.4
    + (100 - COALESCE(v_calmness, 100)) * 0.35
    + COALESCE(v_fatigue_avg, 0) * 0.25
  ))::INT;

  -- ── Source: trust state distribution
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE trust_state = 'broken')::NUMERIC,
    COUNT(*) FILTER (WHERE trust_state = 'strained')::NUMERIC
  INTO v_total_contacts, v_broken_pct, v_strained_pct
  FROM crm_contacts WHERE org_id = p_org_id;

  IF v_total_contacts > 0 THEN
    v_broken_pct  := (v_broken_pct  / v_total_contacts) * 100;
    v_strained_pct := (v_strained_pct / v_total_contacts) * 100;
  END IF;

  -- ── Dimension 2: Trust Erosion
  -- = broken_pct * 0.6 + strained_pct * 0.25
  v_trust_erosion := LEAST(100, (
    COALESCE(v_broken_pct, 0) * 0.6
    + COALESCE(v_strained_pct, 0) * 0.25
  ))::INT;

  -- ── Source: expansion vs churn balance
  SELECT
    COUNT(*) FILTER (WHERE expansion_readiness_score >= 60)::INT,
    COUNT(*) FILTER (WHERE churn_probability >= 60)::INT
  INTO v_expansion_ready_count, v_high_churn_count
  FROM crm_contacts c
  LEFT JOIN crm_predictive_scores ps ON ps.contact_id = c.id
  WHERE c.org_id = p_org_id;

  -- ── Dimension 3: Expansion Sustainability (higher = BETTER; inverted for overall risk)
  v_expansion_sustainability := LEAST(100, GREATEST(0,
    50
    + CASE WHEN v_total_contacts > 0
        THEN (v_expansion_ready_count::NUMERIC / v_total_contacts * 50)::INT
             - (v_high_churn_count::NUMERIC    / v_total_contacts * 40)::INT
        ELSE 0
      END
  ));

  -- ── Source: cognitive load distribution
  SELECT
    COUNT(*) FILTER (WHERE cognitive_load_level IN ('heavy','critical'))::NUMERIC
  INTO v_cognitive_heavy_pct
  FROM crm_contacts WHERE org_id = p_org_id;
  IF v_total_contacts > 0 THEN
    v_cognitive_heavy_pct := (v_cognitive_heavy_pct / v_total_contacts) * 100;
  END IF;

  -- ── Dimension 4: Cognition Overload
  v_cognition_overload := LEAST(100, (
    COALESCE(v_cognitive_heavy_pct, 0) * 0.5
    + COALESCE(v_fatigue_avg, 0) * 0.5
  ))::INT;

  -- ── Source: epistemic drift
  SELECT COALESCE(drift_score, 0) INTO v_drift_score
  FROM crm_epistemic_drift_snapshots
  WHERE org_id = p_org_id ORDER BY snapshot_date DESC LIMIT 1;

  -- ── Dimension 5: Memory Degradation (= epistemic drift)
  v_memory_degradation := COALESCE(v_drift_score, 0);

  -- ── Source: structural fragility distribution
  SELECT
    COUNT(*) FILTER (WHERE structural_fragility = 'critical')::NUMERIC,
    COUNT(*) FILTER (WHERE hub_type = 'isolation_node')::NUMERIC
  INTO v_critical_fragility_pct, v_isolation_pct
  FROM crm_contacts WHERE org_id = p_org_id;
  IF v_total_contacts > 0 THEN
    v_critical_fragility_pct := (v_critical_fragility_pct / v_total_contacts) * 100;
    v_isolation_pct           := (v_isolation_pct          / v_total_contacts) * 100;
  END IF;

  -- ── Dimension 6: Strategic Fragility
  v_strategic_fragility := LEAST(100, (
    COALESCE(v_critical_fragility_pct, 0) * 0.6
    + COALESCE(v_isolation_pct, 0) * 0.4
  ))::INT;

  -- ── Overall Risk Score (weighted average; expansion_sustainability inverted)
  v_overall_risk := LEAST(100, (
    v_attention_collapse    * 0.20
    + v_trust_erosion       * 0.20
    + (100 - v_expansion_sustainability) * 0.15  -- inverted
    + v_cognition_overload  * 0.15
    + v_memory_degradation  * 0.15
    + v_strategic_fragility * 0.15
  ))::INT;

  -- ── Consciousness Level
  v_level := CASE
    WHEN v_overall_risk >= 72 THEN 'degraded'
    WHEN v_overall_risk >= 55 THEN 'critical'
    WHEN v_overall_risk >= 38 THEN 'strained'
    WHEN v_overall_risk >= 20 THEN 'monitoring'
    ELSE 'aware'
  END;

  -- ── Highest Risk Domain
  v_highest_domain := (
    SELECT domain FROM (VALUES
      ('attention_collapse',      v_attention_collapse),
      ('trust_erosion',           v_trust_erosion),
      ('expansion_sustainability', (100 - v_expansion_sustainability)),
      ('cognition_overload',      v_cognition_overload),
      ('memory_degradation',      v_memory_degradation),
      ('strategic_fragility',     v_strategic_fragility)
    ) AS dims(domain, score)
    ORDER BY score DESC LIMIT 1
  );

  -- ── Deterministic Narrative
  v_narrative := CASE v_level
    WHEN 'degraded' THEN
      'Organizational operating capacity is severely degraded across multiple dimensions — '
      || v_highest_domain || ' is the primary failure point. Immediate executive intervention required.'
    WHEN 'critical' THEN
      'Critical stress detected: ' || v_highest_domain || ' is at risk. '
      || 'Trust erosion at ' || v_trust_erosion || '/100 and attention collapse at '
      || v_attention_collapse || '/100 are compounding.'
    WHEN 'strained' THEN
      'Organizational operating system is strained. '
      || v_highest_domain || ' is the leading edge of risk. '
      || v_expansion_ready_count || ' expansion-ready contacts vs '
      || v_high_churn_count || ' high-churn contacts.'
    WHEN 'monitoring' THEN
      'Operational health is stable with watchpoints. '
      || 'Expansion sustainability at ' || v_expansion_sustainability || '/100. '
      || 'Memory integrity: ' || CASE WHEN v_drift_score < 20 THEN 'current' ELSE 'showing drift' END || '.'
    ELSE
      'Organizational operating system is in a healthy, aware state. '
      || v_expansion_ready_count || ' expansion opportunities active, '
      || v_high_churn_count || ' high-churn contacts being managed.'
  END;

  -- ── Recommended Priority
  v_priority := CASE v_highest_domain
    WHEN 'attention_collapse'      THEN 'Reduce operator load: resolve critical escalations, suppress stale signals'
    WHEN 'trust_erosion'           THEN 'Address broken trust: log trust fractures, activate recovery campaigns'
    WHEN 'expansion_sustainability' THEN 'Rebalance portfolio: accelerate expansion contacts, reduce churn drag'
    WHEN 'cognition_overload'       THEN 'Simplify workload: resolve high-cognitive-load accounts, reassign owners'
    WHEN 'memory_degradation'       THEN 'Refresh knowledge base: validate aging principles, log new learnings'
    WHEN 'strategic_fragility'      THEN 'Strengthen structure: address isolation nodes, counterbalance blockers'
    ELSE 'Maintain current operational cadence'
  END;

  INSERT INTO crm_operating_consciousness_snapshots
    (org_id, snapshot_date, attention_collapse_score, trust_erosion_index,
     expansion_sustainability_score, cognition_overload_score, memory_degradation_score,
     strategic_fragility_score, overall_risk_score, consciousness_level,
     highest_risk_domain, synthesis_narrative, recommended_priority)
  VALUES
    (p_org_id, CURRENT_DATE, v_attention_collapse, v_trust_erosion,
     v_expansion_sustainability, v_cognition_overload, v_memory_degradation,
     v_strategic_fragility, v_overall_risk, v_level,
     v_highest_domain, v_narrative, v_priority)
  ON CONFLICT (org_id, snapshot_date) DO UPDATE SET
    attention_collapse_score      = EXCLUDED.attention_collapse_score,
    trust_erosion_index           = EXCLUDED.trust_erosion_index,
    expansion_sustainability_score = EXCLUDED.expansion_sustainability_score,
    cognition_overload_score      = EXCLUDED.cognition_overload_score,
    memory_degradation_score      = EXCLUDED.memory_degradation_score,
    strategic_fragility_score     = EXCLUDED.strategic_fragility_score,
    overall_risk_score            = EXCLUDED.overall_risk_score,
    consciousness_level           = EXCLUDED.consciousness_level,
    highest_risk_domain           = EXCLUDED.highest_risk_domain,
    synthesis_narrative           = EXCLUDED.synthesis_narrative,
    recommended_priority          = EXCLUDED.recommended_priority;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. get_crm_operating_consciousness
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_operating_consciousness(
  p_org_id UUID,
  p_days   INT DEFAULT 14
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'current', (
      SELECT to_jsonb(ocs.*) FROM crm_operating_consciousness_snapshots ocs
      WHERE org_id = p_org_id ORDER BY snapshot_date DESC LIMIT 1
    ),
    'trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'date', snapshot_date,
        'overall_risk_score', overall_risk_score,
        'consciousness_level', consciousness_level,
        'attention_collapse_score', attention_collapse_score,
        'trust_erosion_index', trust_erosion_index,
        'strategic_fragility_score', strategic_fragility_score
      ) ORDER BY snapshot_date DESC)
      FROM crm_operating_consciousness_snapshots
      WHERE org_id = p_org_id
        AND snapshot_date >= CURRENT_DATE - p_days
      ORDER BY snapshot_date DESC
    ), '[]'::jsonb)
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. compute_crm_sprint19_nightly + pg_cron
-- Run LAST — depends on all other nightly layers being complete
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_sprint19_nightly(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM compute_crm_operating_consciousness(p_org_id);
END;
$$;

SELECT cron.schedule(
  'compute_crm_sprint19_nightly',
  '30 8 * * *',
  $$SELECT compute_crm_sprint19_nightly(id) FROM organizations WHERE cancellation_status IS NULL$$
);

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE cancellation_status IS NULL LOOP
    BEGIN PERFORM compute_crm_sprint19_nightly(r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;
