import { serve } from "https://deno.land/std/http/server.ts";
import { getSupabaseClient } from "../_shared/db.ts";

const SERVICE_NAMES: Record<string, string> = {
  voice: "Voice Liaison",
  architect: "App Architect",
  brain: "Knowledge Brain",
  sentinel: "Instant Sentinel",
};

const ACTION_NAMES: Record<string, string> = {
  voice: "callback",
  architect: "meeting booking",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = getSupabaseClient(req);
    const body = await req.json();
    const { org_id, service_key, stats } = body as {
      org_id: string;
      service_key: string;
      stats: { request_count: number; avg_response_seconds: number; lost_count: number };
    };

    if (!org_id || !service_key || !stats) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Auth: verify caller is org member OR app admin
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    let authed = false;

    if (token) {
      // Check app_admins
      const { data: adminRow } = await supabase
        .from("app_admins")
        .select("id")
        .limit(1)
        .maybeSingle();
      if (adminRow) authed = true;

      if (!authed) {
        // Check org_members
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: member } = await supabase
            .from("org_members")
            .select("user_id")
            .eq("org_id", org_id)
            .eq("user_id", user.id)
            .maybeSingle();
          if (member) authed = true;
        }
      }
    }

    if (!authed) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const serviceName = SERVICE_NAMES[service_key] ?? service_key;
    const actionName = ACTION_NAMES[service_key] ?? "follow-up";
    const avgMin = Math.round((stats.avg_response_seconds ?? 0) / 60);

    const prompt = `You are a sales automation expert advising a business owner.
Their team manually handles ${actionName} requests because ${serviceName} is not active.
Real data: ${stats.request_count} leads requested ${actionName}, average manual response time was ${avgMin} minutes, ${stats.lost_count} leads were marked as lost after waiting.
Write exactly 2 sentences: one stating the revenue risk using the exact numbers, one explaining what automation would prevent. Be direct and data-driven. No fluff or filler phrases.`;

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: "OpenAI key not configured" }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiJson = await aiRes.json();
    const insight = aiJson.choices?.[0]?.message?.content?.trim() ?? "";

    return new Response(JSON.stringify({ insight }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate_upsell_insight_error", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
