-- LGE Phase 6: per-campaign routing thresholds + outreach template
-- auto_push_threshold: score >= this → auto-push to GSC (default 80)
-- review_threshold:    score >= this → review queue   (default 60)
-- outreach_template:   null = AI-generated | non-null = force_content on execution_task

ALTER TABLE public.lge_campaigns
  ADD COLUMN IF NOT EXISTS auto_push_threshold integer NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS review_threshold     integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS outreach_template    text;

-- Guard: auto_push must be strictly above review, both within sane ranges
ALTER TABLE public.lge_campaigns
  DROP CONSTRAINT IF EXISTS lge_campaigns_thresholds_ordered;
ALTER TABLE public.lge_campaigns
  ADD CONSTRAINT lge_campaigns_thresholds_ordered
    CHECK (
      auto_push_threshold > review_threshold
      AND auto_push_threshold BETWEEN 51 AND 100
      AND review_threshold   BETWEEN 0  AND 99
    );
