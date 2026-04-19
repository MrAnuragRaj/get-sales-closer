-- LGE Phase 14 + 15: Activated Intelligence & Self-Improving System
-- Phase 12 validation: pg_cron job for lge_alert_worker (was missing)
-- Phase 14: Source reliability activation, recommendation feedback, statistical experiments,
--           auto-assist mode, policy simulation
-- Phase 15: Cross-campaign global patterns, adaptive scoring, enterprise policy engine,
--           cost intelligence, recommendation ranking

-- ── Phase 12 completion: schedule alert worker ─────────────────────────────────
SELECT cron.schedule(
  'lge-alert-worker',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_alert_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- ── Phase 14A: lge_campaigns — auto-assist mode ────────────────────────────────
ALTER TABLE public.lge_campaigns
  ADD COLUMN IF NOT EXISTS auto_assist_mode text NOT NULL DEFAULT 'off'
    CHECK (auto_assist_mode IN ('off','suggest_only','assist')),
  ADD COLUMN IF NOT EXISTS auto_assist_log  jsonb NOT NULL DEFAULT '[]';

-- ── Phase 14B: lge_policy_recommendations — feedback columns ──────────────────
ALTER TABLE public.lge_policy_recommendations
  ADD COLUMN IF NOT EXISTS applied_policy_snapshot_json   jsonb,
  ADD COLUMN IF NOT EXISTS post_apply_metrics_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS effectiveness_score            numeric(5,2),
  ADD COLUMN IF NOT EXISTS evaluated_at                  timestamptz;

-- ── Phase 14C: lge_recommendation_feedback ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_recommendation_feedback (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id       uuid        NOT NULL REFERENCES public.lge_policy_recommendations(id) ON DELETE CASCADE,
  org_id                  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  evaluation_window_days  integer     NOT NULL DEFAULT 14,
  before_metrics_json     jsonb       NOT NULL DEFAULT '{}',
  after_metrics_json      jsonb       NOT NULL DEFAULT '{}',
  effectiveness_score     numeric(5,2),  -- 0-100: how much the recommendation helped
  evaluated_at            timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_rec_feedback_rec
  ON public.lge_recommendation_feedback(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_lge_rec_feedback_org
  ON public.lge_recommendation_feedback(org_id);

-- ── Phase 14D: lge_policy_simulations ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_policy_simulations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id          uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  input_policy_json    jsonb       NOT NULL DEFAULT '{}',
  simulated_output_json jsonb      NOT NULL DEFAULT '{}',
  created_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_policy_sims_campaign
  ON public.lge_policy_simulations(campaign_id, created_at DESC);

-- ── Phase 14E: lge_auto_assist_actions ────────────────────────────────────────
-- Immutable log of every action taken by the auto-assist system
CREATE TABLE IF NOT EXISTS public.lge_auto_assist_actions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  org_id        uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  action_type   text        NOT NULL,  -- 'threshold_adjust' | 'source_downweight' | 'suggest_reprocess'
  before_json   jsonb       NOT NULL DEFAULT '{}',
  after_json    jsonb       NOT NULL DEFAULT '{}',
  reason        text        NOT NULL,
  is_reversible boolean     NOT NULL DEFAULT true,
  reversed_at   timestamptz,
  reversed_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_auto_assist_campaign
  ON public.lge_auto_assist_actions(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_auto_assist_org
  ON public.lge_auto_assist_actions(org_id, created_at DESC);

-- ── Phase 15A: lge_global_patterns ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_global_patterns (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pattern_type    text        NOT NULL,  -- 'icp_segment' | 'score_band' | 'source_effectiveness'
  pattern_key     text        NOT NULL,  -- e.g. "law_firm_50_200" or "score_70_85"
  metrics_json    jsonb       NOT NULL DEFAULT '{}',
  sample_size     integer     NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_global_patterns_key
  ON public.lge_global_patterns(org_id, pattern_type, pattern_key);
CREATE INDEX IF NOT EXISTS idx_lge_global_patterns_org
  ON public.lge_global_patterns(org_id, computed_at DESC);

-- ── Phase 15B: lge_org_policies ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_org_policies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  max_daily_push        integer     NOT NULL DEFAULT 100,
  allowed_sources       text[],           -- NULL = all allowed
  blocked_sources       text[],           -- NULL = none blocked
  compliance_filters    jsonb       NOT NULL DEFAULT '{}',  -- {require_verified_email, require_verified_phone}
  risk_threshold        numeric(5,2) NOT NULL DEFAULT 0,    -- min reliability_score required for push
  pii_handling_rules    jsonb       NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── Phase 15C: lge_cost_metrics ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_cost_metrics (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id               uuid        REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  period_date               date        NOT NULL DEFAULT CURRENT_DATE,
  leads_ingested            integer     NOT NULL DEFAULT 0,
  leads_enriched            integer     NOT NULL DEFAULT 0,
  leads_pushed              integer     NOT NULL DEFAULT 0,
  leads_booked              integer     NOT NULL DEFAULT 0,
  provider_calls_total      integer     NOT NULL DEFAULT 0,
  cost_per_enriched_lead    numeric(10,4),
  cost_per_pushed_lead      numeric(10,4),
  cost_per_booked_lead      numeric(10,4),
  estimated_provider_cost   numeric(10,4),
  metrics_json              jsonb       NOT NULL DEFAULT '{}',
  computed_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_cost_metrics_period
  ON public.lge_cost_metrics(org_id, COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid), period_date);
CREATE INDEX IF NOT EXISTS idx_lge_cost_metrics_org
  ON public.lge_cost_metrics(org_id, period_date DESC);

-- ── Phase 15D: Recommendation quality score on recommendations ─────────────────
ALTER TABLE public.lge_policy_recommendations
  ADD COLUMN IF NOT EXISTS recommendation_quality_score numeric(5,2);

-- ── Phase 14 workers: pg_cron schedules ───────────────────────────────────────

-- Reliability scorer — runs every 6h to update lge_source_stats.reliability_score
SELECT cron.schedule(
  'lge-reliability-worker',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_reliability_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- Recommendation feedback evaluator — runs daily at 03:30 UTC
SELECT cron.schedule(
  'lge-recommendation-feedback-worker',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_recommendation_feedback_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- Auto-assist worker — runs every 30 minutes for campaigns in ASSIST mode
SELECT cron.schedule(
  'lge-auto-assist-worker',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_auto_assist_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- ── Phase 15 workers: pg_cron schedules ───────────────────────────────────────

-- Global pattern aggregator — runs daily at 04:00 UTC
SELECT cron.schedule(
  'lge-global-pattern-worker',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_global_pattern_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);

-- Cost aggregator — runs daily at 04:30 UTC
SELECT cron.schedule(
  'lge-cost-worker',
  '30 4 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_cost_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
