-- LGE Phase 19: Platformization & Ecosystem Expansion
-- Tables: lge_api_keys, lge_org_branding, lge_plugins, lge_benchmarks, lge_api_requests
-- Helper: lge_compute_benchmarks()
-- Cron: benchmark computation weekly Sunday 05:00 UTC

-- Public API keys for external integrations (separate from internal api_keys table)
CREATE TABLE IF NOT EXISTS public.lge_api_keys (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_hash           TEXT        NOT NULL UNIQUE,   -- SHA-256 hex of the raw key
  key_prefix         TEXT        NOT NULL,           -- first 12 chars for display
  name               TEXT        NOT NULL,
  scopes             TEXT[]      NOT NULL DEFAULT '{"ingest","score","read"}',
  rate_limit_per_min INT         NOT NULL DEFAULT 60,
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  last_used_at       TIMESTAMPTZ,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lge_api_keys_hash ON public.lge_api_keys(key_hash) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_lge_api_keys_org  ON public.lge_api_keys(org_id);

-- White-label branding configuration per org
CREATE TABLE IF NOT EXISTS public.lge_org_branding (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  brand_name          TEXT,
  logo_url            TEXT,
  primary_color       TEXT        DEFAULT '#4F46E5',
  accent_color        TEXT        DEFAULT '#818CF8',
  custom_domain       TEXT,
  email_from_name     TEXT,
  email_from_address  TEXT,
  is_white_label      BOOLEAN     NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plugin registry: custom enrichment / scoring / routing providers
CREATE TABLE IF NOT EXISTS public.lge_plugins (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        REFERENCES public.organizations(id) ON DELETE CASCADE, -- NULL = platform plugin
  name         TEXT        NOT NULL,
  plugin_type  TEXT        NOT NULL
    CHECK (plugin_type IN ('enrichment','scoring','routing','notification')),
  endpoint_url TEXT,
  config_json  JSONB       NOT NULL DEFAULT '{}',
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  is_sandboxed BOOLEAN     NOT NULL DEFAULT true,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_plugins_org ON public.lge_plugins(org_id, plugin_type) WHERE is_active = true;

-- Cross-org anonymized benchmark data (aggregated, no PII)
CREATE TABLE IF NOT EXISTS public.lge_benchmarks (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical             TEXT        NOT NULL DEFAULT 'general',
  score_band           TEXT        NOT NULL,   -- "60-69" | "70-79" | "80-89" | "90-100"
  sample_count         INT         NOT NULL,
  avg_reply_rate       NUMERIC(5,2),
  avg_booked_rate      NUMERIC(5,2),
  avg_false_push_rate  NUMERIC(5,2),
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_benchmarks_vertical ON public.lge_benchmarks(vertical, computed_at DESC);

-- Public API request log (rate limiting + audit)
CREATE TABLE IF NOT EXISTS public.lge_api_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  UUID        REFERENCES public.lge_api_keys(id) ON DELETE SET NULL,
  org_id      UUID        NOT NULL,
  endpoint    TEXT        NOT NULL,
  method      TEXT        NOT NULL,
  status_code INT,
  response_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_api_requests_key ON public.lge_api_requests(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_api_requests_org ON public.lge_api_requests(org_id, created_at DESC);

-- RLS
ALTER TABLE public.lge_api_keys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_org_branding  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_plugins       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_benchmarks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_api_requests  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.lge_api_keys     FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_org_branding FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_plugins      FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_benchmarks   FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_api_requests FOR ALL TO service_role USING (true);

-- Cross-org benchmark computation (anonymized — no org_id in output)
CREATE OR REPLACE FUNCTION public.lge_compute_benchmarks() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.lge_benchmarks (vertical, score_band, sample_count, avg_reply_rate, avg_booked_rate, avg_false_push_rate)
  SELECT
    COALESCE(c.icp_config->>'vertical', 'general') AS vertical,
    CASE
      WHEN s.total_score >= 90 THEN '90-100'
      WHEN s.total_score >= 80 THEN '80-89'
      WHEN s.total_score >= 70 THEN '70-79'
      ELSE '60-69'
    END AS score_band,
    COUNT(*)                                                                                              AS sample_count,
    ROUND(AVG(CASE WHEN o.outcome_stage IN ('replied','booked','closed') THEN 1.0 ELSE 0.0 END) * 100, 2) AS avg_reply_rate,
    ROUND(AVG(CASE WHEN o.outcome_stage IN ('booked','closed')           THEN 1.0 ELSE 0.0 END) * 100, 2) AS avg_booked_rate,
    ROUND(AVG(CASE WHEN o.outcome_stage = 'no_reply'                     THEN 1.0 ELSE 0.0 END) * 100, 2) AS avg_false_push_rate
  FROM public.lge_scores s
  JOIN public.lge_raw_leads  rl ON rl.id  = s.raw_lead_id
  JOIN public.lge_campaigns   c  ON c.id   = rl.campaign_id
  LEFT JOIN public.lge_outcomes o ON o.raw_lead_id = rl.id
  WHERE rl.status  = 'pushed'
    AND s.scored_at > now() - INTERVAL '90 days'
    AND rl.updated_at < now() - INTERVAL '48 hours'  -- outcome lag
  GROUP BY 1, 2
  HAVING COUNT(*) >= 20;
END;
$$;

-- pg_cron #34: benchmark computation weekly Sunday at 05:00 UTC
SELECT cron.schedule('lge-compute-benchmarks', '0 5 * * 0', $$SELECT public.lge_compute_benchmarks()$$);
