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

  const { data, error } = await supabase
    .from("decision_plans")
    .insert({
      lead_id: context.lead_id,
      org_id: context.org_id,
      trigger: context.trigger,
      plan
    })
    .select()
    .single();

  if (error) {
    return new Response(JSON.stringify(error), { status: 500 });
  }

  return new Response(JSON.stringify(data), { status: 200 });
});
