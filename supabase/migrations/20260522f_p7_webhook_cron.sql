-- P7: pg_cron job for crm_webhook_worker edge function (every 2 minutes)
SELECT cron.schedule(
  'crm_webhook_worker',
  '*/2 * * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_FUNCTION_URL') || '/crm_webhook_worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
    body := '{}'::jsonb
  )$$
);
