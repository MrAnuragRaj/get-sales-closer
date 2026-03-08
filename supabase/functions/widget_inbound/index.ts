import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient } from "../_shared/db.ts";
import { buildPersonaBlock, type PersonaSettings } from "../_shared/persona_builder.ts";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── Regex patterns ─────────────────────────────────────────────────────────────
// Phone: matches E.164 (+XX digits) or local formats (10–15 digits)
const PHONE_RE = /(\+\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4,}|\+\d{7,15}/;
// Email: standard email address
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
// Name trigger phrases — "I'm X", "my name is X", etc.
const NAME_TRIGGER_RE = /(?:i(?:'m| am)|my name(?:'s)? is|this is|call me|you can call me)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i;

// Words that should NEVER be treated as part of a person's name
const NAME_STOP = new Set([
  "and","or","but","yes","no","ok","okay","the","so","i","is","at","in","on",
  "to","for","a","an","from","with","my","your","their","our","its","this",
  "that","these","those","here","there","hi","hey","hello","thanks","thank",
  "sure","great","good","nice","please","yes","yeah","yep","nope","not","just",
  "fine","cool","got","noted","done","ready","right","wrong","true","false",
]);

/**
 * Extract a person's name from a user message.
 * Two strategies in priority order:
 *  1. Trigger phrase ("I'm X", "my name is X") — works anywhere in the message
 *  2. Context-aware bare name — only when the previous AI turn was asking for a name.
 *     Bare name = 1–3 words, letters only, none are stopwords.
 */
function extractName(
  text: string,
  history: Array<{ role: string; content: string }>,
): string | null {
  // Strategy 1: explicit trigger phrase
  const match = NAME_TRIGGER_RE.exec(text);
  if (match) {
    const rawWords = match[1].split(/\s+/);
    const filtered = rawWords.filter(w => w.length >= 2 && !NAME_STOP.has(w.toLowerCase()));
    if (filtered.length === 0) return null;
    const keep = (filtered.length >= 2 && /^[A-Z]/.test(filtered[1]))
      ? filtered.slice(0, 2)
      : [filtered[0]];
    return keep.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }

  // Strategy 2: bare name response — only when the AI just asked for a name
  const lastAI = [...history].reverse().find(m => m.role === "assistant");
  const aiAskedForName = lastAI &&
    /\b(name|call you|what(?:'s| is) your|may i (have|get)|introduce yourself)\b/i.test(lastAI.content) &&
    /\?/.test(lastAI.content);

  if (aiAskedForName) {
    const words = text.trim().split(/\s+/);
    if (words.length >= 1 && words.length <= 3 && !/\d/.test(text)) {
      const valid = words.filter(w => w.length >= 2 && /^[A-Za-z]+$/.test(w) && !NAME_STOP.has(w.toLowerCase()));
      if (valid.length > 0 && valid.length === words.length) {
        return valid.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      }
    }
  }

  return null;
}

// ── Country dial code lookup ───────────────────────────────────────────────────
const COUNTRY_DIAL: Record<string, string> = {
  "united states": "+1", "usa": "+1", "us": "+1", "america": "+1",
  "canada": "+1",
  "united kingdom": "+44", "uk": "+44", "england": "+44", "britain": "+44",
  "india": "+91",
  "australia": "+61",
  "new zealand": "+64",
  "germany": "+49",
  "france": "+33",
  "uae": "+971", "dubai": "+971", "united arab emirates": "+971",
  "singapore": "+65",
  "south africa": "+27",
  "nigeria": "+234",
  "kenya": "+254",
  "pakistan": "+92",
  "bangladesh": "+880",
  "philippines": "+63",
  "brazil": "+55",
  "mexico": "+52",
};

function detectDialCode(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [country, code] of Object.entries(COUNTRY_DIAL)) {
    if (lower.includes(country)) return code;
  }
  return null;
}

function normalizePhone(raw: string, detectedCode: string | null): string {
  const hadPlus = raw.trimStart().startsWith("+");
  const digits  = raw.replace(/[^\d]/g, "");
  if (hadPlus) return "+" + digits;
  if (detectedCode) return detectedCode.replace(/[^\d+]/g, "").replace(/^\+?/, "+") + digits;
  // US fallback for current primary market
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(req.url);
  const action = url.searchParams.get("action");

  const supabase  = getServiceSupabaseClient();
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";

  // ── GET /widget_inbound?action=meta&org_id=<id> ────────────────────────────
  // Lightweight: returns agent name + org name — NO AI call, used by widget on init
  if (req.method === "GET" && action === "meta") {
    const org_id = url.searchParams.get("org_id");
    if (!org_id) return new Response(JSON.stringify({ error: "org_id required" }), { status: 400, headers: CORS });

    const [{ data: settings }, { data: org }] = await Promise.all([
      supabase.from("org_settings").select("persona_name").eq("org_id", org_id).maybeSingle(),
      supabase.from("organizations").select("name").eq("id", org_id).maybeSingle(),
    ]);

    if (!org) return new Response(JSON.stringify({ error: "Invalid org_id" }), { status: 404, headers: CORS });

    return new Response(
      JSON.stringify({ agent_name: settings?.persona_name || "Alex", org_name: org.name || "" }),
      { status: 200, headers: CORS }
    );
  }

  // ── POST /widget_inbound — main chat handler ───────────────────────────────
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });

  // Payload size guard — reject before reading body
  const contentLen = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLen > 65536) { // 64 KB
    return new Response(JSON.stringify({ error: "payload_too_large" }), { status: 413, headers: CORS });
  }

  let body: { org_id?: string; session_id?: string; message?: string; history?: Array<{ role: string; content: string }> };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS }); }

  const { org_id, session_id, message } = body;
  // Cap history at 20 most recent turns; truncate any over-long content strings
  const history = (body.history ?? [])
    .slice(-20)
    .map(h => ({ role: String(h.role ?? "user").slice(0, 20), content: String(h.content ?? "").slice(0, 1000) }));

  if (!org_id || !session_id || !message?.trim())
    return new Response(JSON.stringify({ error: "org_id, session_id, and message are required" }), { status: 400, headers: CORS });
  if (message.length > 2000)
    return new Response(JSON.stringify({ error: "Message too long" }), { status: 422, headers: CORS });
  if (!openaiKey)
    return new Response(JSON.stringify({ error: "AI service unavailable" }), { status: 503, headers: CORS });

  // Validate org
  const { data: org } = await supabase.from("organizations").select("id, name").eq("id", org_id).maybeSingle();
  if (!org) return new Response(JSON.stringify({ error: "Invalid org_id" }), { status: 404, headers: CORS });

  // Fetch persona settings, custom prompt, and architect service status in parallel
  const [{ data: settings }, { data: promptRow }, { data: archSvc }] = await Promise.all([
    supabase.from("org_settings")
      .select("persona_name, tone_preset, bot_disclosure, conversion_objective, terminology_overrides, industry, cal_link")
      .eq("org_id", org_id)
      .maybeSingle(),
    supabase.from("active_org_prompts")
      .select("system_prompt")
      .eq("org_id", org_id)
      .eq("channel", "sms")
      .maybeSingle(),
    supabase.from("org_services")
      .select("status")
      .eq("org_id", org_id)
      .eq("service_key", "architect")
      .maybeSingle(),
  ]);

  const agentName        = settings?.persona_name || "Alex";
  const canScheduleOnline = !!(settings?.cal_link && archSvc?.status === "active");
  const personaBlock = settings
    ? buildPersonaBlock(settings as PersonaSettings)
    : `PERSONA: You are ${agentName}, a helpful AI assistant.\nTONE: Be clear, friendly, and professional.`;

  const contactGoal = canScheduleOnline
    ? `Your secondary mission is to naturally collect the visitor's Name and Phone Number so our team can follow up.`
    : `Your secondary mission is to collect the visitor's Name, Phone Number, AND Email Address. Since online scheduling is not yet available, we need their email to send a meeting invite once a time is arranged. Do NOT skip asking for email — it is required.`;

  const confirmMsg = canScheduleOnline
    ? `Once you have name and phone (with country confirmed), confirm: "Perfect, I have your details. A member of our team will be in touch shortly."`
    : `Once you have name, phone, AND email, confirm: "Perfect, I've got your contact details. Our team will reach out shortly to schedule a time and send you a meeting invite."`;

  const systemPrompt = [
    personaBlock,
    promptRow?.system_prompt ? `CUSTOM INSTRUCTIONS:\n${promptRow.system_prompt}` : null,
    `=== SITE LIAISON DIRECTIVE ===`,
    `You are the AI chat assistant on the company website. Be helpful and engaging.`,
    contactGoal,
    `Do NOT ask for all contact details in one message. Build rapport first, then collect each item naturally one at a time.`,
    `PHONE NUMBER: If the visitor shares a number that already starts with + (e.g. +916391055535, +14155551234), accept it as-is — DO NOT ask for country. Only ask "Which country are you based in?" when the number has NO country code at all (no leading +, just local digits like 6391055535 or 5551234). Never ask for country if a + prefix is already present.`,
    confirmMsg,
  ].filter(Boolean).join("\n\n");

  // Build messages — limit history to last 20 messages to control costs
  const trimmedHistory = history.slice(-20);
  const messages = [
    { role: "system", content: systemPrompt },
    ...trimmedHistory,
    { role: "user", content: message.trim() },
  ];

  // Call OpenAI gpt-4o-mini (fast + cost-effective for live chat)
  let reply = "I'm having a moment of trouble. Please try again shortly.";
  try {
    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 400, temperature: 0.7 }),
    });
    const oaData = await oaRes.json();
    reply = oaData.choices?.[0]?.message?.content?.trim() ?? reply;
  } catch (e) {
    console.error("OpenAI error:", e);
  }

  // ── Lead Capture ────────────────────────────────────────────────────────────
  // Scan all user-side messages (history + current) for contact info
  const userMessages = [
    ...trimmedHistory.filter(m => m.role === "user").map(m => m.content),
    message,
  ];
  const allUserText = userMessages.join(" ");

  let leadCaptured = false;
  let currentLeadId: string | null = null;
  const phoneMatch = PHONE_RE.exec(allUserText);

  if (phoneMatch) {
    const detectedCode    = detectDialCode(allUserText);
    const normalizedPhone = normalizePhone(phoneMatch[0], detectedCode);

    // Dedup on last 10 digits — catches same number stored with wrong country code earlier
    // Use .limit(1) (NOT .maybeSingle()) — avoids PGRST116 error if multiple rows exist
    const last10 = normalizedPhone.replace(/\D/g, "").slice(-10);

    const { data: existingLeads } = await supabase
      .from("leads").select("id, phone, email")
      .eq("org_id", org_id)
      .like("phone", `%${last10}`)
      .limit(1);

    const existingLead = existingLeads?.[0] ?? null;

    if (existingLead) {
      currentLeadId = existingLead.id;
      // Lead already exists — update phone if country code was just confirmed/corrected
      const updates: Record<string, string> = {};
      if (existingLead.phone !== normalizedPhone) updates.phone = normalizedPhone;

      // Also capture email if newly seen and not stored yet
      const emailMatch = EMAIL_RE.exec(allUserText);
      if (emailMatch && !existingLead.email) updates.email = emailMatch[0].toLowerCase();

      if (Object.keys(updates).length > 0) {
        await supabase.from("leads").update(updates).eq("id", existingLead.id);
        console.log(`[widget_inbound] Lead updated:`, updates);
      }

    } else {
      // New lead — extract name per-message (prevents cross-message contamination)
      // Build per-message history context for context-aware bare-name extraction.
      // For each user message at index i, the "history so far" is trimmedHistory up to that point.
      let capturedName: string | null = null;
      for (let i = 0; i < userMessages.length; i++) {
        const msgHistory = i === 0 ? [] : trimmedHistory.slice(0, i * 2); // approx: 2 turns per exchange
        capturedName = extractName(userMessages[i], msgHistory);
        if (capturedName) break;
      }
      // Final fallback: try with full trimmedHistory context (catches last message)
      if (!capturedName) capturedName = extractName(message, trimmedHistory);
      capturedName = capturedName ?? "Site Visitor";
      const emailMatch    = EMAIL_RE.exec(allUserText);
      const capturedEmail = emailMatch?.[0]?.toLowerCase() || null;

      // Resolve org owner/admin for required profile_id field
      const { data: adminRow } = await supabase
        .from("org_members").select("user_id")
        .eq("org_id", org_id).in("role", ["enterprise_admin", "agency_admin", "owner"])
        .limit(1).maybeSingle();

      const { data: soloRow } = adminRow ? { data: null } : await supabase
        .from("org_members").select("user_id")
        .eq("org_id", org_id).is("role", null)
        .limit(1).maybeSingle();

      const actorUserId = (adminRow ?? soloRow)?.user_id;

      if (actorUserId) {
        const insertPayload: Record<string, unknown> = {
          org_id,
          profile_id: actorUserId,
          name:   capturedName,
          phone:  normalizedPhone,
          status: "new",
          source: "site_liaison",
          notes:  `Captured via Site Liaison widget. Session: ${session_id}`,
        };
        if (capturedEmail) insertPayload.email = capturedEmail;

        const { data: newLead, error: leadErr } = await supabase
          .from("leads").insert(insertPayload).select("id").single();
        if (!leadErr && newLead) {
          currentLeadId = newLead.id;
          leadCaptured = true;
          console.log(`[widget_inbound] Lead captured: ${capturedName} / ${normalizedPhone}${capturedEmail ? " / " + capturedEmail : ""} for org ${org_id}`);
        } else if (leadErr) {
          console.error(`[widget_inbound] Lead insert error:`, leadErr.message);
        }
      }
    }
  }

  // ── Store conversation to interactions ────────────────────────────────────
  // Persists the chat exchange so the customer can review what the lead discussed.
  // Only stored once we have a lead_id (phone captured); earlier messages are
  // preserved via the history passed back from the frontend.
  if (currentLeadId) {
    await supabase.from("interactions").insert([
      {
        lead_id:   currentLeadId,
        org_id,
        type:      "site_liaison",
        direction: "inbound",
        content:   message.trim(),
        metadata:  { session_id, source: "widget" },
      },
      {
        lead_id:   currentLeadId,
        org_id,
        type:      "site_liaison",
        direction: "outbound",
        content:   reply,
        metadata:  { session_id, source: "widget", agent_name: agentName },
      },
    ]);
  }

  return new Response(
    JSON.stringify({ reply, agent_name: agentName, lead_captured: leadCaptured }),
    { status: 200, headers: CORS }
  );
});
