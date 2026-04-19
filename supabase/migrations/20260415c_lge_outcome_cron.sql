-- Migration: LGE outcome sync pg_cron job
-- Session: LGE Session 3
-- lge_outcome_sync runs daily at 01:00 UTC — after nightly maintenance, before business hours.

SELECT cron.schedule(
    'lge-outcome-sync',
    '0 1 * * *',
    $cron_cmd$
    SELECT net.http_post(
        url     := 'https://klbwigcvrdfeeeeotehu.supabase.co/functions/v1/lge_outcome_sync',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsYndpZ2N2cmRmZWVlZW90ZWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NDA4MDgsImV4cCI6MjA4NDExNjgwOH0.gdqggXxOsl0CO0ctKfCWYzVuMrmP6TXSiYftTXDC4v8'
        ),
        body    := jsonb_build_object('trigger', 'pg_cron')
    ) AS request_id;
    $cron_cmd$
);
