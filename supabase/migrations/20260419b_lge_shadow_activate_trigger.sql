-- LGE: Auto-reset scored leads when campaign switches from shadow → active
-- Without this, leads processed in shadow mode get stuck in 'scored' status
-- and never get routed even after the campaign is set to active mode.
-- The trigger fires transactionally on UPDATE OF mode, so the next worker
-- cycle automatically picks up and routes the previously shadow-scored leads.

CREATE OR REPLACE FUNCTION public.lge_campaign_mode_activate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mode = 'shadow' AND NEW.mode = 'active' THEN
    UPDATE public.lge_raw_leads
    SET status      = 'pending',
        attempt     = 0,
        locked_by   = NULL,
        locked_until = NULL
    WHERE campaign_id = NEW.id
      AND status = 'scored';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lge_campaign_activate ON public.lge_campaigns;
CREATE TRIGGER trg_lge_campaign_activate
  AFTER UPDATE OF mode ON public.lge_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.lge_campaign_mode_activate();
