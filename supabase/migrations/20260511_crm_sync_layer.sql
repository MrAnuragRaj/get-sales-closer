-- CRM Sync Layer — Phase 1
-- Tables: crm_destinations, crm_sync_events, crm_sync_mappings, crm_sync_logs
-- RPC:    claim_crm_sync_events

-- ── crm_destinations ────────────────────────────────────────────────────────
-- Stores per-org CRM connection config (HubSpot, Salesforce, Pipedrive, Zoho, native stub)

CREATE TABLE public.crm_destinations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  crm_type            text        NOT NULL CHECK (crm_type IN ('native','hubspot','salesforce','pipedrive','zoho')),
  is_active           boolean     NOT NULL DEFAULT true,
  priority            int         NOT NULL DEFAULT 100,
  config_json         jsonb       NOT NULL DEFAULT '{}',
  auth_json_encrypted text,
  health_status       text        NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy','degraded','auth_failed')),
  last_sync_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_crm_destinations_org_active ON public.crm_destinations(org_id, priority ASC) WHERE is_active = true;
ALTER TABLE public.crm_destinations ENABLE ROW LEVEL SECURITY;

-- ── crm_sync_events ─────────────────────────────────────────────────────────
-- Canonical async event queue. GSC/LGE write here; worker processes.

CREATE TABLE public.crm_sync_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_system    text        NOT NULL CHECK (source_system IN ('gsc','lge')),
  event_type       text        NOT NULL CHECK (event_type IN (
                     'lead_created','lead_contacted','lead_replied',
                     'meeting_booked','customer_converted',
                     'deal_won','deal_lost','customer_updated'
                   )),
  entity_type      text        NOT NULL CHECK (entity_type IN ('lead','contact','deal','customer','activity')),
  entity_id        uuid        NOT NULL,
  payload_json     jsonb       NOT NULL DEFAULT '{}',
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','synced','failed','skipped')),
  destination_id   uuid        REFERENCES public.crm_destinations(id) ON DELETE SET NULL,
  attempts         int         NOT NULL DEFAULT 0,
  max_attempts     int         NOT NULL DEFAULT 5,
  idempotency_key  text        UNIQUE,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);

CREATE INDEX idx_crm_sync_events_pending  ON public.crm_sync_events(created_at ASC) WHERE status = 'pending';
CREATE INDEX idx_crm_sync_events_org      ON public.crm_sync_events(org_id, created_at DESC);
CREATE INDEX idx_crm_sync_events_entity   ON public.crm_sync_events(entity_id, event_type);
ALTER TABLE public.crm_sync_events ENABLE ROW LEVEL SECURITY;

-- ── crm_sync_mappings ────────────────────────────────────────────────────────
-- Maps internal GSC entity IDs to external CRM record IDs.
-- Prevents duplicate creates on retry.

CREATE TABLE public.crm_sync_mappings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  destination_id       uuid        NOT NULL REFERENCES public.crm_destinations(id) ON DELETE CASCADE,
  internal_entity_type text        NOT NULL,
  internal_entity_id   uuid        NOT NULL,
  external_entity_type text        NOT NULL,
  external_entity_id   text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE(destination_id, internal_entity_type, internal_entity_id)
);

CREATE INDEX idx_crm_sync_mappings_lookup ON public.crm_sync_mappings(destination_id, internal_entity_type, internal_entity_id);
ALTER TABLE public.crm_sync_mappings ENABLE ROW LEVEL SECURITY;

-- ── crm_sync_logs ────────────────────────────────────────────────────────────
-- Full audit trail of every sync attempt.

CREATE TABLE public.crm_sync_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid        REFERENCES public.crm_sync_events(id) ON DELETE SET NULL,
  org_id           uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  destination_id   uuid        REFERENCES public.crm_destinations(id) ON DELETE SET NULL,
  action           text,
  status           text,
  request_summary  jsonb,
  response_summary jsonb,
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_crm_sync_logs_event ON public.crm_sync_logs(event_id);
CREATE INDEX idx_crm_sync_logs_org   ON public.crm_sync_logs(org_id, created_at DESC);
ALTER TABLE public.crm_sync_logs ENABLE ROW LEVEL SECURITY;

-- ── RPC: claim_crm_sync_events ───────────────────────────────────────────────
-- Atomically claims a batch of pending events → sets status='processing'.
-- Uses FOR UPDATE SKIP LOCKED to prevent double-processing under concurrent workers.

CREATE OR REPLACE FUNCTION public.claim_crm_sync_events(p_batch_size int DEFAULT 20)
RETURNS SETOF public.crm_sync_events
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.crm_sync_events
  SET status = 'processing'
  WHERE id IN (
    SELECT id FROM public.crm_sync_events
    WHERE status = 'pending'
      AND attempts < max_attempts
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;
