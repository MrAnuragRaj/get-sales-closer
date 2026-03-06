import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { intent_id, amount_paid } = await req.json();
    if (!intent_id || amount_paid === undefined || amount_paid === null) {
      return new Response(JSON.stringify({ error: "Missing intent_id or amount_paid" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service-role client — bypasses RLS, can read auth.users
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Verify caller is an admin via app_admins table
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user }, error: authErr } = await sb.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: adminRow } = await sb
      .from("app_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!adminRow) {
      return new Response(JSON.stringify({ error: "Forbidden: not an admin" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load billing intent — include intent_source to choose resolution path
    const { data: intent, error: intentErr } = await sb
      .from("billing_intents")
      .select("reference_id, org_id, intent_source, pricing_snapshot")
      .eq("id", intent_id)
      .single();
    if (intentErr || !intent) {
      return new Response(JSON.stringify({ error: "Intent not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Resolve customer email ──────────────────────────────────────────────
    // Admin deals: the owner email was entered by the admin at deal creation
    // and stored directly in pricing_snapshot. Use it without any user lookup.
    //
    // Regular deals (pricing / billing page checkout): the customer is a
    // registered user — look them up via members → org_members → auth.users.
    // ────────────────────────────────────────────────────────────────────────
    let customerEmail: string | null = null;

    if (intent.intent_source === "admin_deal") {
      customerEmail = (intent.pricing_snapshot as any)?.owner_email ?? null;
    } else {
      // Try members table (legacy solo checkout)
      const { data: mRow } = await sb
        .from("members")
        .select("user_id")
        .eq("org_id", intent.org_id)
        .limit(1)
        .maybeSingle();
      if (mRow?.user_id) {
        const { data: u } = await sb.auth.admin.getUserById(mRow.user_id);
        customerEmail = u?.user?.email ?? null;
      }

      // Try org_members table (multi-tenant)
      if (!customerEmail) {
        const { data: omRow } = await sb
          .from("org_members")
          .select("user_id")
          .eq("org_id", intent.org_id)
          .limit(1)
          .maybeSingle();
        if (omRow?.user_id) {
          const { data: u } = await sb.auth.admin.getUserById(omRow.user_id);
          customerEmail = u?.user?.email ?? null;
        }
      }
    }

    if (!customerEmail) {
      return new Response(
        JSON.stringify({ error: "Could not resolve customer email for this intent" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Calculate amounts
    const totalDue = Number((intent.pricing_snapshot as any)?.final_invoice_amount ?? 0);
    const paid = Number(amount_paid);
    const due = Math.max(0, Math.round((totalDue - paid) * 100) / 100);

    const fmt = (n: number) =>
      n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ref = intent.reference_id;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08);">
    <div style="background:#0f172a;padding:28px 32px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">GetSalesCloser</h1>
      <p style="color:#64748b;margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:2px;">Payment Update</p>
    </div>
    <div style="padding:32px;">
      <p style="color:#334155;font-size:15px;line-height:1.7;margin:0 0 20px;">
        We have received your bank transfer for reference <strong style="color:#0f172a;">${ref}</strong>. Below is a summary of your payment status.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;overflow:hidden;margin-bottom:24px;">
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:12px 16px;color:#64748b;font-size:14px;">Invoice Total</td>
          <td style="padding:12px 16px;text-align:right;font-weight:700;color:#0f172a;font-size:15px;">$${fmt(totalDue)}</td>
        </tr>
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:12px 16px;color:#64748b;font-size:14px;">Amount Received</td>
          <td style="padding:12px 16px;text-align:right;font-weight:700;color:#16a34a;font-size:15px;">$${fmt(paid)}</td>
        </tr>
        <tr style="background:#fef2f2;">
          <td style="padding:14px 16px;color:#dc2626;font-size:14px;font-weight:700;">Balance Due</td>
          <td style="padding:14px 16px;text-align:right;font-weight:800;color:#dc2626;font-size:18px;">$${fmt(due)}</td>
        </tr>
      </table>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:24px;">
        <p style="color:#b91c1c;margin:0;font-size:14px;font-weight:700;">⚠️ Action Required</p>
        <p style="color:#7f1d1d;margin:8px 0 0;font-size:14px;line-height:1.6;">
          Please transfer the remaining <strong>$${fmt(due)}</strong> at your earliest convenience using the same reference ID: <strong>${ref}</strong>. Your subscription will be activated only after full payment is confirmed.
        </p>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px;">
        If you believe there is a discrepancy in these figures, please contact our support team with your transaction receipts and the reference ID above.
      </p>
      <div style="text-align:center;margin:24px 0;">
        <a href="mailto:Support@getsalescloser.com?subject=Payment%20Discrepancy%20-%20${ref}"
           style="background:#0f172a;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;display:inline-block;">
          Contact Support
        </a>
      </div>
    </div>
    <div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">GetSalesCloser &nbsp;·&nbsp; Support@getsalescloser.com</p>
      <p style="color:#cbd5e1;font-size:11px;margin:6px 0 0;">Please do not reply to this email — use the button above to reach support.</p>
    </div>
  </div>
</body>
</html>`;

    const resendKey = Deno.env.get("RESEND_API_KEY")!;
    const fromEmail =
      "billing@getsalescloser.com";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [customerEmail],
        subject: `Payment Update — $${fmt(due)} remaining · Ref: ${ref}`,
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
      JSON.stringify({ success: true, email_sent_to: customerEmail, amount_paid: paid, amount_due: due }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
