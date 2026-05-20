// crm_webhook_worker — picks up pending/retrying webhook deliveries, signs and delivers them
// pg_cron calls this every 2 minutes; no JWT required

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BATCH_SIZE = 10;

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Claim a batch of pending/retrying deliveries that are due
  const { data: deliveries, error } = await sb
    .from('crm_webhook_deliveries')
    .select(`
      id, subscription_id, org_id, event_type, event_payload,
      attempt_count, max_attempts,
      crm_webhook_subscriptions!inner(endpoint_url, signing_secret, delivery_timeout_ms, is_active)
    `)
    .in('status', ['pending', 'retrying'])
    .lte('next_retry_at', new Date().toISOString())
    .limit(BATCH_SIZE);

  if (error) {
    console.error('Fetch error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!deliveries || deliveries.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { status: 200 });
  }

  let delivered = 0, failed = 0;

  for (const d of deliveries) {
    const sub = (d as any).crm_webhook_subscriptions;
    if (!sub?.is_active) {
      await sb.from('crm_webhook_deliveries').update({ status: 'skipped' }).eq('id', d.id);
      continue;
    }

    const payload = {
      id: d.id,
      event_type: d.event_type,
      org_id: d.org_id,
      payload: d.event_payload,
      timestamp: new Date().toISOString(),
    };
    const bodyStr = JSON.stringify(payload);
    const signature = await hmacSign(sub.signing_secret, bodyStr);

    const timeoutMs = Math.min(sub.delivery_timeout_ms ?? 5000, 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let responseCode: number | null = null;
    let responseBody: string | null = null;
    let lastError: string | null = null;
    let success = false;

    try {
      const res = await fetch(sub.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GSC-Signature': `sha256=${signature}`,
          'X-GSC-Event': d.event_type,
          'X-GSC-Delivery': d.id,
        },
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      responseCode = res.status;
      responseBody = (await res.text()).substring(0, 500);
      success = res.ok;
    } catch (e: any) {
      clearTimeout(timer);
      lastError = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'network_error');
    }

    const newAttemptCount = (d.attempt_count ?? 0) + 1;
    const maxAttempts = d.max_attempts ?? 3;
    const exhausted = newAttemptCount >= maxAttempts;

    if (success) {
      await sb.from('crm_webhook_deliveries').update({
        status: 'delivered',
        attempt_count: newAttemptCount,
        response_code: responseCode,
        response_body: responseBody,
        delivered_at: new Date().toISOString(),
        last_error: null,
        next_retry_at: null,
      }).eq('id', d.id);

      // Update subscription last_delivered_at + reset failure_count
      await sb.from('crm_webhook_subscriptions').update({
        last_delivered_at: new Date().toISOString(),
        failure_count: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', d.subscription_id);

      delivered++;
    } else {
      // Exponential backoff: 1m, 5m, 30m
      const backoffMinutes = [1, 5, 30][Math.min(newAttemptCount - 1, 2)];
      const nextRetry = exhausted ? null : new Date(Date.now() + backoffMinutes * 60000).toISOString();

      await sb.from('crm_webhook_deliveries').update({
        status: exhausted ? 'failed' : 'retrying',
        attempt_count: newAttemptCount,
        response_code: responseCode,
        response_body: responseBody,
        last_error: lastError ?? `HTTP ${responseCode}`,
        next_retry_at: nextRetry,
      }).eq('id', d.id);

      // Increment subscription failure_count
      const { data: ws } = await sb.from('crm_webhook_subscriptions')
        .select('failure_count').eq('id', d.subscription_id).single();
      const newFailureCount = ((ws?.failure_count ?? 0) + 1);
      await sb.from('crm_webhook_subscriptions').update({
        failure_count: newFailureCount,
        last_error: lastError ?? `HTTP ${responseCode}`,
        // Auto-disable after 10 consecutive failures
        is_active: newFailureCount < 10,
        updated_at: new Date().toISOString(),
      }).eq('id', d.subscription_id);

      failed++;
    }
  }

  return new Response(JSON.stringify({ processed: deliveries.length, delivered, failed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
