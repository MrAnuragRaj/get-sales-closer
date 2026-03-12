const https = require('https');

// Fixed refresh function v3:
// - entry_type = 'grant' (NOT NULL)
// - balance_after = allotment (NOT NULL)
// - wallet_id = looked up from credit_wallets (NOT NULL)
// - source_object_id = gen_random_uuid() (UUID NOT NULL)
// - quantity (not amount) for credit_ledger
// - idempotency check via idempotency_key (text)
const sql = `CREATE OR REPLACE FUNCTION public.refresh_doctor_report_credits()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $fn$
/*
 * refresh_doctor_report_credits()
 *
 * Resets each org's doctor_report quota to its monthly plan allotment.
 * Writes to BOTH wallet systems:
 *   credit_wallets  — display / audit layer
 *   token_wallets   — runtime layer (what consume_tokens_v1 and UI badge read)
 * Called by pg_cron job #17 on the 1st of each month at 00:05 UTC.
 */
DECLARE
  r              RECORD;
  allotment      INTEGER;
  period_key     TEXT;
  idem_key       TEXT;
  wallet_id_val  UUID;
BEGIN
  period_key := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM');

  FOR r IN
    SELECT
      o.id       AS org_id,
      o.org_type,
      CASE
        WHEN o.org_type = 'enterprise'
          AND EXISTS (SELECT 1 FROM org_services os WHERE os.org_id = o.id AND os.service_key = 'voice' AND os.status = 'active') THEN 999
        WHEN EXISTS (SELECT 1 FROM org_services os WHERE os.org_id = o.id AND os.service_key = 'voice' AND os.status = 'active') THEN 10
        ELSE 0
      END AS monthly_allotment
    FROM organizations o
    WHERE o.cancellation_status IS DISTINCT FROM 'cancelled_immediate'
      AND (
        o.cancellation_status IS NULL
        OR o.cancellation_status = 'cancelled_end_of_term'
           AND (o.service_ends_at IS NULL OR o.service_ends_at > NOW())
      )
  LOOP
    allotment := r.monthly_allotment;
    CONTINUE WHEN allotment = 0;

    idem_key := 'dr_monthly_refresh_' || r.org_id || '_' || period_key;

    -- Idempotency: skip if already refreshed this month
    IF EXISTS (
      SELECT 1 FROM credit_ledger cl WHERE cl.idempotency_key = idem_key
    ) THEN
      CONTINUE;
    END IF;

    -- credit_wallets (display / audit layer)
    INSERT INTO credit_wallets (org_id, token_key, available_balance)
    VALUES (r.org_id, 'doctor_report', 0)
    ON CONFLICT (org_id, token_key) DO NOTHING;

    UPDATE credit_wallets
    SET available_balance = allotment
    WHERE org_id = r.org_id AND token_key = 'doctor_report';

    -- Get wallet_id for ledger entry
    SELECT id INTO wallet_id_val
    FROM credit_wallets
    WHERE org_id = r.org_id AND token_key = 'doctor_report';

    INSERT INTO credit_ledger (
      org_id, token_key, entry_type, direction, quantity,
      balance_after, wallet_id, source_object_type, source_object_id,
      idempotency_key, note
    ) VALUES (
      r.org_id, 'doctor_report', 'grant', 'credit', allotment,
      allotment, wallet_id_val, 'monthly_refresh', gen_random_uuid(),
      idem_key,
      'Monthly Revenue Doctor allotment reset: ' || allotment || ' report(s)'
    );

    -- token_wallets (runtime layer — what consume_tokens_v1 and UI badge read)
    INSERT INTO token_wallets (org_id, scope, user_id, token_key, balance, updated_at)
    VALUES (r.org_id, 'org', NULL, 'doctor_report', allotment, NOW())
    ON CONFLICT DO NOTHING;

    UPDATE token_wallets
    SET balance = allotment, updated_at = NOW()
    WHERE org_id    = r.org_id
      AND scope     = 'org'
      AND user_id   IS NULL
      AND token_key = 'doctor_report';

  END LOOP;
END;
$fn$;`;

const body = JSON.stringify({ query: sql });
const opts = {
  hostname: 'api.supabase.com',
  path: '/v1/projects/klbwigcvrdfeeeeotehu/database/query',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sbp_d927ee7a861972fd539ec0be4bac84d0bfabb1c2',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }
};
const req = https.request(opts, r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => console.log(d));
});
req.write(body);
req.end();
