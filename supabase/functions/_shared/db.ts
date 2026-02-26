import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * USER CONTEXT CLIENT (RLS enforced)
 * Uses SUPABASE_ANON_KEY and forwards Authorization header if present.
 */
export function getUserSupabaseClient(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_ANON_PUBLIC_KEY") ?? // sometimes named this way
    "";

  if (!supabaseUrl) throw new Error("SUPABASE_URL_MISSING");
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY_MISSING");

  const authHeader = req.headers.get("Authorization") ?? "";

  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
}

/**
 * SERVICE ROLE CLIENT (bypasses RLS)
 * Use ONLY for webhooks and tightly controlled privileged operations.
 */
export function getServiceSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey =
    Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";

  if (!supabaseUrl) throw new Error("SUPABASE_URL_MISSING");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY_MISSING");

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Back-compat alias if other files still import getSupabaseClient(req).
 * This returns USER context (RLS enforced).
 */
export const getSupabaseClient = getUserSupabaseClient;