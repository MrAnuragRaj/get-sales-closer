-- LGE Phase 8: Import History + Lead Notes Thread

-- ── 1. Import Batches ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_import_batches (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL,
  campaign_id   uuid        NOT NULL REFERENCES public.lge_campaigns(id) ON DELETE CASCADE,
  source        text        NOT NULL DEFAULT 'csv',
  total         integer     NOT NULL DEFAULT 0,
  accepted      integer     NOT NULL DEFAULT 0,
  duplicates    integer     NOT NULL DEFAULT 0,
  invalid       integer     NOT NULL DEFAULT 0,
  imported_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lge_import_batches_org
  ON public.lge_import_batches(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lge_import_batches_campaign
  ON public.lge_import_batches(campaign_id, created_at DESC);

-- ── 2. Lead Notes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lge_lead_notes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL,
  raw_lead_id   uuid        NOT NULL REFERENCES public.lge_raw_leads(id) ON DELETE CASCADE,
  note          text        NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  created_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lge_lead_notes_lead
  ON public.lge_lead_notes(raw_lead_id, created_at ASC);
