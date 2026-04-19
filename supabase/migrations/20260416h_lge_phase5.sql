-- LGE Phase 5 — Multi-Provider Expansion
-- Extends lge_enrichment to store phone verification, website reachability,
-- and firmographic source metadata from new providers.

ALTER TABLE public.lge_enrichment
  ADD COLUMN IF NOT EXISTS phone_line_type    text,     -- mobile | landline | voip | invalid | unknown
  ADD COLUMN IF NOT EXISTS phone_valid        boolean,
  ADD COLUMN IF NOT EXISTS website_reachable  boolean,
  ADD COLUMN IF NOT EXISTS firmographic_source text;    -- apollo | hunter_domain | none
