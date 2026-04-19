-- LGE Phase 16: Validation, Replay & Simulation Engine
-- Tables: lge_replays, lge_replay_results, lge_simulation_profiles,
--         lge_shadow_evaluations, lge_operator_stats

CREATE TABLE IF NOT EXISTS public.lge_replays (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL,
  campaign_id          UUID        REFERENCES public.lge_campaigns(id) ON DELETE SET NULL,
  name                 TEXT        NOT NULL,
  policy_snapshot_json JSONB       NOT NULL DEFAULT '{}',
  -- { auto_push_threshold, review_threshold, source_adj_overrides }
  scope_filter_json    JSONB       NOT NULL DEFAULT '{}',
  -- { date_from, date_to, statuses: [...] }  empty = all processed leads
  status               TEXT        NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending','running','completed','failed')),
  total_leads          INT,
  changed_count        INT,
  push_delta           INT,        -- +N = more pushes, -N = fewer pushes
  error_message        TEXT,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lge_replays_org      ON public.lge_replays(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_replays_campaign ON public.lge_replays(campaign_id);

-- Per-lead comparison results (read-only mirror — never mutates source tables)
CREATE TABLE IF NOT EXISTS public.lge_replay_results (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id            UUID        NOT NULL REFERENCES public.lge_replays(id) ON DELETE CASCADE,
  lead_id              UUID        NOT NULL,
  original_total_score NUMERIC(5,2),
  new_total_score      NUMERIC(5,2),
  score_delta          NUMERIC(5,2),
  original_decision    TEXT,
  new_decision         TEXT,
  decision_changed     BOOLEAN     NOT NULL DEFAULT false,
  push_changed         BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_replay_results_replay   ON public.lge_replay_results(replay_id);
CREATE INDEX IF NOT EXISTS idx_lge_replay_results_changed  ON public.lge_replay_results(replay_id) WHERE decision_changed = true;

-- Simulation profiles: probabilistic outcome expectations per vertical + score band
CREATE TABLE IF NOT EXISTS public.lge_simulation_profiles (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        UUID,       -- NULL = platform global profile
  name                          TEXT        NOT NULL,
  vertical                      TEXT,
  score_band_probabilities_json JSONB       NOT NULL DEFAULT '{}',
  -- {"90-100":{"reply":0.38,"booked":0.18,"closed":0.07}, ...}
  is_global                     BOOLEAN     NOT NULL DEFAULT false,
  created_by                    UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shadow policy evaluations: parallel what-if per lead (no routing side-effects)
CREATE TABLE IF NOT EXISTS public.lge_shadow_evaluations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID        NOT NULL,
  org_id              UUID        NOT NULL,
  campaign_id         UUID,
  shadow_policy_json  JSONB       NOT NULL DEFAULT '{}',
  real_total_score    NUMERIC(5,2),
  shadow_total_score  NUMERIC(5,2),
  real_decision       TEXT,
  shadow_decision     TEXT,
  evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_shadow_evals_org  ON public.lge_shadow_evaluations(org_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_shadow_evals_lead ON public.lge_shadow_evaluations(lead_id);

-- Operator stats: track manual override frequency and outcome quality
CREATE TABLE IF NOT EXISTS public.lge_operator_stats (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL,
  campaign_id         UUID,
  user_id             UUID,
  action              TEXT        NOT NULL
    CHECK (action IN ('force_push','discard','score_override','manual_outcome')),
  lead_id             UUID,
  original_decision   TEXT,
  override_decision   TEXT,
  score_band          TEXT,       -- "60-69" | "70-79" | "80-89" | "90-100"
  outcome_within_14d  TEXT,       -- back-filled by lge_outcome_sync
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_operator_stats_org      ON public.lge_operator_stats(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_operator_stats_campaign ON public.lge_operator_stats(campaign_id);
CREATE INDEX IF NOT EXISTS idx_lge_operator_stats_user     ON public.lge_operator_stats(user_id);

-- RLS: service_role has full access; users access via edge function only
ALTER TABLE public.lge_replays              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_replay_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_simulation_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_shadow_evaluations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_operator_stats       ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.lge_replays             FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_replay_results      FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_simulation_profiles FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_shadow_evaluations  FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_operator_stats      FOR ALL TO service_role USING (true);

-- Seed global simulation profiles
INSERT INTO public.lge_simulation_profiles (name, vertical, is_global, score_band_probabilities_json) VALUES
('General B2B',       'general',     true, '{"90-100":{"reply":0.38,"booked":0.18,"closed":0.07},"80-89":{"reply":0.28,"booked":0.12,"closed":0.04},"70-79":{"reply":0.18,"booked":0.07,"closed":0.02},"60-69":{"reply":0.10,"booked":0.03,"closed":0.01}}'),
('Legal Services',    'legal',       true, '{"90-100":{"reply":0.42,"booked":0.22,"closed":0.09},"80-89":{"reply":0.30,"booked":0.14,"closed":0.05},"70-79":{"reply":0.20,"booked":0.08,"closed":0.02},"60-69":{"reply":0.12,"booked":0.04,"closed":0.01}}'),
('Real Estate',       'real_estate', true, '{"90-100":{"reply":0.35,"booked":0.16,"closed":0.08},"80-89":{"reply":0.25,"booked":0.10,"closed":0.05},"70-79":{"reply":0.16,"booked":0.06,"closed":0.02},"60-69":{"reply":0.09,"booked":0.03,"closed":0.01}}'),
('Medical / Health',  'medical',     true, '{"90-100":{"reply":0.40,"booked":0.20,"closed":0.08},"80-89":{"reply":0.28,"booked":0.13,"closed":0.05},"70-79":{"reply":0.17,"booked":0.07,"closed":0.02},"60-69":{"reply":0.10,"booked":0.03,"closed":0.01}}')
ON CONFLICT DO NOTHING;
