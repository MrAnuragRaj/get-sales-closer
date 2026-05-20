// crm_external_event_ingest — accepts inbound external signals from third-party systems
// Auth: api_keys table (same pattern as hook_inbound)
// POST /functions/v1/crm_external_event_ingest

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const VALID_SOURCES = ['salesforce','hubspot','support_ticket','billing_system','slack','cs_tool','analytics','custom'] as const;
const VALID_ENTITY_TYPES = ['contact','account','lead','opportunity','ticket'] as const;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // API key auth (X-API-Key header or api_key query param)
  const apiKey = req.headers.get('X-API-Key') ?? new URL(req.url).searchParams.get('api_key');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401 });
  }

  const { data: keyRow } = await sb
    .from('api_keys')
    .select('org_id, api_key')
    .eq('api_key', apiKey)
    .single();

  if (!keyRow) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 });
  }

  const org_id = keyRow.org_id;

  // Update last_used_at
  await sb.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('api_key', apiKey);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { source, event_type, entity_type, entity_email, entity_external_id, payload } = body;

  if (!source || !event_type) {
    return new Response(JSON.stringify({ error: 'source and event_type are required' }), { status: 400 });
  }

  if (!VALID_SOURCES.includes(source)) {
    return new Response(JSON.stringify({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(',')}` }), { status: 400 });
  }

  if (entity_type && !VALID_ENTITY_TYPES.includes(entity_type)) {
    return new Response(JSON.stringify({ error: `Invalid entity_type. Must be one of: ${VALID_ENTITY_TYPES.join(',')}` }), { status: 400 });
  }

  // Try to resolve crm_contact_id via entity_email
  let crm_contact_id: string | null = null;
  if (entity_email) {
    const { data: contact } = await sb
      .from('crm_contacts')
      .select('id')
      .eq('org_id', org_id)
      .ilike('email', entity_email.trim())
      .limit(1)
      .single();
    crm_contact_id = contact?.id ?? null;
  }

  const { data: inserted, error: insertError } = await sb
    .from('crm_external_events')
    .insert({
      org_id,
      source,
      event_type,
      entity_type: entity_type ?? null,
      entity_email: entity_email ?? null,
      entity_external_id: entity_external_id ?? null,
      payload: payload ?? {},
      crm_contact_id,
      processed: false,
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('Insert error:', insertError.message);
    return new Response(JSON.stringify({ error: 'Failed to store event' }), { status: 500 });
  }

  return new Response(JSON.stringify({
    success: true,
    event_id: inserted.id,
    crm_contact_resolved: crm_contact_id !== null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
