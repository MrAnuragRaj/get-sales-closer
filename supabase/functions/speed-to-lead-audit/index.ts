import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Fixed org for anurag@getsalescloser.com — all audit leads go here
const AUDIT_ORG_ID     = '96a98f50-35a1-4f8f-91ad-1280d5121b69';
const AUDIT_PROFILE_ID = '086f2f04-4d65-40a2-a371-99f62ba272bf';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY')!;
const OPENAI_API_KEY   = Deno.env.get('OPENAI_API_KEY')!;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    let body: { name?: string; email?: string; phone?: string; website?: string; industry?: string; marketing_consent?: boolean };
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const { name, email, phone, website, industry, marketing_consent } = body;
    if (!name || !email || !website) return json({ error: 'name, email, and website are required' }, 422);

    // ── 1. Create lead in AUDIT_ORG ──────────────────────────────────────────
    const { data: lead, error: leadErr } = await sb
        .from('leads')
        .insert({
            org_id:     AUDIT_ORG_ID,
            profile_id: AUDIT_PROFILE_ID,
            name:       name,
            email:      email,
            phone:      phone || null,
            source:     'speed_to_lead_audit',
            status:     'new',
        })
        .select('id')
        .single();

    if (leadErr) {
        console.error('lead insert error:', leadErr);
        return json({ error: 'Failed to create lead record' }, 500);
    }

    // ── 2. Scrape website for contact forms ──────────────────────────────────
    let formFound   = false;
    let formSubmitted = false;
    let scrapedHtml = '';

    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const siteRes = await fetch(website, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'GetSalesCloser-AuditBot/1.0' },
        });
        clearTimeout(timer);
        if (siteRes.ok) {
            scrapedHtml = await siteRes.text();
            // Detect forms with contact/callback patterns
            formFound = /<form[\s\S]*?(?:contact|callback|enquiry|inquiry|get.in.touch|request|free.quote|consultation)/i.test(scrapedHtml);
        }
    } catch (e) {
        console.warn('website fetch failed:', e);
    }

    // ── 3. Attempt form submission if found ──────────────────────────────────
    if (formFound) {
        try {
            // Extract action URL from first matching form
            const actionMatch = scrapedHtml.match(/<form[^>]+action=["']([^"']+)["']/i);
            const formAction  = actionMatch ? new URL(actionMatch[1], website).href : website;

            const testPayload = new URLSearchParams({
                name:    'GetSalesCloser Audit Bot',
                email:   `audit+${lead.id}@getsalescloser.com`,
                phone:   '+10000000000',
                message: 'This is an automated speed-to-lead audit test from GetSalesCloser. Please ignore.',
            });

            const ctrl2 = new AbortController();
            const timer2 = setTimeout(() => ctrl2.abort(), 8000);
            const submitRes = await fetch(formAction, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    testPayload.toString(),
                signal:  ctrl2.signal,
            });
            clearTimeout(timer2);
            formSubmitted = submitRes.status < 500;
        } catch (e) {
            console.warn('form submission failed:', e);
        }
    }

    // ── 4. Generate AI report immediately (MVP) ───────────────────────────────
    const report = await generateAuditReport({
        name, email, website, industry: industry || 'Unknown',
        formFound, formSubmitted, scrapedHtml: scrapedHtml.slice(0, 4000),
    });

    // ── 5. Create audit_requests row ─────────────────────────────────────────
    const { error: arErr } = await sb.from('audit_requests').insert({
        lead_id:          lead.id,
        org_id:           AUDIT_ORG_ID,
        prospect_name:    name,
        prospect_email:   email,
        prospect_phone:   phone || null,
        website_url:      website,
        industry:         industry || null,
        form_found:       formFound,
        form_submitted:   formSubmitted,
        report_sent:      true,
        report_sent_at:   new Date().toISOString(),
        marketing_consent: marketing_consent || false,
    });
    if (arErr) console.error('audit_requests insert error:', arErr);

    // ── 6. Send acknowledgment + report email to prospect via Resend ──────────
    await sendReportEmail({ name, email, website, report });

    return json({ ok: true });
});

// ── AI Report Generation ─────────────────────────────────────────────────────
async function generateAuditReport(ctx: {
    name: string; email: string; website: string; industry: string;
    formFound: boolean; formSubmitted: boolean; scrapedHtml: string;
}): Promise<string> {
    const systemPrompt = `You are an expert B2B sales infrastructure analyst.
Your job is to produce a concise Speed-to-Lead Audit Report for a business's website.
Write in a direct, professional tone — no fluff, no emoji, no asterisks.
Structure the report with plain section headers.`;

    const userPrompt = `Audit request for: ${ctx.website}
Industry: ${ctx.industry}
Contact form detected on site: ${ctx.formFound ? 'Yes' : 'No'}
Test submission attempted: ${ctx.formSubmitted ? 'Yes' : 'No'}

Page content sample (first 4000 chars):
${ctx.scrapedHtml || '(could not fetch page content)'}

Generate a Speed-to-Lead Audit Report covering:
1. CONTACT ACCESSIBILITY SCORE — how easy is it for a visitor to reach the business? (0–10 with reasoning)
2. FORM & LEAD CAPTURE ASSESSMENT — quality of contact forms found, friction points, missing elements
3. SPEED-TO-LEAD RISK ANALYSIS — based on what you can observe, estimate the likely response gap and its revenue impact at typical ${ctx.industry} deal sizes
4. TOP 3 IMMEDIATE FIXES — specific, actionable changes to improve lead capture within 48 hours
5. GETSCLOSER FIT — one paragraph on how GetSalesCloser would address the gaps identified

Keep total length under 600 words. Be specific to this site.`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt },
                ],
                max_tokens: 900,
                temperature: 0.4,
            }),
        });
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || 'Report generation unavailable.';
    } catch (e) {
        console.error('OpenAI error:', e);
        return 'Report generation unavailable.';
    }
}

// ── Send Report Email via Resend ─────────────────────────────────────────────
async function sendReportEmail(ctx: { name: string; email: string; website: string; report: string }) {
    const htmlReport = ctx.report
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
            if (/^\d+\./.test(line) || /^[A-Z &]{4,}$/.test(line)) {
                return `<h3 style="color:#00D1FF;font-family:sans-serif;font-size:13px;margin:20px 0 6px;letter-spacing:0.05em;text-transform:uppercase">${line}</h3>`;
            }
            return `<p style="color:#cbd5e1;font-family:sans-serif;font-size:14px;line-height:1.6;margin:0 0 10px">${line}</p>`;
        })
        .join('');

    const html = `
<!DOCTYPE html>
<html>
<body style="background:#020617;padding:40px 0;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#0a192f;border:1px solid rgba(0,209,255,0.15);border-radius:16px;padding:40px">
    <div style="margin-bottom:32px">
      <p style="color:#00D1FF;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin:0 0 8px">GetSalesCloser</p>
      <h1 style="color:#fff;font-family:sans-serif;font-size:24px;font-weight:800;margin:0 0 8px">Your Speed-to-Lead Audit Report</h1>
      <p style="color:#64748b;font-family:sans-serif;font-size:13px;margin:0">Site audited: <span style="color:#94a3b8">${ctx.website}</span></p>
    </div>
    <div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:24px;margin-bottom:32px">
      ${htmlReport}
    </div>
    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px">
      <p style="color:#475569;font-family:sans-serif;font-size:12px;margin:0 0 16px">Ready to eliminate your speed-to-lead gap permanently?</p>
      <a href="https://www.getsalescloser.com" style="display:inline-block;background:linear-gradient(135deg,#00D1FF,#2563eb);color:#fff;font-family:sans-serif;font-size:13px;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;text-transform:uppercase;letter-spacing:0.05em">Get Started with GetSalesCloser</a>
    </div>
    <p style="color:#1e293b;font-family:sans-serif;font-size:11px;margin:24px 0 0">This report was generated automatically by GetSalesCloser AI analysis. Results are indicative and based on publicly available site content.</p>
  </div>
</body>
</html>`;

    try {
        await fetch('https://api.resend.com/emails', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:    'GetSalesCloser <support@getsalescloser.com>',
                to:      [ctx.email],
                subject: `Your Speed-to-Lead Audit — ${new URL(ctx.website).hostname}`,
                html:    html,
            }),
        });
    } catch (e) {
        console.error('Resend error:', e);
    }
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}
