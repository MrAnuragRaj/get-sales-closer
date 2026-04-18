-- LGE Phase 10: Audit Visibility, Controlled Outcomes, Single-Lead Recovery

-- ── 1. Manual outcome columns on lge_outcomes ─────────────────────────────────
ALTER TABLE public.lge_outcomes
  ADD COLUMN IF NOT EXISTS is_manual       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_reason   text,
  ADD COLUMN IF NOT EXISTS manual_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_at       timestamptz,
  ADD COLUMN IF NOT EXISTS source_priority integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_synced_at  timestamptz;

-- ── 2. Non-destructive re-enrichment columns on lge_raw_leads ─────────────────
ALTER TABLE public.lge_raw_leads
  ADD COLUMN IF NOT EXISTS processing_version integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_reenrich_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reenrich_reason    text;

-- ── 3. Index: fast lookup of manual outcomes ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lge_outcomes_manual
  ON public.lge_outcomes(raw_lead_id, is_manual)
  WHERE is_manual = true;

-- ── 4. Outcome stage ordering for the outcome ladder ─────────────────────────
-- Stored as a comment for reference; enforced in application code:
-- no_reply(0) → replied(1) → booked(2) → closed(4); backward movement blocked for operators

-- ── 5. Ensure lge_outcomes has unique constraint on raw_lead_id ───────────────
-- (Should already exist from Phase 1 migration; safe to re-add if not)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lge_outcomes'::regclass
      AND contype = 'u'
      AND conname = 'lge_outcomes_raw_lead_id_key'
  ) THEN
    ALTER TABLE public.lge_outcomes ADD CONSTRAINT lge_outcomes_raw_lead_id_key UNIQUE (raw_lead_id);
  END IF;
END $$;
