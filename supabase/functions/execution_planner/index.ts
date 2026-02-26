import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { computeStrikeTime } from "../_shared/strike_time.ts";
import { getRetrySchedule } from "../_shared/retry_policy.ts";

serve(async (req) => {
  try {
    const { plan_id, actor_user_id } = await req.json();

    if (!plan_id) {
      return new Response("plan_id required", { status: 400 });
    }

    if (!actor_user_id) {
      return new Response("actor_user_id required", { status: 400 });
    }

    const supabase = getSupabaseClient(req);

    // 1️⃣ Fetch Decision Plan
    const { data: plan, error: planError } = await supabase
      .from("decision_plans")
      .select("*")
      .eq("id", plan_id)
      .single();

    if (planError || !plan) {
      return new Response("Plan not found", { status: 404 });
    }

    // 2️⃣ IDEMPOTENCY GUARD
    const { count } = await supabase
      .from("execution_tasks")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", plan.id);

    if (count && count > 0) {
      return new Response(
        JSON.stringify({
          skipped: true,
          reason: "execution_tasks_already_created",
          plan_id: plan.id,
        }),
        { status: 200 }
      );
    }

    // 3️⃣ Determine Lead Timezone (default for now)
    const leadTimezone = "America/New_York";

    // 4️⃣ Compute Strike Time
    const nowUtcIso = new Date().toISOString();
    const baseStrikeIso = computeStrikeTime(nowUtcIso, leadTimezone);
    const baseStrikeMs = new Date(baseStrikeIso).getTime();

    // 5️⃣ Expand Tasks
    let tasks: any[] = [];

    for (const step of plan.plan.steps) {
      const offsets = getRetrySchedule(step.channel);

      const stepTasks = offsets.map((offsetSeconds, index) => ({
        plan_id: plan.id,
        lead_id: plan.lead_id,
        org_id: plan.org_id,
        actor_user_id, // ✅ IMPORTANT
        channel: step.channel,
        attempt: index + 1,
        max_attempts: offsets.length,
        scheduled_for: new Date(
          baseStrikeMs + offsetSeconds * 1000
        ).toISOString(),
        status: "pending",
      }));

      tasks.push(...stepTasks);
    }

    // 6️⃣ Insert Tasks
    const { error: insertError } = await supabase
      .from("execution_tasks")
      .insert(tasks);

    if (insertError) {
      return new Response(
        JSON.stringify({ error: insertError.message }),
        { status: 500 }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        plan_id: plan.id,
        tasks_created: tasks.length,
        base_strike_time: baseStrikeIso,
      }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500 }
    );
  }
});
