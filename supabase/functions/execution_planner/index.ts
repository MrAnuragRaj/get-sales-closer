import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";
import { computeStrikeTime, isWithinContactWindow } from "../_shared/strike_time.ts";
import { getRetrySchedule, getRetryScheduleHighPriority } from "../_shared/retry_policy.ts";

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

    // 3️⃣ Fetch lead priority — determines retry schedule compression
    const { data: lead } = await supabase
      .from("leads")
      .select("priority")
      .eq("id", plan.lead_id)
      .maybeSingle();
    const isHighPriority = lead?.priority === "high";

    // 4️⃣ Compute Strike Time
    // Both standard and high-priority leads respect the TCPA-compliant contact
    // window (Mon–Sat 08:00–19:59 in the lead's local timezone).  High-priority
    // leads are NOT exempted from this window — bypassing it would expose the
    // platform to TCPA liability (47 U.S.C. § 227).  If the current time is
    // inside the allowed window, computeStrikeTime returns now() immediately
    // for both lead types.  The priority advantage comes from (a) compressed
    // retry intervals and (b) queue ordering in fetch_due_tasks.
    const nowUtcIso = new Date().toISOString();
    const baseStrikeIso = computeStrikeTime(nowUtcIso, "America/New_York");
    const baseStrikeMs = new Date(baseStrikeIso).getTime();

    // 5️⃣ Off-hours human alert for high-priority leads
    // When a priority lead submits outside the contact window, the automated
    // task is queued for 8:01 AM.  However the lead may have explicitly asked
    // for an immediate callback — a human agent CAN call them right now because
    // TCPA's automated-dialer restrictions don't apply to manual calls.
    // We notify the closer immediately so they can choose to call manually.
    if (isHighPriority && !isWithinContactWindow(nowUtcIso, "America/New_York")) {
      try {
        // Fetch lead name + phone (may already be partially fetched above — re-use data)
        const { data: leadDetail } = await supabase
          .from("leads")
          .select("name, phone")
          .eq("id", plan.lead_id)
          .maybeSingle();

        // Find closer(s): admin/owner roles on this org
        const { data: members } = await supabase
          .from("org_members")
          .select("user_id")
          .eq("org_id", plan.org_id)
          .in("role", ["owner", "enterprise_admin", "agency_admin"]);

        const { data: soloMember } = await supabase
          .from("org_members")
          .select("user_id")
          .eq("org_id", plan.org_id)
          .is("role", null)
          .limit(1)
          .maybeSingle();

        const closerIds = [
          ...(members ?? []).map((m: any) => m.user_id),
          ...(soloMember ? [soloMember.user_id] : []),
        ].filter(Boolean);

        if (closerIds.length > 0) {
          const { data: closerProfiles } = await supabase
            .from("profiles")
            .select("id, full_name, phone, email")
            .in("id", closerIds);

          const TWILIO_SID   = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
          const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
          const TWILIO_FROM  = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
          const RESEND_KEY   = Deno.env.get("RESEND_API_KEY") ?? "";

          const leadName  = leadDetail?.name  ?? "A priority lead";
          const leadPhone = leadDetail?.phone ?? "—";
          const smsBody   = `GSC Priority Alert: ${leadName} (${leadPhone}) submitted outside business hours and may want an immediate callback. Call them manually if available — you're not restricted to contact-window rules for manual calls.`;

          for (const closer of (closerProfiles ?? [])) {
            if (closer.phone && TWILIO_SID) {
              const params = new URLSearchParams();
              params.append("To",   closer.phone);
              params.append("From", TWILIO_FROM);
              params.append("Body", smsBody);
              await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: params,
                }
              ).catch(() => {}); // best-effort — don't fail task creation on notify error
            } else if (closer.email && RESEND_KEY) {
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${RESEND_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: "support@getsalescloser.com",
                  to: [closer.email],
                  subject: `Priority Lead Alert: ${leadName} submitted outside business hours`,
                  html: `<p>Hi ${closer.full_name ?? "there"},</p>
<p><strong>${leadName}</strong> (${leadPhone}) submitted a form marked as Priority outside the automated contact window.</p>
<p>The AI outreach is queued for the next business-hours window (8 AM local time). However, since they initiated contact, <strong>you can call them manually right now</strong> — TCPA automated-dialer restrictions don't apply to human calls.</p>
<p style="font-size:12px;color:#888;">This alert was generated by GetSalesCloser Priority Intake Routing.</p>`,
                }),
              }).catch(() => {}); // best-effort
            }
          }
        }

        // In-app notification so it surfaces in the dashboard
        await supabase.from("notifications").insert({
          org_id:  plan.org_id,
          lead_id: plan.lead_id,
          type:    "priority_off_hours",
          message: `Priority lead ${leadDetail?.name ?? ""} submitted outside business hours. AI outreach queued for 8 AM. Consider a manual callback now.`,
        }).then(undefined, () => {}); // best-effort

      } catch (_alertErr) {
        // Never let notification failure block task creation
      }
    }

    // 7️⃣ Expand Tasks
    let tasks: any[] = [];

    for (const step of plan.plan.steps) {
      const offsets = isHighPriority
        ? getRetryScheduleHighPriority(step.channel)
        : getRetrySchedule(step.channel);

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

    // 8️⃣ Insert Tasks
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
