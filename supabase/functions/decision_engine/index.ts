import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

serve(async (req) => {
  const context = await req.json();
  const supabase = getSupabaseClient(req);

  // 🚧 Placeholder decision logic
  const plan = {
    steps: [
      { channel: "sms", intent: "initial_contact" }
    ]
  };

  // DB-level idempotency: attempt INSERT first.
  // The UNIQUE constraint on (lead_id, trigger) is the authoritative race guard —
  // two concurrent webhooks hitting this simultaneously will both try to INSERT;
  // one will succeed and the other will get 23505. No window exists where both pass.
  const { data: inserted, error: insertErr } = await supabase
    .from("decision_plans")
    .insert({
      lead_id: context.lead_id,
      org_id: context.org_id,
      trigger: context.trigger,
      plan,
    })
    .select()
    .maybeSingle();

  // 23505 = unique_violation — a concurrent request already inserted this plan.
  // Fetch and return the existing row so the caller gets the correct plan_id.
  if (insertErr?.code === "23505") {
    const { data: existing, error: fetchErr } = await supabase
      .from("decision_plans")
      .select("*")
      .eq("lead_id", context.lead_id)
      .eq("trigger", context.trigger)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (fetchErr || !existing) {
      // Race: the winner may have been deleted between our conflict and this fetch.
      // Return 500 so the caller retries — safe because the insert will succeed next time.
      return new Response(
        JSON.stringify({ error: "conflict_fetch_failed", detail: fetchErr?.message }),
        { status: 500 }
      );
    }

    return new Response(JSON.stringify(existing), { status: 200 });
  }

  if (insertErr) {
    return new Response(JSON.stringify(insertErr), { status: 500 });
  }

  return new Response(JSON.stringify(inserted), { status: 200 });
});
