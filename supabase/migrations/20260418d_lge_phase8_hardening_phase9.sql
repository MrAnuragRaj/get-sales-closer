-- LGE Phase 8 Hardening + Phase 9: Score Override + Campaign Lifecycle

-- ── Phase 8 Hardening ─────────────────────────────────────────────────────────

-- 1. Import batch idempotency key
ALTER TABLE public.lge_import_batches
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lge_import_batches_idempotency
  ON public.lge_import_batches(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2. source_type enum normalization (add check; existing rows default to 'csv')
ALTER TABLE public.lge_import_batches
  DROP CONSTRAINT IF EXISTS lge_import_batches_source_check;
ALTER TABLE public.lge_import_batches
  ADD CONSTRAINT lge_import_batches_source_check
  CHECK (source IN ('csv', 'webhook', 'api_key', 'internal'));

-- 3. Add gsc_lead_id to notes (nullable — populated after push)
ALTER TABLE public.lge_lead_notes
  ADD COLUMN IF NOT EXISTS gsc_lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_lge_lead_notes_gsc_lead
  ON public.lge_lead_notes(gsc_lead_id)
  WHERE gsc_lead_id IS NOT NULL;

-- ── Phase 9: Score Override ───────────────────────────────────────────────────

-- 4. Override columns on lge_scores
ALTER TABLE public.lge_scores
  ADD COLUMN IF NOT EXISTS is_manual_override boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason    text,
  ADD COLUMN IF NOT EXISTS override_by        uuid     REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_at        timestamptz,
  ADD COLUMN IF NOT EXISTS system_fit_score   integer, -- snapshot of machine score before override
  ADD COLUMN IF NOT EXISTS system_confidence_score integer,
  ADD COLUMN IF NOT EXISTS system_total_score integer;

-- ── Phase 9: Campaign Lifecycle ───────────────────────────────────────────────

-- 5. Allow 'paused' as a campaign status
ALTER TABLE public.lge_campaigns
  DROP CONSTRAINT IF EXISTS lge_campaigns_status_check;
ALTER TABLE public.lge_campaigns
  ADD CONSTRAINT lge_campaigns_status_check
  CHECK (status IN ('active', 'paused', 'archived'));

-- 6. Store previous mode so resume can restore it
ALTER TABLE public.lge_campaigns
  ADD COLUMN IF NOT EXISTS pre_pause_mode text
  CHECK (pre_pause_mode IN ('off', 'shadow', 'active'));

-- 7. Campaign state audit log
CREATE TABLE IF NOT EXISTS public.lge_campaign_state_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  org_id        uuid        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('pause', 'resume', 'archive')),
  performed_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lge_campaign_state_logs_campaign
  ON public.lge_campaign_state_logs(campaign_id, created_at DESC);

-- ── Phase 9: Search Indexes ───────────────────────────────────────────────────

-- 8. Indexes for server-side search on lge_raw_leads
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_email_trgm
  ON public.lge_raw_leads(email);
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_company
  ON public.lge_raw_leads(lower(company));
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_name
  ON public.lge_raw_leads(lower(name));
CREATE INDEX IF NOT EXISTS idx_lge_raw_leads_source
  ON public.lge_raw_leads(org_id, source);

-- ── Phase 9: Update lge_claim_batch to skip paused campaigns ─────────────────

CREATE OR REPLACE FUNCTION public.lge_claim_batch(
  p_worker_id   text,
  p_batch_size  integer DEFAULT 10,
  p_lock_minutes integer DEFAULT 5
)
RETURNS TABLE (
  lead_id         uuid,
  campaign_id     uuid,
  org_id          uuid,
  lead_name       text,
  lead_email      text,
  lead_phone      text,
  lead_company    text,
  lead_source     text,
  raw_data        jsonb,
  attempt         integer,
  max_attempts    integer,
  campaign_mode   text,
  icp_config      jsonb
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT rl.id
    FROM lge_raw_leads rl
    WHERE rl.status IN ('pending','enriching')
      AND rl.attempt < rl.max_attempts
      AND (rl.locked_until IS NULL OR rl.locked_until < now())
      AND EXISTS (
        SELECT 1 FROM lge_campaigns c
        WHERE c.id = rl.campaign_id
          AND c.mode IN ('shadow','active')
          AND c.status NOT IN ('archived','paused')   -- skip both archived AND paused
      )
    ORDER BY rl.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE lge_raw_leads rl
    SET locked_by    = p_worker_id,
        locked_until = now() + (p_lock_minutes || ' minutes')::INTERVAL,
        status       = 'enriching',
        attempt      = rl.attempt + 1
    WHERE rl.id IN (SELECT id FROM claimed)
    RETURNING rl.id, rl.campaign_id, rl.org_id, rl.name, rl.email, rl.phone,
              rl.company, rl.source, rl.raw_data, rl.attempt, rl.max_attempts
  )
  SELECT u.id AS lead_id, u.campaign_id, u.org_id,
         u.name AS lead_name, u.email AS lead_email, u.phone AS lead_phone,
         u.company AS lead_company,
         coalesce(u.source, 'unknown') AS lead_source,
         u.raw_data, u.attempt, u.max_attempts,
         c.mode AS campaign_mode, c.icp_config
  FROM updated u
  JOIN lge_campaigns c ON c.id = u.campaign_id;
END;
$$;
