import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { enforceKillSwitchForCampaign, enforceOrgCancellationForCampaign } from "../_shared/security.ts";

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  // 1) Fetch ACTIVE campaigns
  const { data: campaigns, error: campErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("status", "running");

  if (campErr) {
    console.error("campaign_select_failed", campErr);
    return new Response("campaign_select_failed", { status: 500 });
  }

  if (!campaigns || campaigns.length === 0) {
    return new Response("No active campaigns", { status: 200 });
  }

  let totalScheduled = 0;
  let campaignsBlockedByKillSwitch = 0;
  let campaignsPausedByKillSwitchCheckFailure = 0;

  for (const camp of campaigns) {
    // 2.0) Cancellation gate — checked before kill-switch (org terminated = no execution ever)
    const cancGate = await enforceOrgCancellationForCampaign(supabase, camp.org_id);
    if (!cancGate.allow) {
      await supabase.from("campaigns").update({ status: "paused" }).eq("id", camp.id);
      console.log(`[campaign_ticker] ${cancGate.reason}. Pausing campaign ${camp.id} (org ${camp.org_id}).`);
      continue;
    }

    // 2.1) Unified kill-switch guard (org scoped)
    const gate = await enforceKillSwitchForCampaign(supabase, camp.org_id);

    if (!gate.allow) {
      // Fail-closed: PAUSE to avoid thrash
      await supabase.from("campaigns").update({ status: "paused" }).eq("id", camp.id);

      if (gate.enabled) campaignsBlockedByKillSwitch += 1;
      else campaignsPausedByKillSwitchCheckFailure += 1;

      console.log(`🛑 ${gate.reason}. Pausing campaign ${camp.id} (org ${camp.org_id}).`);
      continue;
    }

    // 2.A) Atomically claim leads
    const { data: batch, error: claimError } = await supabase.rpc("claim_campaign_leads", {
      p_campaign_id: camp.id,
      p_limit: camp.per_minute_cap,
    });

    if (claimError) {
      console.error("claim_campaign_leads_failed", { campaign_id: camp.id, error: claimError });
      continue;
    }

    // 2.B) Empty batch -> completion check
    if (!batch || batch.length === 0) {
      const { count, error: countErr } = await supabase
        .from("campaign_leads")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", camp.id)
        .eq("status", "pending");

      if (countErr) {
        console.error("campaign_pending_count_failed", { campaign_id: camp.id, error: countErr });
        continue;
      }

      if (count === 0) {
        await supabase.from("campaigns").update({ status: "completed" }).eq("id", camp.id);
      }
      continue;
    }

    // 2.C) Batch credit check
    const costPerLead = camp.channel === "voice" ? 5 : 1;
    const batchCost = batch.length * costPerLead;

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("ai_credits_balance")
      .eq("id", camp.org_id)
      .single();

    if (orgErr) {
      console.error("org_select_failed", { org_id: camp.org_id, error: orgErr });

      // release claimed leads back to pending
      const leadIds = batch.map((b: any) => b.lead_id);
      await supabase
        .from("campaign_leads")
        .update({ status: "pending" })
        .eq("campaign_id", camp.id)
        .in("lead_id", leadIds);

      continue;
    }

    if (!org || (org.ai_credits_balance || 0) < batchCost) {
      await supabase.from("campaigns").update({ status: "paused" }).eq("id", camp.id);

      const leadIds = batch.map((b: any) => b.lead_id);
      await supabase
        .from("campaign_leads")
        .update({ status: "pending" })
        .eq("campaign_id", camp.id)
        .in("lead_id", leadIds);

      continue;
    }

    // 2.D) Create execution tasks (requires plan_id + scheduled_for + max_attempts)
    const nowIso = new Date().toISOString();

    const missingPlan = batch.some((x: any) => !x.plan_id);
    if (missingPlan) {
      console.error("campaign_batch_missing_plan_id", { campaign_id: camp.id, sample: batch?.[0] });

      const leadIds = batch.map((b: any) => b.lead_id);
      await supabase
        .from("campaign_leads")
        .update({ status: "pending" })
        .eq("campaign_id", camp.id)
        .in("lead_id", leadIds);

      continue;
    }

    const tasks = batch.map((item: any) => ({
      plan_id: item.plan_id,
      org_id: camp.org_id,
      lead_id: item.lead_id,
      channel: camp.channel,
      status: "pending",
      scheduled_for: nowIso,
      max_attempts: 3,
      metadata: {
        campaign_id: camp.id,
        intent: camp.intent,
        source: "campaign_ticker",
      },
    }));

    const { error: insertError } = await supabase.from("execution_tasks").insert(tasks);

    if (insertError) {
      console.error("task_insert_failed", { campaign_id: camp.id, error: insertError });

      const leadIds = batch.map((b: any) => b.lead_id);
      await supabase
        .from("campaign_leads")
        .update({ status: "pending" })
        .eq("campaign_id", camp.id)
        .in("lead_id", leadIds);

      continue;
    }

    // Mark as scheduled
    const leadIds = batch.map((b: any) => b.lead_id);
    await supabase
      .from("campaign_leads")
      .update({ status: "scheduled" })
      .eq("campaign_id", camp.id)
      .in("lead_id", leadIds);

    totalScheduled += tasks.length;
  }

  return new Response(JSON.stringify({
    scheduled: totalScheduled,
    campaigns_blocked_by_killswitch: campaignsBlockedByKillSwitch,
    campaigns_paused_by_killswitch_check_failure: campaignsPausedByKillSwitchCheckFailure,
  }), { status: 200 });
});
