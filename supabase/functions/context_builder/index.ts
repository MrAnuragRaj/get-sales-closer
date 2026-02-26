import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

serve(async (req) => {
  const { lead_id, trigger } = await req.json();
  const supabase = getSupabaseClient(req);

  const { data: lead } = await supabase
    .from("leads")
    .select("*")
    .eq("id", lead_id)
    .single();

  const { data: entitlements } = await supabase
    .from("org_entitlements")
    .select("service_key, effective_from, effective_until")
    .eq("org_id", lead.org_id);

  // 🚧 Stubbed — real logic comes later
  const context = {
    lead_id,
    org_id: lead.org_id,
    trigger,
    allowed_channels: [],
    priority_level: "normal",
    legal_window: { can_execute_now: true },
    knowledge_mode: "generic"
  };

  return new Response(JSON.stringify(context), { status: 200 });
});
