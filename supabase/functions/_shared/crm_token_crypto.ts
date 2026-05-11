// crm_token_crypto.ts — AES-GCM encryption/decryption for CRM OAuth tokens.
// Mirrors the pattern in lge_providers.ts. Tokens are never stored or returned in plain text.

async function getCrmEncryptionKey(): Promise<CryptoKey> {
  const rawKey =
    Deno.env.get("CRM_ENCRYPTION_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "fallback-insecure-key-set-CRM_ENCRYPTION_KEY";

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(rawKey), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("crm-oauth-tokens-v1"), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptCrmAuth(plainObj: Record<string, unknown>): Promise<string> {
  const key = await getCrmEncryptionKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(plainObj)),
  );
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `${ivB64}:${ctB64}`;
}

export async function decryptCrmAuth(encrypted: string): Promise<Record<string, unknown>> {
  const [ivB64, ctB64] = encrypted.split(":");
  const key     = await getCrmEncryptionKey();
  const iv      = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct      = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// ── HMAC-signed OAuth state ──────────────────────────────────────────────────
// Prevents CSRF on the OAuth callback. State expires in 10 minutes.

async function getHmacKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "fallback-hmac-key";
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(raw),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export async function signOAuthState(data: { orgId: string; crmType: string; ts: number }): Promise<string> {
  const raw = JSON.stringify(data);
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(`${raw}|${sigB64}`);
}

export async function verifyOAuthState(
  stateB64: string,
): Promise<{ orgId: string; crmType: string; ts: number } | null> {
  try {
    const decoded  = atob(stateB64);
    const lastPipe = decoded.lastIndexOf("|");
    const raw      = decoded.slice(0, lastPipe);
    const sigB64   = decoded.slice(lastPipe + 1);

    const key = await getHmacKey();
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(raw));
    if (!valid) return null;

    const data = JSON.parse(raw);
    if (Date.now() - data.ts > 10 * 60 * 1000) return null; // expired
    return data;
  } catch {
    return null;
  }
}
