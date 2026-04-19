-- Fix: add 'lead_gen' to the add-on whitelist in process_pending_activations
-- Root cause: activation job ran successfully but silently skipped lead_gen because it
-- wasn't in the IN (...) key filter. Job showed 'completed' but org_services never got lead_gen.

CREATE OR REPLACE FUNCTION public.process_pending_activations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job activation_jobs%rowtype;
  v_intent billing_intents%rowtype;
  v_svc text;
  v_expires_at timestamptz;
  v_processed int := 0;
  v_failed int := 0;
BEGIN
  FOR v_job IN
    SELECT * FROM activation_jobs
    WHERE status = 'pending' AND attempts < 5
    ORDER BY created_at
    LIMIT 20
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      SELECT * INTO v_intent FROM billing_intents WHERE id = v_job.intent_id;
      IF NOT FOUND THEN
        UPDATE activation_jobs SET status = 'failed', last_error = 'INTENT_NOT_FOUND', updated_at = now() WHERE id = v_job.id;
        v_failed := v_failed + 1;
        CONTINUE;
      END IF;

      v_expires_at := CASE
        WHEN coalesce(v_intent.billing_cycle, v_intent.pricing_snapshot->>'billing_cycle') = 'yearly'
          THEN now() + interval '1 year'
        ELSE now() + interval '1 month'
      END;

      -- Activate core services
      FOR v_svc IN
        SELECT key FROM jsonb_each_text(v_intent.services) WHERE value = 'true'
      LOOP
        INSERT INTO org_services (org_id, service_key, status)
        VALUES (v_intent.org_id, v_svc, 'active')
        ON CONFLICT (org_id, service_key) DO UPDATE SET status = 'active';
      END LOOP;

      -- Activate all add-on services (including lead_gen)
      FOR v_svc IN
        SELECT key FROM jsonb_each_text(coalesce(v_intent.addons, '{}'::jsonb))
        WHERE value = 'true'
          AND key IN ('chatbot', 'intake', 'safe_voice', 'priority', 'growth_engine', 'sce', 'eb', 'lead_gen')
      LOOP
        INSERT INTO org_services (org_id, service_key, status)
        VALUES (v_intent.org_id, v_svc, 'active')
        ON CONFLICT (org_id, service_key) DO UPDATE SET status = 'active';
      END LOOP;

      UPDATE billing_intents SET expires_at = v_expires_at WHERE id = v_intent.id AND expires_at IS NULL;
      UPDATE activation_jobs SET status = 'completed', updated_at = now() WHERE id = v_job.id;
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE activation_jobs SET status = 'pending', attempts = attempts + 1, last_error = sqlerrm, updated_at = now() WHERE id = v_job.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('processed', v_processed, 'failed', v_failed);
END;
$function$;
