-- LGE Phase 2 — Operator note column
-- Allows operators to leave a note when manually pushing or discarding a review-queue lead.

ALTER TABLE public.lge_raw_leads ADD COLUMN IF NOT EXISTS operator_note text;
