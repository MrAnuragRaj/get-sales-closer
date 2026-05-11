-- CRM Sync Layer — Phase 2
-- 1. Fix crm_sync_mappings uniqueness to allow one Contact + one Deal per GSC lead
-- 2. Add retry_crm_sync_event RPC
-- 3. Add get_crm_sync_stats RPC

-- ── Fix mapping uniqueness ────────────────────────────────────────────────────
-- Original constraint only keyed on 3 columns, preventing one GSC lead from
-- mapping to BOTH a Contact and a Deal in the same CRM destination.
-- New constraint includes external_entity_type so each combination is unique.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'public.crm_sync_mappings'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 3;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.crm_sync_mappings DROP CONSTRAINT %I', cname);
  END IF;
END;
$$;

ALTER TABLE public.crm_sync_mappings
  ADD CONSTRAINT crm_sync_mappings_unique_per_external_type
  UNIQUE(destination_id, internal_entity_type, internal_entity_id, external_entity_type);

-- Update the lookup index to match new constraint
DROP INDEX IF EXISTS idx_crm_sync_mappings_lookup;
CREATE INDEX idx_crm_sync_mappings_lookup
  ON public.crm_sync_mappings(destination_id, internal_entity_type, internal_entity_id, external_entity_type);

-- ── retry_crm_sync_event ─────────────────────────────────────────────────────
-- Resets a failed or skipped event back to pending for manual retry.
-- Scoped to org_id so one org cannot retry another org's events.

CREATE OR REPLACE FUNCTION public.retry_crm_sync_event(
  p_event_id uuid,
  p_org_id   uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.crm_sync_events
  SET
    status         = 'pending',
    attempts       = 0,
    last_error     = NULL,
    processed_at   = NULL,
    destination_id = NULL
  WHERE id      = p_event_id
    AND org_id  = p_org_id
    AND status IN ('failed', 'skipped');
  RETURN FOUND;
END;
$$;

-- ── get_crm_sync_stats ───────────────────────────────────────────────────────
-- Returns event counts by status for the Sync Monitor UI.

CREATE OR REPLACE FUNCTION public.get_crm_sync_stats(p_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'pending',    COUNT(*) FILTER (WHERE status = 'pending'),
    'processing', COUNT(*) FILTER (WHERE status = 'processing'),
    'synced',     COUNT(*) FILTER (WHERE status = 'synced'),
    'failed',     COUNT(*) FILTER (WHERE status = 'failed'),
    'skipped',    COUNT(*) FILTER (WHERE status = 'skipped'),
    'total',      COUNT(*)
  ) INTO result
  FROM public.crm_sync_events
  WHERE org_id = p_org_id;
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;

-- ── get_crm_sync_logs ────────────────────────────────────────────────────────
-- Returns recent sync logs for the Sync Monitor UI, ordered newest first.

CREATE OR REPLACE FUNCTION public.get_crm_sync_logs(
  p_org_id uuid,
  p_limit  int DEFAULT 50
) RETURNS TABLE (
  log_id           uuid,
  event_id         uuid,
  event_type       text,
  entity_type      text,
  crm_type         text,
  action           text,
  status           text,
  error_message    text,
  created_at       timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    l.id           AS log_id,
    l.event_id,
    e.event_type,
    e.entity_type,
    d.crm_type,
    l.action,
    l.status,
    l.error_message,
    l.created_at
  FROM public.crm_sync_logs l
  LEFT JOIN public.crm_sync_events    e ON e.id = l.event_id
  LEFT JOIN public.crm_destinations   d ON d.id = l.destination_id
  WHERE l.org_id = p_org_id
  ORDER BY l.created_at DESC
  LIMIT p_limit;
$$;

-- ── get_failed_crm_events ────────────────────────────────────────────────────
-- Returns failed events for the Sync Monitor retry table.

CREATE OR REPLACE FUNCTION public.get_failed_crm_events(
  p_org_id uuid,
  p_limit  int DEFAULT 25
) RETURNS TABLE (
  event_id        uuid,
  event_type      text,
  entity_type     text,
  entity_id       uuid,
  status          text,
  attempts        int,
  max_attempts    int,
  last_error      text,
  crm_type        text,
  created_at      timestamptz,
  processed_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    e.id            AS event_id,
    e.event_type,
    e.entity_type,
    e.entity_id,
    e.status,
    e.attempts,
    e.max_attempts,
    e.last_error,
    d.crm_type,
    e.created_at,
    e.processed_at
  FROM public.crm_sync_events e
  LEFT JOIN public.crm_destinations d ON d.id = e.destination_id
  WHERE e.org_id  = p_org_id
    AND e.status IN ('failed', 'skipped')
  ORDER BY e.created_at DESC
  LIMIT p_limit;
$$;
