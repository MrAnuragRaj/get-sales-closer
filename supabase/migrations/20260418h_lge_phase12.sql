-- LGE Phase 12: Notifications, Alerts, and Digest Intelligence

-- ── 1. lge_alerts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_alerts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id      uuid        REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  alert_type       text        NOT NULL,
  severity         text        NOT NULL DEFAULT 'info'  CHECK (severity IN ('info','warning','critical')),
  status           text        NOT NULL DEFAULT 'open'  CHECK (status IN ('open','acknowledged','resolved','suppressed')),
  title            text        NOT NULL,
  message          text        NOT NULL,
  context_json     jsonb       NOT NULL DEFAULT '{}',
  dedupe_key       text        NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_emailed_at  timestamptz,
  acknowledged_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at  timestamptz,
  resolved_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  resolution_note  text,
  suppressed_until timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Unique open alert per org + dedupe_key (resolved/suppressed alerts don't block new ones)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lge_alerts_dedupe
  ON public.lge_alerts(org_id, dedupe_key)
  WHERE status NOT IN ('resolved','suppressed');

CREATE INDEX IF NOT EXISTS idx_lge_alerts_org_status
  ON public.lge_alerts(org_id, status);
CREATE INDEX IF NOT EXISTS idx_lge_alerts_campaign
  ON public.lge_alerts(campaign_id)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lge_alerts_severity
  ON public.lge_alerts(org_id, severity, status);

-- ── 2. lge_notification_prefs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_notification_prefs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  channel_in_app   boolean     NOT NULL DEFAULT true,
  channel_email    boolean     NOT NULL DEFAULT true,
  digest_frequency text        NOT NULL DEFAULT 'daily' CHECK (digest_frequency IN ('daily','weekly','off')),
  min_severity     text        NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','critical')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 3. lge_digests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_digests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  digest_type      text        NOT NULL DEFAULT 'daily' CHECK (digest_type IN ('daily','weekly')),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  content_json     jsonb       NOT NULL DEFAULT '{}',
  sent_at          timestamptz,
  delivery_status  text        NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sent','failed')),
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lge_digests_org_date
  ON public.lge_digests(org_id, created_at DESC);
