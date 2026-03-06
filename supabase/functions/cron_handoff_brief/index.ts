import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = "support@getsalescloser.com";
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER")!;

// Appointments with meetings starting in the next 5–10 minutes
const WINDOW_MIN = 5;
const WINDOW_MAX = 10;

serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const now = new Date();
  const windowStart = new Date(now.getTime() + WINDOW_MIN * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + WINDOW_MAX * 60 * 1000).toISOString();

  // Fetch upcoming appointments in window
  const { data: appointments, error: apptErr } = await sb
    .from("appointments")
    .select("id, lead_id, scheduled_at, notes")
    .gte("scheduled_at", windowStart)
    .lte("scheduled_at", windowEnd)
    .eq("status", "scheduled");

  if (apptErr) {
    console.error("[handoff_brief] appt query failed:", apptErr.message);
    return new Response("DB error", { status: 500 });
  }

  if (!appointments || appointments.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { status: 200 });
  }

  let sent = 0;
  const errors: string[] = [];

  for (const appt of appointments) {
    try {
      // Get lead info + org
      const { data: lead } = await sb
        .from("leads")
        .select("id, name, phone, email, org_id, source, notes")
        .eq("id", appt.lead_id)
        .single();

      if (!lead) continue;

      // Get org owner/admin profile (for SMS/email closer)
      const { data: members } = await sb
        .from("org_members")
        .select("user_id, role")
        .eq("org_id", lead.org_id)
        .in("role", ["owner", "enterprise_admin", "agency_admin"]);

      // Also look for solo owner (role IS NULL + org owner)
      const { data: org } = await sb
        .from("organizations")
        .select("owner_id, name")
        .eq("id", lead.org_id)
        .single();

      const closerIds: string[] = [];
      if (org?.owner_id) closerIds.push(org.owner_id);
      if (members) {
        for (const m of members) {
          if (!closerIds.includes(m.user_id)) closerIds.push(m.user_id);
        }
      }

      if (closerIds.length === 0) continue;

      // Get closer profiles (phone + email)
      const { data: closerProfiles } = await sb
        .from("profiles")
        .select("id, full_name, phone, email")
        .in("id", closerIds);

      if (!closerProfiles || closerProfiles.length === 0) continue;

      // Get last 5 interactions for this lead (for AI brief)
      const { data: interactions } = await sb
        .from("interactions")
        .select("channel, direction, content, created_at")
        .eq("lead_id", appt.lead_id)
        .order("created_at", { ascending: false })
        .limit(5);

      const transcript = interactions
        ?.map((i) => `[${i.direction === "inbound" ? "LEAD" : "AI"}]: ${i.content}`)
        .reverse()
        .join("\n") ?? "(no prior conversation)";

      // Generate brief via GPT-4o-mini
      const meetingTime = new Date(appt.scheduled_at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      });

      const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 150,
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "You are a sales intelligence assistant. Write a 2-3 sentence pre-meeting brief for the closer. Be concise and actionable. Focus on: lead's name, what they want, their main concern/objection from the conversation (if any), and one suggested opening angle.",
            },
            {
              role: "user",
              content: `Lead: ${lead.name} | Source: ${lead.source ?? "unknown"}\nMeeting in ${WINDOW_MIN} minutes at ${meetingTime} UTC\n\nRecent conversation:\n${transcript}`,
            },
          ],
        }),
      });

      let brief = `You have a meeting with ${lead.name} in ${WINDOW_MIN} minutes.`;
      if (aiResp.ok) {
        const aiJson = await aiResp.json();
        brief = aiJson.choices?.[0]?.message?.content?.trim() ?? brief;
      }

      const smsText = `GSC Alert: Meeting in ${WINDOW_MIN}min\n${lead.name} (${lead.phone ?? "no phone"})\n${brief}`;

      // Send to each closer — SMS if phone set, else email
      for (const closer of closerProfiles) {
        if (closer.phone) {
          // Send SMS via Twilio
          const authHeader = `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`;
          const params = new URLSearchParams();
          params.append("To", closer.phone);
          params.append("From", TWILIO_FROM);
          params.append("Body", smsText);

          const twilioResp = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
            {
              method: "POST",
              headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
              body: params,
            },
          );
          if (!twilioResp.ok) {
            const errTxt = await twilioResp.text();
            console.error(`[handoff_brief] Twilio failed for ${closer.id}: ${errTxt}`);
          }
        } else if (closer.email) {
          // Email fallback via Resend
          const html = `
            <p>Hi ${closer.full_name ?? "there"},</p>
            <p><strong>You have a meeting with ${lead.name} in ${WINDOW_MIN} minutes (${meetingTime} UTC).</strong></p>
            <p>${brief}</p>
            <hr>
            <p style="font-size:12px;color:#888;">Lead contact: ${lead.phone ?? "no phone"} | ${lead.email ?? "no email"}</p>
          `;

          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: RESEND_FROM,
              to: [closer.email],
              subject: `Meeting Alert: ${lead.name} in ${WINDOW_MIN} min`,
              html,
            }),
          });
        }
      }

      sent++;
    } catch (err) {
      console.error(`[handoff_brief] error for appt ${appt.id}:`, err);
      errors.push(String(err));
    }
  }

  return new Response(JSON.stringify({ processed: appointments.length, sent, errors }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
