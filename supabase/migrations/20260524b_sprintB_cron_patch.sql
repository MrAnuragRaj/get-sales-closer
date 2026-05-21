-- Sprint B cron patch: use named dollar-quote tags to avoid nested $$ collision

-- Remove any previous attempt to avoid duplicate
SELECT cron.unschedule('crm-sprintB-nightly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'crm-sprintB-nightly'
);

SELECT cron.schedule(
  'crm-sprintB-nightly',
  '45 8 * * *',
  $cron_sql$
    DO $inner$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT DISTINCT org_id FROM public.crm_contacts
        WHERE org_id IN (
          SELECT id FROM public.organizations WHERE cancellation_status IS NULL
        )
      LOOP
        PERFORM public.compute_crm_sprintB_nightly(r.org_id);
      END LOOP;
    END;
    $inner$ LANGUAGE plpgsql;
  $cron_sql$
);

-- Initial seed: generate today's digest for all active orgs
DO $seed$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT org_id FROM public.crm_contacts
    WHERE org_id IN (SELECT id FROM public.organizations WHERE cancellation_status IS NULL)
  LOOP
    BEGIN
      PERFORM public.generate_crm_executive_digest(r.org_id, 'daily');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Initial digest failed for org %: %', r.org_id, SQLERRM;
    END;
  END LOOP;
END;
$seed$;
