-- LGE Phase 18: Enterprise Compliance & Commercialization
-- Tables: lge_retention_policies, lge_usage_metrics, lge_plan_quotas, lge_audit_exports
-- Helpers: lge_enforce_retention(), lge_increment_usage(), lge_check_quota()
-- Cron: retention enforcement daily 03:30 UTC

CREATE TABLE IF NOT EXISTS public.lge_retention_policies (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  raw_leads_days       INT         NOT NULL DEFAULT 90,
  enrichment_days      INT         NOT NULL DEFAULT 90,
  scores_days          INT         NOT NULL DEFAULT 180,
  decisions_days       INT         NOT NULL DEFAULT 180,
  outcomes_days        INT         NOT NULL DEFAULT 365,
  sla_metrics_days     INT         NOT NULL DEFAULT 30,
  provider_calls_days  INT         NOT NULL DEFAULT 60,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily per-org usage tracking for billing and quota enforcement
CREATE TABLE IF NOT EXISTS public.lge_usage_metrics (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL,
  window_date         DATE        NOT NULL DEFAULT CURRENT_DATE,
  leads_ingested      INT         NOT NULL DEFAULT 0,
  leads_processed     INT         NOT NULL DEFAULT 0,
  leads_pushed        INT         NOT NULL DEFAULT 0,
  enrichment_calls    INT         NOT NULL DEFAULT 0,
  gpt_context_calls   INT         NOT NULL DEFAULT 0,
  replay_runs         INT         NOT NULL DEFAULT 0,
  export_runs         INT         NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, window_date)
);

CREATE INDEX IF NOT EXISTS idx_lge_usage_metrics_org ON public.lge_usage_metrics(org_id, window_date DESC);

-- Per-org quota limits
CREATE TABLE IF NOT EXISTS public.lge_plan_quotas (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_tier                TEXT        NOT NULL DEFAULT 'standard'
    CHECK (plan_tier IN ('starter','standard','growth','enterprise')),
  max_leads_per_day        INT         NOT NULL DEFAULT 500,
  max_enrichments_per_day  INT         NOT NULL DEFAULT 1000,
  max_pushes_per_day       INT         NOT NULL DEFAULT 200,
  max_campaigns            INT         NOT NULL DEFAULT 10,
  max_replays_per_day      INT         NOT NULL DEFAULT 5,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit export records
CREATE TABLE IF NOT EXISTS public.lge_audit_exports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL,
  exported_by  UUID,
  export_type  TEXT        NOT NULL
    CHECK (export_type IN ('decisions','alerts','outcomes','policies','full_audit','operator_actions')),
  format       TEXT        NOT NULL DEFAULT 'json'
    CHECK (format IN ('csv','json')),
  date_from    TIMESTAMPTZ,
  date_to      TIMESTAMPTZ,
  row_count    INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_audit_exports_org ON public.lge_audit_exports(org_id, created_at DESC);

-- Retention enforcement: purge old data per org's policy (run via pg_cron)
CREATE OR REPLACE FUNCTION public.lge_enforce_retention() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM public.lge_retention_policies LOOP
    -- SLA metrics
    DELETE FROM public.lge_sla_metrics
    WHERE org_id = r.org_id
      AND created_at < now() - make_interval(days => r.sla_metrics_days);
    -- Provider call logs (via raw_lead join)
    DELETE FROM public.lge_provider_calls
    WHERE raw_lead_id IN (
      SELECT id FROM public.lge_raw_leads
      WHERE org_id = r.org_id
        AND created_at < now() - make_interval(days => r.provider_calls_days)
    );
  END LOOP;
END;
$$;

-- Usage increment helper (idempotent upsert + field increment)
CREATE OR REPLACE FUNCTION public.lge_increment_usage(
  p_org_id UUID, p_field TEXT, p_amount INT DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.lge_usage_metrics (org_id, window_date)
  VALUES (p_org_id, CURRENT_DATE)
  ON CONFLICT (org_id, window_date) DO NOTHING;

  EXECUTE format(
    'UPDATE public.lge_usage_metrics SET %I = %I + $1, updated_at = now() WHERE org_id = $2 AND window_date = CURRENT_DATE',
    p_field, p_field
  ) USING p_amount, p_org_id;
END;
$$;

-- Quota check: returns true if the org has exceeded their daily quota for the given field
CREATE OR REPLACE FUNCTION public.lge_check_quota(
  p_org_id UUID, p_field TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_used  INT := 0;
  v_limit INT := 999999;
  v_limit_col TEXT;
BEGIN
  v_limit_col := CASE p_field
    WHEN 'leads_ingested'   THEN 'max_leads_per_day'
    WHEN 'enrichment_calls' THEN 'max_enrichments_per_day'
    WHEN 'leads_pushed'     THEN 'max_pushes_per_day'
    WHEN 'replay_runs'      THEN 'max_replays_per_day'
    ELSE NULL
  END;
  IF v_limit_col IS NULL THEN RETURN false; END IF;

  SELECT COALESCE(
    (SELECT (to_jsonb(u) ->> p_field)::INT FROM public.lge_usage_metrics u
     WHERE org_id = p_org_id AND window_date = CURRENT_DATE),
    0
  ) INTO v_used;

  SELECT COALESCE(
    (SELECT (to_jsonb(q) ->> v_limit_col)::INT FROM public.lge_plan_quotas q
     WHERE org_id = p_org_id),
    999999
  ) INTO v_limit;

  RETURN v_used >= v_limit;
END;
$$;

-- RLS
ALTER TABLE public.lge_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_usage_metrics      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_plan_quotas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_audit_exports      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.lge_retention_policies FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_usage_metrics      FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_plan_quotas        FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_audit_exports      FOR ALL TO service_role USING (true);

-- pg_cron #33: retention enforcement daily at 03:30 UTC
SELECT cron.schedule('lge-enforce-retention', '30 3 * * *', $$SELECT public.lge_enforce_retention()$$);
