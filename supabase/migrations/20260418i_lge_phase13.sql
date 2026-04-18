-- LGE Phase 13: Adaptive Intelligence, Source Reliability, Experimentation, Vertical Packs

-- ── 13A: Enhance lge_source_stats with outcome-based reliability ──────────────
ALTER TABLE public.lge_source_stats
  ADD COLUMN IF NOT EXISTS booked_rate        numeric(5,2),
  ADD COLUMN IF NOT EXISTS false_push_rate    numeric(5,2),
  ADD COLUMN IF NOT EXISTS reliability_score  numeric(5,2),   -- 0–100
  ADD COLUMN IF NOT EXISTS reliability_v      integer NOT NULL DEFAULT 1,  -- formula version
  ADD COLUMN IF NOT EXISTS sample_size        integer,
  ADD COLUMN IF NOT EXISTS computed_at        timestamptz;

-- ── 13B: Policy Recommendations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_policy_recommendations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id             uuid        REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  recommendation_type     text        NOT NULL,
  title                   text        NOT NULL,
  current_policy_json     jsonb       NOT NULL DEFAULT '{}',
  recommended_policy_json jsonb       NOT NULL DEFAULT '{}',
  justification_json      jsonb       NOT NULL DEFAULT '{}',
  confidence_level        text        NOT NULL DEFAULT 'medium' CHECK (confidence_level IN ('low','medium','high')),
  severity                text        NOT NULL DEFAULT 'info'   CHECK (severity IN ('info','warning','high')),
  status                  text        NOT NULL DEFAULT 'open'   CHECK (status IN ('open','accepted','rejected','expired')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  acted_at                timestamptz,
  acted_by                uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at              timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_lge_recs_org_status   ON public.lge_policy_recommendations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_lge_recs_campaign     ON public.lge_policy_recommendations(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lge_recs_expires       ON public.lge_policy_recommendations(expires_at) WHERE status = 'open';

-- ── 13C: Experimentation Framework ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_experiments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id         uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  name                text        NOT NULL,
  experiment_type     text        NOT NULL DEFAULT 'threshold' CHECK (experiment_type IN ('threshold','scoring','prompt')),
  variant_a_json      jsonb       NOT NULL DEFAULT '{}',   -- current/control
  variant_b_json      jsonb       NOT NULL DEFAULT '{}',   -- proposed/treatment
  assignment_method   text        NOT NULL DEFAULT 'shadow' CHECK (assignment_method IN ('shadow','alternating')),
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','concluded')),
  hypothesis          text,
  result_json         jsonb,
  winner              text        CHECK (winner IN ('a','b','inconclusive')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  stopped_at          timestamptz,
  created_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_experiments_org      ON public.lge_experiments(org_id, status);
CREATE INDEX IF NOT EXISTS idx_lge_experiments_campaign ON public.lge_experiments(campaign_id);

-- ── 13D: Vertical Intelligence Packs (versioned, audit-trailed) ──────────────
CREATE TABLE IF NOT EXISTS public.lge_vertical_packs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  description text,
  version     integer     NOT NULL DEFAULT 1,
  config_json jsonb       NOT NULL DEFAULT '{}',   -- icp_config + thresholds + review_ttl_days
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Pack application audit trail
CREATE TABLE IF NOT EXISTS public.lge_pack_applications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  pack_id     uuid        NOT NULL REFERENCES public.lge_vertical_packs(id) ON DELETE RESTRICT,
  applied_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  snapshot_before_json jsonb NOT NULL DEFAULT '{}',
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_pack_apps_campaign ON public.lge_pack_applications(campaign_id);
