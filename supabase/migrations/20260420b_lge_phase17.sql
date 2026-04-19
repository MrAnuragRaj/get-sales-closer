-- LGE Phase 17: Scale, Throughput & Reliability Hardening
-- Tables: lge_queue_tasks, lge_worker_health, lge_dead_letter, lge_sla_metrics, lge_rate_limits
-- Helpers: lge_increment_rate_limit()
-- Cron: lge_dlq_worker every 30 min

CREATE TABLE IF NOT EXISTS public.lge_queue_tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL,
  campaign_id   UUID,
  type          TEXT        NOT NULL
    CHECK (type IN ('enrich','re_enrich','replay','simulate','dlq_retry')),
  priority      INT         NOT NULL DEFAULT 5,  -- 1 = highest, 10 = lowest
  payload       JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','completed','failed','cancelled')),
  attempts      INT         NOT NULL DEFAULT 0,
  max_attempts  INT         NOT NULL DEFAULT 3,
  leased_by     TEXT,
  leased_until  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_queue_priority ON public.lge_queue_tasks(priority ASC, created_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_lge_queue_org      ON public.lge_queue_tasks(org_id, status);
CREATE INDEX IF NOT EXISTS idx_lge_queue_leased   ON public.lge_queue_tasks(leased_until) WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS public.lge_worker_health (
  worker_id         TEXT        PRIMARY KEY,
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tasks_processed   INT         NOT NULL DEFAULT 0,
  tasks_failed      INT         NOT NULL DEFAULT 0,
  avg_processing_ms INT,
  batch_size        INT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LGE-specific Dead Letter Queue
CREATE TABLE IF NOT EXISTS public.lge_dead_letter (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID,
  org_id        UUID        NOT NULL,
  campaign_id   UUID,
  reason        TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}',
  retry_count   INT         NOT NULL DEFAULT 0,
  max_retries   INT         NOT NULL DEFAULT 3,
  status        TEXT        NOT NULL DEFAULT 'dead'
    CHECK (status IN ('dead','retrying','recovered','abandoned')),
  last_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_dead_letter_status ON public.lge_dead_letter(status, created_at) WHERE status IN ('dead','retrying');
CREATE INDEX IF NOT EXISTS idx_lge_dead_letter_org    ON public.lge_dead_letter(org_id, created_at DESC);

-- SLA metrics: pipeline latency tracking per lead
CREATE TABLE IF NOT EXISTS public.lge_sla_metrics (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL,
  campaign_id          UUID,
  lead_id              UUID,
  ingest_at            TIMESTAMPTZ,
  enrichment_start_at  TIMESTAMPTZ,
  enrichment_end_at    TIMESTAMPTZ,
  routing_end_at       TIMESTAMPTZ,
  enrichment_ms        INT,        -- enrichment_end_at - enrichment_start_at in ms
  total_pipeline_ms    INT,        -- routing_end_at - ingest_at in ms
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_sla_org ON public.lge_sla_metrics(org_id, created_at DESC);

-- Rate limits: daily provider API quota guards per org
CREATE TABLE IF NOT EXISTS public.lge_rate_limits (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL,
  provider        TEXT        NOT NULL
    CHECK (provider IN ('apollo','hunter','abstract_phone','openai','total_enrichments')),
  window_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  calls_made      INT         NOT NULL DEFAULT 0,
  calls_limit     INT         NOT NULL DEFAULT 10000,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, window_date)
);

CREATE INDEX IF NOT EXISTS idx_lge_rate_limits_org ON public.lge_rate_limits(org_id, window_date);

-- Atomic rate-limit increment; returns new count
CREATE OR REPLACE FUNCTION public.lge_increment_rate_limit(
  p_org_id UUID, p_provider TEXT, p_amount INT DEFAULT 1
) RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_calls INT;
BEGIN
  INSERT INTO public.lge_rate_limits (org_id, provider, window_date, calls_made)
  VALUES (p_org_id, p_provider, CURRENT_DATE, p_amount)
  ON CONFLICT (org_id, provider, window_date)
  DO UPDATE SET calls_made = lge_rate_limits.calls_made + p_amount, last_updated_at = now()
  RETURNING calls_made INTO v_calls;
  RETURN v_calls;
END;
$$;

-- RLS
ALTER TABLE public.lge_queue_tasks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_worker_health  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_dead_letter    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_sla_metrics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lge_rate_limits    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.lge_queue_tasks   FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_worker_health FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_dead_letter   FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_sla_metrics   FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON public.lge_rate_limits   FOR ALL TO service_role USING (true);

-- pg_cron #32: DLQ retry worker every 30 min
SELECT cron.schedule(
  'lge-dlq-worker',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_dlq_worker',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key', true) || '"}'::jsonb,
    body    := '{}'::jsonb
  )
  $$
);
