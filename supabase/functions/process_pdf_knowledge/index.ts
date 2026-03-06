import { serve } from "https://deno.land/std/http/server.ts";
import { getServiceSupabaseClient, getSupabaseClient } from "../_shared/db.ts";

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // 1. Auth — verify the user's JWT and get their org_id
  const userSb = getSupabaseClient(req);
  const { data: { user }, error: authError } = await userSb.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const { knowledge_base_id } = await req.json();
  if (!knowledge_base_id) {
    return new Response(JSON.stringify({ error: "knowledge_base_id required" }), { status: 400, headers: CORS });
  }

  // Use service client for all DB + storage operations
  const sb = getServiceSupabaseClient();

  // 2. Fetch the knowledge_base entry — verify it belongs to the user's org
  const { data: membership } = await sb
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership?.org_id) {
    return new Response(JSON.stringify({ error: "No org membership found" }), { status: 403, headers: CORS });
  }

  const { data: entry, error: entryError } = await sb
    .from("knowledge_base")
    .select("id, file_url, title, type, org_id")
    .eq("id", knowledge_base_id)
    .eq("org_id", membership.org_id)
    .eq("type", "pdf")
    .maybeSingle();

  if (entryError || !entry || !entry.file_url) {
    return new Response(JSON.stringify({ error: "PDF entry not found or access denied" }), { status: 404, headers: CORS });
  }

  // 3. Mark as processing
  await sb.from("knowledge_base").update({ content_text: "__processing__" }).eq("id", knowledge_base_id);

  // 4. Download PDF from storage
  const { data: fileData, error: storageError } = await sb.storage
    .from("documents")
    .download(entry.file_url);

  if (storageError || !fileData) {
    console.error("Storage download error:", storageError);
    await sb.from("knowledge_base").update({ content_text: null }).eq("id", knowledge_base_id);
    return new Response(JSON.stringify({ error: "Failed to download PDF from storage" }), { status: 500, headers: CORS });
  }

  // 5. Extract text from PDF using pdf-parse (no native deps, pure JS)
  let extractedText = "";
  try {
    const buffer = await fileData.arrayBuffer();
    const uint8 = new Uint8Array(buffer);

    // Use pdfjs-dist legacy build — pure JS, no worker needed in edge runtime
    const pdfjsLib = await import("npm:pdfjs-dist@4.4.168/legacy/build/pdf.mjs");
    // Disable worker — not available in Deno edge environment
    pdfjsLib.GlobalWorkerOptions.workerSrc = "";

    const pdfDoc = await pdfjsLib.getDocument({
      data: uint8,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    const maxPages = Math.min(pdfDoc.numPages, 30); // cap at 30 pages
    const pageParts: string[] = [];

    for (let i = 1; i <= maxPages; i++) {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pageParts.push(text);
    }

    extractedText = pageParts.join("\n\n");
    console.log(`Extracted ${extractedText.length} chars from ${maxPages} pages of "${entry.title}"`);
  } catch (err) {
    console.error("PDF extraction failed:", err);
    await sb.from("knowledge_base")
      .update({ content_text: "[PDF could not be processed automatically — this appears to be a scanned image PDF. Please add key information as a text rule instead.]" })
      .eq("id", knowledge_base_id);
    return new Response(JSON.stringify({ ok: false, note: "extraction_failed" }), { headers: CORS });
  }

  // Handle scanned PDFs (no extractable text)
  if (!extractedText.trim()) {
    await sb.from("knowledge_base")
      .update({ content_text: "[Scanned image PDF — text cannot be extracted automatically. Please add key information as a text rule instead.]" })
      .eq("id", knowledge_base_id);
    return new Response(JSON.stringify({ ok: false, note: "scanned_pdf" }), { headers: CORS });
  }

  // 6. Summarize with GPT-4o-mini
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_KEY) {
    await sb.from("knowledge_base").update({ content_text: null }).eq("id", knowledge_base_id);
    return new Response(JSON.stringify({ error: "AI summarization not configured" }), { status: 500, headers: CORS });
  }

  // Truncate to ~10k chars to stay within token budget (leaves room for system prompt + response)
  const truncated = extractedText.length > 10000 ? extractedText.slice(0, 10000) + "\n\n[Document truncated — first 10,000 characters processed]" : extractedText;

  let summary = "";
  try {
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content: `You are a business document analyst. Extract and summarize key information from the document that will be used to train a sales AI assistant. Focus on:
- Products or services offered and their details
- Pricing, packages, or tiers
- Key policies, rules, or terms
- Unique value propositions or differentiators
- Anything a salesperson must know when handling leads

Output a structured, bullet-point summary. Be comprehensive but concise. Avoid filler text.`,
          },
          {
            role: "user",
            content: `Document: "${entry.title}"\n\n---\n\n${truncated}\n\n---\n\nProvide a comprehensive summary for the sales AI.`,
          },
        ],
      }),
    });

    const aiJson = await aiResp.json();
    if (aiJson.error) throw new Error(aiJson.error.message);
    summary = aiJson.choices[0].message.content.trim();
    console.log(`AI summary generated for "${entry.title}" (${summary.length} chars)`);
  } catch (err) {
    console.error("GPT summarization failed:", err);
    // Store raw extracted text as fallback — better than nothing
    summary = extractedText.slice(0, 3000);
  }

  // 7. Save summary to knowledge_base
  const { error: updateError } = await sb
    .from("knowledge_base")
    .update({ content_text: summary })
    .eq("id", knowledge_base_id);

  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: CORS });
});
