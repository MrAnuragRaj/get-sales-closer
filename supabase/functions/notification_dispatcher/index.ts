import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? Deno.env.get("RESEND_FROM")!;

serve(async (req) => {
  const supabase = getSupabaseClient(req);

  // 1. 🔒 ATOMIC CLAIM (Concurrency Safe)
  const { data: notifications, error } = await supabase.rpc('claim_pending_notifications', { p_limit: 10 });

  if (error) {
    console.error("Claim failed:", error);
    return new Response("Error claiming notifications", { status: 500 });
  }

  if (!notifications || notifications.length === 0) {
    return new Response("No pending notifications", { status: 200 });
  }

  // 2. PROCESS BATCH
  for (const note of notifications) {
    try {
      // Fetch Owner Email
      const { data: org } = await supabase.from("organizations").select("owner_email").eq("id", note.org_id).single();
      if (!org?.owner_email) throw new Error("Missing owner email");

      // Send via Resend
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: org.owner_email,
          subject: `Alert: ${note.type}`,
          html: `<h3>System Notification</h3><p><strong>Type:</strong> ${note.type}</p><p>${note.message || "No details."}</p><hr /><small>GetSalesCloser Automation</small>`
        })
      });

      if (!resp.ok) throw new Error(await resp.text());

      // Mark Sent
      await supabase.from("notifications").update({ delivery_status: "sent", delivered_at: new Date().toISOString() }).eq("id", note.id);

    } catch (err) {
      console.error(`Failed to send ${note.id}:`, err);
      // Retry Logic
      const newStatus = (note.attempts + 1) >= 3 ? "failed" : "pending";
      await supabase.from("notifications").update({ attempts: note.attempts + 1, delivery_status: newStatus }).eq("id", note.id);
    }
  }

  return new Response(`Processed ${notifications.length} notifications`, { status: 200 });
});