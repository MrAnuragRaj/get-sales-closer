import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts"

console.log("Razorpay Webhook: Initialized")

serve(async (req) => {
  try {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    const signature = req.headers.get('x-razorpay-signature')
    const secret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')

    if (!signature || !secret) return new Response('Config Error', { status: 400 })

    const body = await req.text()
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    )
    
    const verified = await crypto.subtle.verify(
      'HMAC', key, hexToUint8Array(signature), encoder.encode(body)
    )

    if (!verified) return new Response('Unauthorized', { status: 401 })

    // ✅ NEW: Canonical Call to Database Authority
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const payload = JSON.parse(body)

    const { data, error } = await supabaseAdmin.rpc('record_webhook_and_process_razorpay', {
        p_payload: payload,
        p_signature_valid: true
    })

    if (error) {
        console.error('DB Authority Failed:', error)
        return new Response('Processing Failed', { status: 500 })
    }

    console.log("Authority Response:", data)

    // --- Credit top-up fulfillment ---
    // If payment.captured and the billing_intent is a credit_topup, grant credits via ledger.
    // We pass razorpay_amount_raw for audit logging only — credits are NEVER computed from it.
    // Amount integrity is verified server-to-server inside fulfill-paid-order.
    try {
      const event = payload?.event as string
      const paymentEntity = payload?.payload?.payment?.entity as Record<string, unknown> | undefined
      const notes = paymentEntity?.notes as Record<string, string> | undefined
      const intent_id = notes?.intent_id
      const payment_id = paymentEntity?.id as string | undefined
      // Razorpay amount is in paise (INR) or smallest currency unit — for audit only
      const razorpay_amount_raw = paymentEntity?.amount as number | undefined

      if (event === 'payment.captured' && intent_id) {
        const { data: intentRows } = await supabaseAdmin
          .from('billing_intents')
          .select('id, intent_source')
          .eq('id', intent_id)
          .limit(1)

        const intent = intentRows?.[0]
        if (intent?.intent_source === 'credit_topup') {
          console.log('[webhook-razorpay] credit_topup captured — amount_raw:', razorpay_amount_raw, 'intent:', intent_id)
          const { error: fulfillErr } = await supabaseAdmin.functions.invoke('fulfill-paid-order', {
            body: {
              billing_intent_id: intent_id,
              payment_event_id: payment_id ?? 'webhook',
              razorpay_amount_raw,
            },
          })
          if (fulfillErr) {
            console.error('[webhook-razorpay] fulfill-paid-order error (non-fatal):', fulfillErr)
          }
        } else if (intent?.intent_source === 'number_purchase') {
          console.log('[webhook-razorpay] number_purchase captured — amount_raw:', razorpay_amount_raw, 'intent:', intent_id)
          const { error: fulfillErr } = await supabaseAdmin.functions.invoke('fulfill-number-request', {
            body: {
              billing_intent_id: intent_id,
              payment_event_id: payment_id ?? 'webhook',
              razorpay_amount_raw,
            },
          })
          if (fulfillErr) {
            console.error('[webhook-razorpay] fulfill-number-request error (non-fatal):', fulfillErr)
          }
        }
      }
    } catch (fulfillEx) {
      // Non-fatal — do not fail the webhook response
      console.error('[webhook-razorpay] credit fulfillment error (non-fatal):', fulfillEx)
    }

    return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200, headers: { "Content-Type": "application/json" }
    })

  } catch (err) {
    console.error("Worker Error:", err)
    return new Response('Server Error', { status: 500 })
  }
})

function hexToUint8Array(hex: string) {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)))
}