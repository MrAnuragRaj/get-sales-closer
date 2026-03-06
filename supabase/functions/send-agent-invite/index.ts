import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { invited_email, org_id, role, invited_by_name, org_name } = await req.json();
    if (!invited_email || !org_id || !role) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Verify caller: accept service_role JWT (internal) or enterprise/agency admin JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");

    // Decode JWT payload to check role without secret verification
    let jwtRole: string | null = null;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      jwtRole = payload?.role ?? null;
    } catch { /* invalid token format */ }

    if (jwtRole !== "service_role") {
      const { data: { user }, error: authErr } = await sb.auth.getUser(token);
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: membership } = await sb
        .from("org_members")
        .select("role")
        .eq("user_id", user.id)
        .eq("org_id", org_id)
        .in("role", ["enterprise_admin", "agency_admin"])
        .maybeSingle();
      if (!membership) {
        return new Response(JSON.stringify({ error: "Forbidden: not an admin of this org" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const roleLabel = role === "enterprise_agent" ? "Sales Agent" : "Team Member";
    const inviterName = invited_by_name || "Your team admin";
    const teamName = org_name || "GetSalesCloser";
    const signupUrl = "https://www.getsalescloser.com/login.html";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
    <div style="background:#0f172a;padding:28px 32px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">GetSalesCloser</h1>
      <p style="color:#64748b;margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;">Team Invitation</p>
    </div>
    <div style="padding:32px;">
      <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 20px;">
        Hi there,
      </p>
      <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 24px;">
        <strong style="color:#0f172a;">${inviterName}</strong> has invited you to join
        <strong style="color:#0f172a;">${teamName}</strong> on GetSalesCloser as a
        <strong style="color:#0f172a;">${roleLabel}</strong>.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <p style="color:#64748b;font-size:13px;margin:0 0 4px;">You were invited as</p>
        <p style="color:#0f172a;font-size:16px;font-weight:700;margin:0;">${roleLabel} — ${teamName}</p>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 24px;">
        To accept this invitation, sign up or sign in using this email address
        (<strong>${invited_email}</strong>). Your access will be granted automatically.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${signupUrl}"
           style="background:#0f172a;color:#ffffff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;display:inline-block;">
          Accept Invitation &amp; Sign Up
        </a>
      </div>
      <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:20px 0 0;text-align:center;">
        If you weren't expecting this invitation, you can safely ignore this email.
      </p>
    </div>
    <div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">GetSalesCloser &nbsp;·&nbsp; Support@getsalescloser.com</p>
    </div>
  </div>
</body>
</html>`;

    const resendKey = Deno.env.get("RESEND_API_KEY")!;
    const fromEmail =
      "support@getsalescloser.com";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [invited_email],
        subject: `You've been invited to join ${teamName} on GetSalesCloser`,
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
      JSON.stringify({ success: true, email_sent_to: invited_email }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
