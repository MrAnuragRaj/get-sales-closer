-- Sprint 17: Meta-Layer 4 — Strategic Relationship Economics
-- Translates relationship quality signals into economic cost + leverage language:
-- attention_cost, coordination_cost, escalation_cost, maintenance_cost (costs)
-- strategic_leverage, political_leverage, network_leverage (leverage)
-- → economic_efficiency_score + economics_tier

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crm_relationship_economics table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_relationship_economics (
  id                       UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID  NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id               UUID  NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  -- Costs (higher = more expensive)
  attention_cost           INT   NOT NULL DEFAULT 0 CHECK (attention_cost BETWEEN 0 AND 100),
  coordination_cost        INT   NOT NULL DEFAULT 0 CHECK (coordination_cost BETWEEN 0 AND 100),
  escalation_cost          INT   NOT NULL DEFAULT 0 CHECK (escalation_cost BETWEEN 0 AND 100),
  maintenance_cost         INT   NOT NULL DEFAULT 0 CHECK (maintenance_cost BETWEEN 0 AND 100),
  total_cost               INT   NOT NULL DEFAULT 0 CHECK (total_cost BETWEEN 0 AND 100),
  -- Leverage (higher = more value)
  strategic_leverage       INT   NOT NULL DEFAULT 0 CHECK (strategic_leverage BETWEEN 0 AND 100),
  political_leverage       INT   NOT NULL DEFAULT 0 CHECK (political_leverage BETWEEN 0 AND 100),
  network_leverage         INT   NOT NULL DEFAULT 0 CHECK (network_leverage BETWEEN 0 AND 100),
  total_leverage           INT   NOT NULL DEFAULT 0 CHECK (total_leverage BETWEEN 0 AND 100),
  -- Efficiency
  economic_efficiency_score INT  NOT NULL DEFAULT 50 CHECK (economic_efficiency_score BETWEEN 0 AND 100),
  economics_tier           TEXT  NOT NULL DEFAULT 'break_even'
                                   CHECK (economics_tier IN ('draining','costly','break_even','efficient','high_leverage')),
  cost_narrative           TEXT,
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, contact_id)
);

ALTER TABLE public.crm_relationship_economics ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_re_org ON public.crm_relationship_economics
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_re_org_tier
  ON public.crm_relationship_economics (org_id, economics_tier);
CREATE INDEX IF NOT EXISTS idx_crm_re_efficiency
  ON public.crm_relationship_economics (org_id, economic_efficiency_score DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. compute_crm_relationship_economics
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_relationship_economics(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH escalation_costs AS (
    SELECT
      contact_id,
      LEAST(100,
        SUM(CASE priority
          WHEN 'critical' THEN 20
          WHEN 'high'     THEN 12
          WHEN 'medium'   THEN 6
          ELSE 2
        END) * CASE WHEN COUNT(*) FILTER (WHERE sla_breached) > 0 THEN 1.3 ELSE 1.0 END
      )::INT AS esc_cost
    FROM crm_escalations
    WHERE org_id = p_org_id
      AND created_at >= now() - INTERVAL '90 days'
    GROUP BY contact_id
  ),
  scored AS (
    SELECT
      c.id AS contact_id,

      -- attention_cost: cognitive_load + open escalations + recent burst activity
      LEAST(100, COALESCE(c.cognitive_load_score, 0)
        + CASE WHEN EXISTS (
            SELECT 1 FROM crm_escalations e
            WHERE e.contact_id = c.id AND e.execution_state IN ('open','assigned','in_progress')
          ) THEN 20 ELSE 0 END
      )::INT AS attention_cost,

      -- coordination_cost: mirrors maintenance_burden (captures ownership changes, asymmetry, interventions)
      COALESCE(c.maintenance_burden, 0)::INT AS coordination_cost,

      -- escalation_cost: from escalation history
      COALESCE(ec.esc_cost, 0)::INT AS escalation_cost,

      -- maintenance_cost: direct maintenance burden score
      COALESCE(c.maintenance_burden, 0)::INT AS maintenance_cost,

      -- strategic_leverage: tier + expansion readiness + advocacy
      LEAST(100,
        CASE c.strategic_tier
          WHEN 'flagship'         THEN 40
          WHEN 'anchor'           THEN 35
          WHEN 'strategic_logo'   THEN 30
          WHEN 'investor_visible' THEN 25
          WHEN 'case_study'       THEN 18
          ELSE 10
        END
        + LEAST(30, COALESCE(c.expansion_readiness_score, 0) * 0.3)
        + LEAST(20, COALESCE(c.advocacy_score, 0) * 0.2)
      )::INT AS strategic_leverage,

      -- political_leverage: influence + hub type + trust + capital
      LEAST(100,
        COALESCE(c.influence_score, 0) * 0.6
        + CASE c.hub_type
            WHEN 'trust_hub'    THEN 20
            WHEN 'champion_hub' THEN 15
            WHEN 'blocker_hub'  THEN 5   -- blocker has political presence but negative leverage
            ELSE 0
          END
        + LEAST(15, COALESCE(c.relationship_capital_score, 0) / 6)
      )::INT AS political_leverage,

      -- network_leverage: edge count + hub position
      LEAST(100,
        COALESCE(c.influence_score, 0) * 0.4
        + CASE c.hub_type
            WHEN 'trust_hub'     THEN 25
            WHEN 'champion_hub'  THEN 20
            WHEN 'isolation_node' THEN -10
            ELSE 0
          END
        + LEAST(20, COALESCE(c.loyalty_score, 0) * 0.2)
      )::INT AS network_leverage

    FROM crm_contacts c
    LEFT JOIN escalation_costs ec ON ec.contact_id = c.id
    WHERE c.org_id = p_org_id
  ),
  with_totals AS (
    SELECT *,
      (attention_cost + coordination_cost + escalation_cost + maintenance_cost) / 4 AS avg_cost,
      (strategic_leverage + political_leverage + network_leverage) / 3               AS avg_leverage
    FROM scored
  ),
  with_efficiency AS (
    SELECT *,
      LEAST(100, GREATEST(0,
        ((avg_leverage - avg_cost + 100) / 2)::INT
      )) AS eff_score
    FROM with_totals
  )
  INSERT INTO crm_relationship_economics
    (org_id, contact_id, attention_cost, coordination_cost, escalation_cost, maintenance_cost,
     total_cost, strategic_leverage, political_leverage, network_leverage, total_leverage,
     economic_efficiency_score, economics_tier, cost_narrative, computed_at)
  SELECT
    p_org_id,
    contact_id,
    attention_cost, coordination_cost, escalation_cost, maintenance_cost,
    avg_cost::INT,
    strategic_leverage, political_leverage, network_leverage,
    avg_leverage::INT,
    eff_score,
    CASE
      WHEN eff_score >= 72 THEN 'high_leverage'
      WHEN eff_score >= 57 THEN 'efficient'
      WHEN eff_score >= 43 THEN 'break_even'
      WHEN eff_score >= 28 THEN 'costly'
      ELSE 'draining'
    END,
    CASE
      WHEN eff_score >= 72 THEN 'High strategic value relative to operational cost — prioritize expansion'
      WHEN eff_score >= 57 THEN 'Positive returns — relationship investment is paying off'
      WHEN eff_score >= 43 THEN 'Cost and leverage roughly balanced — monitor for drift'
      WHEN eff_score >= 28 THEN 'Costs outpacing strategic value — review engagement approach'
      ELSE 'This relationship is consuming significant resources with limited strategic return'
    END,
    now()
  FROM with_efficiency
  ON CONFLICT (org_id, contact_id) DO UPDATE SET
    attention_cost           = EXCLUDED.attention_cost,
    coordination_cost        = EXCLUDED.coordination_cost,
    escalation_cost          = EXCLUDED.escalation_cost,
    maintenance_cost         = EXCLUDED.maintenance_cost,
    total_cost               = EXCLUDED.total_cost,
    strategic_leverage       = EXCLUDED.strategic_leverage,
    political_leverage       = EXCLUDED.political_leverage,
    network_leverage         = EXCLUDED.network_leverage,
    total_leverage           = EXCLUDED.total_leverage,
    economic_efficiency_score = EXCLUDED.economic_efficiency_score,
    economics_tier           = EXCLUDED.economics_tier,
    cost_narrative           = EXCLUDED.cost_narrative,
    computed_at              = now();
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. get_crm_relationship_economics — per-contact economics detail
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_relationship_economics(p_org_id UUID, p_contact_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT to_jsonb(re.*) INTO v_result
  FROM crm_relationship_economics re
  WHERE re.org_id = p_org_id AND re.contact_id = p_contact_id;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. get_crm_economics_summary — org-level portfolio economics overview
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_economics_summary(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(

    'tier_distribution', (
      SELECT jsonb_object_agg(economics_tier, cnt) FROM (
        SELECT economics_tier, COUNT(*) AS cnt FROM crm_relationship_economics
        WHERE org_id = p_org_id GROUP BY economics_tier
      ) t
    ),
    'avg_efficiency_score', (
      SELECT ROUND(AVG(economic_efficiency_score)) FROM crm_relationship_economics
      WHERE org_id = p_org_id
    ),
    'draining_count', (
      SELECT COUNT(*) FROM crm_relationship_economics
      WHERE org_id = p_org_id AND economics_tier = 'draining'
    ),
    'high_leverage_count', (
      SELECT COUNT(*) FROM crm_relationship_economics
      WHERE org_id = p_org_id AND economics_tier = 'high_leverage'
    ),

    -- Top draining relationships
    'most_costly', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_id', c.id, 'name', c.name, 'company', c.company,
        'economics_tier', re.economics_tier,
        'total_cost', re.total_cost,
        'total_leverage', re.total_leverage,
        'economic_efficiency_score', re.economic_efficiency_score,
        'cost_narrative', re.cost_narrative
      ) ORDER BY re.total_cost DESC)
      FROM crm_relationship_economics re
      JOIN crm_contacts c ON c.id = re.contact_id
      WHERE re.org_id = p_org_id AND re.economics_tier IN ('draining','costly')
      LIMIT 8
    ), '[]'::jsonb),

    -- Top leveraged relationships
    'highest_leverage', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_id', c.id, 'name', c.name, 'company', c.company,
        'economics_tier', re.economics_tier,
        'strategic_leverage', re.strategic_leverage,
        'political_leverage', re.political_leverage,
        'network_leverage', re.network_leverage,
        'economic_efficiency_score', re.economic_efficiency_score
      ) ORDER BY re.total_leverage DESC)
      FROM crm_relationship_economics re
      JOIN crm_contacts c ON c.id = re.contact_id
      WHERE re.org_id = p_org_id AND re.economics_tier IN ('high_leverage','efficient')
      LIMIT 8
    ), '[]'::jsonb),

    'cost_breakdown_avg', (
      SELECT jsonb_build_object(
        'attention', ROUND(AVG(attention_cost)),
        'coordination', ROUND(AVG(coordination_cost)),
        'escalation', ROUND(AVG(escalation_cost)),
        'maintenance', ROUND(AVG(maintenance_cost))
      ) FROM crm_relationship_economics WHERE org_id = p_org_id
    )

  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. compute_crm_sprint17_nightly + pg_cron
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_crm_sprint17_nightly(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM compute_crm_relationship_economics(p_org_id);
END;
$$;

SELECT cron.schedule(
  'compute_crm_sprint17_nightly',
  '0 8 * * *',
  $$SELECT compute_crm_sprint17_nightly(id) FROM organizations WHERE cancellation_status IS NULL$$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Initial compute
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE cancellation_status IS NULL LOOP
    BEGIN PERFORM compute_crm_relationship_economics(r.id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END;
$$;
