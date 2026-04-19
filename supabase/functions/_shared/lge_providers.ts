// lge_providers.ts — Apollo + Hunter + AbstractAPI Phone + Website reachability
// Isolates all external provider I/O; scorer stays pure; worker orchestrates.

// ── Key Decryption ────────────────────────────────────────────────────────────
// Must match the encryption in lge_campaign_manage/index.ts exactly.

async function getEncryptionKey(): Promise<CryptoKey> {
  const rawKey =
    Deno.env.get("LGE_ENCRYPTION_KEY") ??
    Deno.env.get("GSC_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "fallback-insecure-key-set-LGE_ENCRYPTION_KEY";

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(rawKey), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("lge-provider-api-keys-v1"), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function decryptProviderKey(encrypted: string): Promise<string> {
  const [ivB64, ctB64] = encrypted.split(":");
  const key = await getEncryptionKey();
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plainBuf);
}

// ── Apollo Enrichment ─────────────────────────────────────────────────────────

export interface ApolloResult {
  industry: string | null;
  company_size: string | null;
  designation: string | null;
  sources_json: Record<string, unknown>;
}

// Maps Apollo's employee count to our tier bucket strings
function empCountToTier(count: number | null | undefined): string | null {
  if (count == null) return null;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 500) return "201-500";
  return "500+";
}

export async function enrichWithApollo(
  apiKey: string,
  lead: { name?: string | null; email?: string | null; company?: string | null },
): Promise<ApolloResult | null> {
  const body: Record<string, string> = { api_key: apiKey };
  if (lead.email) body.email = lead.email;
  if (lead.name) {
    const parts = lead.name.trim().split(/\s+/);
    body.first_name = parts[0];
    if (parts.length > 1) body.last_name = parts.slice(1).join(" ");
  }
  if (lead.company) body.organization_name = lead.company;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);

  try {
    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const json = await res.json();
    const person = json?.person;
    if (!person) return null;

    return {
      industry: person.organization?.industry ?? person.industry ?? null,
      company_size: empCountToTier(person.organization?.estimated_num_employees),
      designation: person.title ?? null,
      sources_json: {
        apollo: { id: person.id, organization_id: person.organization_id },
      },
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Hunter Email Verification ─────────────────────────────────────────────────

export interface HunterResult {
  email_verified: boolean;
  hunter_status: string | null;
}

export async function verifyWithHunter(apiKey: string, email: string): Promise<HunterResult | null> {
  const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) return null;

    const json = await res.json();
    const result: string | null = json?.data?.result ?? null;

    return {
      email_verified: result === "deliverable",
      hunter_status: result,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Hunter Domain Search (firmographic) ──────────────────────────────────────
// Uses existing Hunter key — no extra signup needed.
// Extracts company industry + size from email domain when Apollo returns nothing.

export interface HunterDomainResult {
  industry: string | null;
  company_size: string | null;
  organization: string | null;
}

function hunterSizeToTier(size: string | null | undefined): string | null {
  if (!size) return null;
  // Hunter returns ranges like "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"
  if (size.startsWith("1-") || size === "1-10") return "1-10";
  if (size.startsWith("11-")) return "11-50";
  if (size.startsWith("51-")) return "51-200";
  if (size.startsWith("201-")) return "201-500";
  return "500+";
}

export async function enrichFromHunterDomain(
  apiKey: string,
  email: string,
): Promise<HunterDomainResult | null> {
  const domain = email.toLowerCase().split("@")[1]?.trim();
  if (!domain) return null;

  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(apiKey)}&limit=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = await res.json();
    const data = json?.data;
    if (!data) return null;

    return {
      industry:      data.industry ?? null,
      company_size:  hunterSizeToTier(data.company_size),
      organization:  data.organization ?? null,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── AbstractAPI Phone Verification ────────────────────────────────────────────

export interface PhoneVerifyResult {
  valid:     boolean;
  line_type: string; // mobile | landline | voip | satellite | toll_free | premium_rate | unknown
  carrier:   string | null;
}

export async function verifyPhoneAbstract(
  apiKey: string,
  phone: string,
): Promise<PhoneVerifyResult | null> {
  const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&phone=${encodeURIComponent(phone)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const json = await res.json();
    return {
      valid:     json?.valid === true,
      line_type: json?.type ?? "unknown",
      carrier:   json?.carrier ?? null,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Website Reachability ──────────────────────────────────────────────────────
// Extracts domain from a business email (skips free providers) and does a
// HEAD request. No API key required.

const FREE_DOMAINS_CHECK = new Set([
  "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","yahoo.in","hotmail.com",
  "hotmail.co.uk","outlook.com","live.com","msn.com","icloud.com","me.com","mac.com",
  "aol.com","protonmail.com","proton.me","zoho.com","yandex.com","mail.com","gmx.com",
  "rediffmail.com","verizon.net","att.net","comcast.net","sbcglobal.net",
]);

export async function checkWebsiteReachable(email?: string | null): Promise<boolean | null> {
  if (!email) return null;
  const parts = email.toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const domain = parts[1].trim();
  if (FREE_DOMAINS_CHECK.has(domain)) return null; // skip — personal email, no company site to check

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4_000);

  try {
    const res = await fetch(`https://${domain}`, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    clearTimeout(timer);
    // Try http fallback
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 3_000);
      const res2 = await fetch(`http://${domain}`, { method: "HEAD", signal: ctrl2.signal });
      clearTimeout(timer2);
      return res2.status < 500;
    } catch {
      return false;
    }
  }
}
