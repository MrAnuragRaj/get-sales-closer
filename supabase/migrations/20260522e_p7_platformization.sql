-- P7: Platformization & Ecosystem Infrastructure
-- Webhook subscriptions, external event ingestion, delivery queue.
-- Public API proxy and embedded briefings SDK deferred to separate edge functions.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. crm_webhook_subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_webhook_subscriptions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  event_types      JSONB       NOT NULL DEFAULT '[]',   -- array of event type strings
  endpoint_url     TEXT        NOT NULL,
  signing_secret   TEXT        NOT NULL,                -- HMAC-SHA256 signing secret
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  delivery_timeout_ms INT      NOT NULL DEFAULT 5000 CHECK (delivery_timeout_ms BETWEEN 1000 AND 30000),
  failure_count    INT         NOT NULL DEFAULT 0,
  last_delivered_at TIMESTAMPTZ,
  last_error       TEXT,
  created_by       UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_ws_org ON public.crm_webhook_subscriptions
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));
CREATE POLICY crm_ws_insert ON public.crm_webhook_subscriptions FOR INSERT
  WITH CHECK (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_ws_org_active
  ON public.crm_webhook_subscriptions (org_id) WHERE is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. crm_webhook_deliveries — delivery queue + history
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_webhook_deliveries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID        NOT NULL REFERENCES public.crm_webhook_subscriptions(id) ON DELETE CASCADE,
  org_id           UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL,
  event_payload    JSONB       NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','delivered','failed','retrying','skipped')),
  attempt_count    INT         NOT NULL DEFAULT 0,
  max_attempts     INT         NOT NULL DEFAULT 3,
  response_code    INT,
  response_body    TEXT,
  last_error       TEXT,
  next_retry_at    TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_wd_org ON public.crm_webhook_deliveries
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_wd_pending
  ON public.crm_webhook_deliveries (status, next_retry_at)
  WHERE status IN ('pending','retrying');
CREATE INDEX IF NOT EXISTS idx_crm_wd_org
  ON public.crm_webhook_deliveries (org_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. crm_external_events — inbound signals from external systems
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_external_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source         TEXT        NOT NULL CHECK (source IN (
                               'salesforce','hubspot','support_ticket','billing_system',
                               'slack','cs_tool','analytics','custom'
                             )),
  event_type     TEXT        NOT NULL,
  entity_type    TEXT        CHECK (entity_type IN ('contact','account','lead','opportunity','ticket')),
  entity_email   TEXT,        -- used for cross-system contact linking
  entity_external_id TEXT,    -- external system's ID for this entity
  payload        JSONB       NOT NULL DEFAULT '{}',
  crm_contact_id UUID        REFERENCES public.crm_contacts(id) ON DELETE SET NULL,  -- resolved after processing
  processed      BOOLEAN     NOT NULL DEFAULT FALSE,
  processed_at   TIMESTAMPTZ,
  processing_note TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.crm_external_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY crm_ee_org ON public.crm_external_events
  USING (org_id IN (
    SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    UNION SELECT id FROM public.organizations WHERE owner_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_crm_ee_org_pending
  ON public.crm_external_events (org_id, received_at DESC) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS idx_crm_ee_email
  ON public.crm_external_events (org_id, entity_email) WHERE entity_email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. manage_crm_webhook_subscription — CRUD for webhook subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.manage_crm_webhook_subscription(
  p_org_id        UUID,
  p_action        TEXT,   -- 'create' | 'update' | 'delete' | 'toggle'
  p_name          TEXT    DEFAULT NULL,
  p_event_types   JSONB   DEFAULT '[]',
  p_endpoint_url  TEXT    DEFAULT NULL,
  p_subscription_id UUID  DEFAULT NULL,
  p_is_active     BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret TEXT;
  v_id     UUID;
BEGIN
  IF p_action = 'create' THEN
    IF p_endpoint_url IS NULL OR p_name IS NULL THEN
      RETURN jsonb_build_object('success', FALSE, 'error', 'name and endpoint_url required');
    END IF;
    -- Generate signing secret
    v_secret := encode(gen_random_bytes(32), 'hex');
    INSERT INTO crm_webhook_subscriptions
      (org_id, name, event_types, endpoint_url, signing_secret)
    VALUES (p_org_id, p_name, p_event_types, p_endpoint_url, v_secret)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', TRUE, 'id', v_id, 'signing_secret', v_secret);

  ELSIF p_action = 'update' THEN
    UPDATE crm_webhook_subscriptions
    SET name = COALESCE(p_name, name),
        event_types = COALESCE(p_event_types, event_types),
        endpoint_url = COALESCE(p_endpoint_url, endpoint_url),
        updated_at = now()
    WHERE id = p_subscription_id AND org_id = p_org_id;
    RETURN jsonb_build_object('success', TRUE);

  ELSIF p_action = 'delete' THEN
    DELETE FROM crm_webhook_subscriptions WHERE id = p_subscription_id AND org_id = p_org_id;
    RETURN jsonb_build_object('success', TRUE);

  ELSIF p_action = 'toggle' THEN
    UPDATE crm_webhook_subscriptions
    SET is_active = COALESCE(p_is_active, NOT is_active), updated_at = now()
    WHERE id = p_subscription_id AND org_id = p_org_id;
    RETURN jsonb_build_object('success', TRUE);

  ELSE
    RETURN jsonb_build_object('success', FALSE, 'error', 'Unknown action');
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. get_crm_webhook_subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_webhook_subscriptions(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'subscriptions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', ws.id, 'name', ws.name, 'event_types', ws.event_types,
        'endpoint_url', ws.endpoint_url, 'is_active', ws.is_active,
        'failure_count', ws.failure_count, 'last_delivered_at', ws.last_delivered_at,
        'last_error', ws.last_error, 'created_at', ws.created_at,
        'recent_deliveries', (
          SELECT jsonb_agg(jsonb_build_object(
            'event_type', wd.event_type, 'status', wd.status,
            'response_code', wd.response_code, 'delivered_at', wd.delivered_at
          ) ORDER BY wd.created_at DESC)
          FROM crm_webhook_deliveries wd
          WHERE wd.subscription_id = ws.id
          ORDER BY wd.created_at DESC LIMIT 5
        )
      ) ORDER BY ws.created_at DESC)
      FROM crm_webhook_subscriptions ws WHERE ws.org_id = p_org_id
    ), '[]'::jsonb),

    'delivery_stats', (
      SELECT jsonb_build_object(
        'total_deliveries', COUNT(*),
        'delivered', COUNT(*) FILTER (WHERE status = 'delivered'),
        'failed', COUNT(*) FILTER (WHERE status = 'failed'),
        'pending', COUNT(*) FILTER (WHERE status IN ('pending','retrying'))
      )
      FROM crm_webhook_deliveries WHERE org_id = p_org_id
        AND created_at >= now() - INTERVAL '7 days'
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. queue_crm_webhook_delivery — called by other RPCs to fire webhook events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.queue_crm_webhook_delivery(
  p_org_id      UUID,
  p_event_type  TEXT,
  p_payload     JSONB
)
RETURNS INT   -- number of subscriptions queued
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT := 0;
BEGIN
  INSERT INTO crm_webhook_deliveries
    (subscription_id, org_id, event_type, event_payload, status, next_retry_at)
  SELECT ws.id, p_org_id, p_event_type, p_payload, 'pending', now()
  FROM crm_webhook_subscriptions ws
  WHERE ws.org_id = p_org_id
    AND ws.is_active
    AND ws.event_types @> jsonb_build_array(p_event_type);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. get_crm_external_events — query inbound external events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crm_external_events(
  p_org_id    UUID,
  p_processed BOOLEAN DEFAULT NULL,
  p_limit     INT     DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', ee.id, 'source', ee.source, 'event_type', ee.event_type,
        'entity_type', ee.entity_type, 'entity_email', ee.entity_email,
        'crm_contact_id', ee.crm_contact_id, 'payload', ee.payload,
        'processed', ee.processed, 'processing_note', ee.processing_note,
        'received_at', ee.received_at
      ) ORDER BY ee.received_at DESC)
      FROM crm_external_events ee
      WHERE ee.org_id = p_org_id
        AND (p_processed IS NULL OR ee.processed = p_processed)
      ORDER BY ee.received_at DESC
      LIMIT p_limit
    ), '[]'::jsonb),
    'unprocessed_count', (
      SELECT COUNT(*) FROM crm_external_events
      WHERE org_id = p_org_id AND NOT processed
    ),
    'sources', (
      SELECT jsonb_object_agg(source, cnt) FROM (
        SELECT source, COUNT(*) AS cnt FROM crm_external_events
        WHERE org_id = p_org_id AND received_at >= now() - INTERVAL '7 days'
        GROUP BY source
      ) t
    )
  ) INTO v_result;
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Supported webhook event types (reference data for UI dropdowns)
-- ─────────────────────────────────────────────────────────────────────────────
-- These are the event_type values the crm_webhook_worker will emit:
-- 'crm.trajectory_worsened'     — contact trajectory moved to deteriorating/critical
-- 'crm.strategic_escalation'    — critical/high escalation opened on strategic account
-- 'crm.expansion_fatigue'       — expansion opportunity stale >21 days
-- 'crm.pulse_deterioration'     — portfolio health pulse declined week-over-week
-- 'crm.trust_hub_at_risk'       — trust_hub contact has churn >= 50%
-- 'crm.blocker_critical'        — blocker_hub flagged as structurally critical
-- 'crm.churn_spike'             — new high-churn contact (>= 75%) detected
-- 'crm.recovery_succeeded'      — contact moved from high-churn to recovered
-- 'crm.operating_consciousness_alert' — consciousness_level crossed to critical/degraded
