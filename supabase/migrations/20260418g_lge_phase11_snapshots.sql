-- LGE Phase 11.5: Calibration Snapshots

CREATE TABLE IF NOT EXISTS public.lge_calibration_snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id     uuid        REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  snapshot_date   date        NOT NULL DEFAULT CURRENT_DATE,
  time_window     text        NOT NULL DEFAULT 'all', -- '7d' | '30d' | 'all'
  metrics_json    jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One snapshot per org/campaign/date/time_window
CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_calibration_snapshots
  ON public.lge_calibration_snapshots(org_id, COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date, time_window);

-- Fast lookup by org + date for trend queries
CREATE INDEX IF NOT EXISTS idx_lge_calibration_snapshots_org_date
  ON public.lge_calibration_snapshots(org_id, snapshot_date DESC);
