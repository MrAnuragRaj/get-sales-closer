import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Recipient = {
  source: string;
  source_id: string;
  is_primary: boolean;
  timezone: string;
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
  email: string | null;
  phone_e164: string | null;
  whatsapp_e164: string | null;
};

function json(res: unknown, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return {};
    const body = await req.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function asBool(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes", "y"].includes(v.toLowerCase());
  if (typeof v === "number") return v === 1;
  return def;
}

function daysBetweenUTC(dueAtISO: string): number {
  const dueDate = new Date(dueAtISO);
  const today = new Date();
  const due = Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate());
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((now - due) / (24 * 3600 * 1000));
}

async function sendEmailResend(to: string, subject: string, text: string, html: string) {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM_EMAIL = "billing@getsalescloser.com";

  if (!RESEND_API_KEY) {
    throw new Error("MISSING_RESEND_CONFIG");
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      text,
      html,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`RESEND_FAILED: ${t}`);
  }

  const j = await resp.json().catch(() => ({}));
  return { provider: "resend", message_id: j?.id ?? null, to };
}

serve(async (req) => {
  // Optional: keep behavior POST-only (recommended)
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await readJsonBody(req);
  const force_resend = asBool(body.force_resend, false);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const DRY_RUN = (Deno.env.get("REMINDER_DRY_RUN") ?? "true").toLowerCase() === "true";

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // 1) Pull candidate invoices (issued + due_at present)
    const { data: invoices, error: invErr } = await supabase
      .from("invoices")
      .select("id, org_id, status, due_at, total, currency, invoice_number, metadata")
      .eq("status", "issued")
      .not("due_at", "is", null);

    if (invErr) throw invErr;

    const todayISO = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const processed: any[] = [];
    const meta = { today: todayISO, force_resend, dry_run: DRY_RUN };

    for (const inv of invoices ?? []) {
      const dueAt = inv.due_at as string;
      const overdueDays = daysBetweenUTC(dueAt);

      // Default policy: start reminders after X days overdue
      const enforcement = inv.metadata?.enforcement ?? {};
      const remindAfter = enforcement.remind_every_day_after_overdue_day ?? 3;
      if (overdueDays < remindAfter) continue;

      const memoRef =
        inv.metadata?.payment_instructions?.memo_reference ??
        inv.metadata?.memo_reference ??
        null;

      // 2) latest intent (optional)
      const { data: intentRow } = await supabase
        .from("billing_intents")
        .select("id")
        .eq("org_id", inv.org_id)
        .eq("invoice_number", inv.invoice_number)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const intentId = intentRow?.id ?? null;

      // 3) Resolve recipients, then keep PRIMARY ONLY
      const { data: rec, error: recErr } = await supabase.rpc("resolve_billing_recipients_v1", {
        p_org_id: inv.org_id,
      });
      if (recErr) throw recErr;

      const allRecipients: Recipient[] = rec ?? [];
      const primary = allRecipients.find((r) => r.is_primary) ?? allRecipients[0];

      if (!primary) {
        processed.push({ invoice_id: inv.id, skipped: true, reason: "no_recipients" });
        continue;
      }

      // Effective channels for PRIMARY ONLY:
      const effectiveChannels: string[] = [];
      if (primary.channels?.email && primary.email) effectiveChannels.push("email");

      if (effectiveChannels.length === 0) {
        processed.push({ invoice_id: inv.id, skipped: true, reason: "primary_has_no_channels" });
        continue;
      }

      // 4) Upsert reminder row for today (idempotent)
      const upsertPayload: any = {
        invoice_id: inv.id,
        org_id: inv.org_id,
        intent_id: intentId,
        reminder_date: todayISO,
        channels: effectiveChannels, // PRIMARY ONLY effective channels
        status: "pending",
        recipients: [primary], // keep column consistent with schema
      };

      const { data: reminderRow, error: upErr } = await supabase
        .from("invoice_reminders")
        .upsert(upsertPayload, {
          onConflict: "invoice_id,reminder_date",
          ignoreDuplicates: false,
        })
        .select("*")
        .single();

      if (upErr) throw upErr;

      // Normal idempotency: skip if already sent, unless force_resend=true
      if (reminderRow.status === "sent" && !force_resend) {
        processed.push({ invoice_id: inv.id, reminder_id: reminderRow.id, already_sent: true });
        continue;
      }

      // 5) Compose message
      const subject = `Invoice overdue: ${inv.invoice_number} (${inv.currency} ${inv.total})`;

      const text =
        `Invoice: ${inv.invoice_number}\n` +
        `Amount: ${inv.currency} ${inv.total}\n` +
        `Due: ${dueAt}\n` +
        (memoRef ? `MANDATORY Memo/Reference: ${memoRef}\n` : "") +
        `\nPlease remit payment and include the memo/reference exactly as shown.`;

      const html = `
        <div style="font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.5;">
          <p><strong>Invoice overdue</strong></p>
          <p><strong>Invoice:</strong> ${inv.invoice_number}<br/>
             <strong>Amount:</strong> ${inv.currency} ${inv.total}<br/>
             <strong>Due:</strong> ${dueAt}</p>
          ${memoRef ? `<p><strong>MANDATORY Memo/Reference:</strong> <code>${memoRef}</code></p>` : ""}
          <p>Please remit payment and include the memo/reference exactly as shown.</p>
          <hr/>
          <small>GetSalesCloser Billing</small>
        </div>
      `;

      const providerPayload: any = {
        reason: `overdue_${overdueDays}_days`,
        dry_run: DRY_RUN,
        generated_at: new Date().toISOString(),
        invoice_number: inv.invoice_number,
        memo_reference: memoRef,
        recipients: [primary],
        channels: effectiveChannels,
        results: {},
      };

      // 6) Compute attempt_no and insert attempt row (starting)
      const { count: attemptsCount, error: attemptsCountErr } = await supabase
        .from("invoice_reminder_attempts")
        .select("*", { count: "exact", head: true })
        .eq("reminder_id", reminderRow.id);

      if (attemptsCountErr) throw attemptsCountErr;

      const attempt_no = (attemptsCount ?? 0) + 1;

      const { data: attemptRow, error: attemptInsErr } = await supabase
        .from("invoice_reminder_attempts")
        .insert({
          org_id: inv.org_id,
          invoice_id: inv.id,
          reminder_id: reminderRow.id,
          channel: "email",
          provider: "resend",
          attempt_no,
          to_email: primary.email,
          subject,
          status: "starting",
          provider_response: { meta },
        })
        .select("id")
        .single();

      if (attemptInsErr) throw attemptInsErr;
      const attempt_id = attemptRow?.id ?? null;

      // 7) Send (Resend) or dry-run, then finalize attempt + reminder
      try {
        if (!DRY_RUN) {
          if (effectiveChannels.includes("email") && primary.email) {
            providerPayload.results.email = await sendEmailResend(primary.email, subject, text, html);
          }
        } else {
          providerPayload.results = { note: "DRY_RUN=true, no external calls executed." };
        }

        // Attempt -> sent
        if (attempt_id) {
          const { error: attUpdErr } = await supabase
            .from("invoice_reminder_attempts")
            .update({
              status: "sent",
              provider_message_id: providerPayload?.results?.email?.message_id ?? null,
              provider_response: { ...providerPayload, attempt_no, force_resend, meta },
              error: null,
            })
            .eq("id", attempt_id);
          if (attUpdErr) throw attUpdErr;
        }

        // Reminder -> sent (even if previously sent and force_resend=true)
        const { error: updErr } = await supabase
          .from("invoice_reminders")
          .update({
            status: "sent",
            provider_payload: { ...providerPayload, attempt_no, force_resend, meta },
            updated_at: new Date().toISOString(),
            recipients: [primary],
            channels: effectiveChannels,
          })
          .eq("id", reminderRow.id);

        if (updErr) throw updErr;

        processed.push({
          invoice_id: inv.id,
          reminder_id: reminderRow.id,
          status: "sent",
          sent_to: primary.email,
          attempt_no,
          force_resend,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // Attempt -> failed
        if (attempt_id) {
          await supabase
            .from("invoice_reminder_attempts")
            .update({
              status: "failed",
              provider_response: { error: msg, attempt_no, force_resend, meta },
              error: msg,
            })
            .eq("id", attempt_id);
        }

        // Reminder -> failed (keeps your current semantics)
        const { error: updFailErr } = await supabase
          .from("invoice_reminders")
          .update({
            status: "failed",
            provider_payload: { ...providerPayload, error: msg, attempt_no, force_resend, meta },
            updated_at: new Date().toISOString(),
          })
          .eq("id", reminderRow.id);

        if (updFailErr) throw updFailErr;

        processed.push({
          invoice_id: inv.id,
          reminder_id: reminderRow.id,
          status: "failed",
          attempt_no,
          force_resend,
          error: msg,
        });
      }
    }

    return json({ status: "ok", date: todayISO, processed_count: processed.length, processed, meta });
  } catch (e) {
    return json({ status: "error", error: String(e) }, 500);
  }
});
