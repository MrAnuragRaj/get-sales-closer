import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { name, email } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: "Missing email" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify caller is authenticated
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user }, error: authErr } = await sb.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const recipientName = name || "there";
    const dashboardUrl = "https://www.getsalescloser.com/dashboard.html";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#1d4ed8,#7c3aed);padding:32px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Welcome to GetSalesCloser</h1>
      <p style="color:#bfdbfe;margin:8px 0 0;font-size:14px;">Your AI sales team is ready to close deals 24/7</p>
    </div>
    <div style="padding:32px;">
      <p style="color:#334155;font-size:16px;line-height:1.7;margin:0 0 20px;">
        Hi <strong style="color:#0f172a;">${recipientName}</strong>,
      </p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 24px;">
        You're all set! Your AI closer is now configured and ready to engage leads, book appointments, and follow up — all on autopilot.
      </p>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="color:#0f172a;font-size:14px;font-weight:700;margin:0 0 12px;">Here's what to do next:</p>
        <ul style="color:#475569;font-size:14px;line-height:1.8;margin:0;padding-left:20px;">
          <li>Add your first lead and watch your AI closer engage them</li>
          <li>Set up your AI persona under <strong>Settings</strong></li>
          <li>Connect your channels (SMS, Email, Voice) from the dashboard</li>
          <li>Share your Smart Link to capture leads from your website</li>
        </ul>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${dashboardUrl}"
           style="background:#1d4ed8;color:#ffffff;padding:14px 36px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;display:inline-block;">
          Open My Dashboard &rarr;
        </a>
      </div>

      <p style="color:#64748b;font-size:13px;line-height:1.6;margin:20px 0 0;">
        Questions? Reply to this email or reach us at <a href="mailto:Support@getsalescloser.com" style="color:#1d4ed8;">Support@getsalescloser.com</a> — we typically respond within a few hours.
      </p>
    </div>
    <div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">GetSalesCloser &nbsp;·&nbsp; <a href="https://www.getsalescloser.com" style="color:#6b7280;">getsalescloser.com</a></p>
    </div>
  </div>
</body>
</html>`;

    const resendKey = Deno.env.get("RESEND_API_KEY")!;
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "hello@getsalescloser.com",
        to: [email],
        subject: `Welcome to GetSalesCloser, ${recipientName}! 🎉`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const resendErr = await resendRes.text();
      return new Response(
        JSON.stringify({ error: "Email send failed", detail: resendErr }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, email_sent_to: email }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
