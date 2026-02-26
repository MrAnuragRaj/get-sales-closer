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