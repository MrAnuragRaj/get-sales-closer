// crm_emitter.ts — Fire-and-forget CRM event queue writer.
// Called from any GSC edge function after a significant customer action.
// NEVER throws — CRM sync must not block primary GSC execution.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type CrmEventType =
  | "lead_created"
  | "lead_contacted"
  | "lead_replied"
  | "meeting_booked"
  | "customer_converted"
  | "deal_won"
  | "deal_lost"
  | "customer_updated";

export type CrmEntityType = "lead" | "contact" | "deal" | "customer" | "activity";

// Canonical payload — include everything available; adapter decides what to use.
// All fields optional — emit as much as you have.
export interface CrmEventPayload {
  // Identity
  name?:                    string | null;
  email?:                   string | null;
  phone?:                   string | null;
  company?:                 string | null;
  source?:                  string | null;
  // Lifecycle
  lifecycle_stage?:         string | null; // new | contacted | replied | booked | converted | won | lost
  relationship_status?:     string | null;
  last_interaction_at?:     string | null;
  conversion_source?:       string | null;
  customer_value?:          number | null;
  // Activity context
  channel?:                 string | null; // sms | email | voice | whatsapp | messenger
  message_preview?:         string | null;
  meeting_at?:              string | null;
  // Deal
  deal_value?:              number | null;
  deal_stage?:              string | null;
  // Future native CRM fields (lock data contracts now)
  recommended_next_action?: string | null;
  important_dates?:         Record<string, string> | null;
  preferences?:             Record<string, unknown> | null;
  // Passthrough
  [key: string]: unknown;
}

export async function emitCrmEvent(
  sb: SupabaseClient,
  opts: {
    orgId:          string;
    sourceSystem:   "gsc" | "lge";
    eventType:      CrmEventType;
    entityType:     CrmEntityType;
    entityId:       string;
    payload:        CrmEventPayload;
    idempotencyKey: string; // caller provides a stable, collision-resistant key
  },
): Promise<void> {
  try {
    await sb.from("crm_sync_events").insert({
      org_id:          opts.orgId,
      source_system:   opts.sourceSystem,
      event_type:      opts.eventType,
      entity_type:     opts.entityType,
      entity_id:       opts.entityId,
      payload_json:    opts.payload,
      idempotency_key: opts.idempotencyKey,
      status:          "pending",
    });
  } catch {
    // Intentionally swallowed — CRM sync is background-only.
  }
}
