import "server-only";
import crypto from "node:crypto";

/**
 * Salted one-way hash of a client IP, for evidence/provenance (quote
 * acceptance, H&S sign-off) — we store WHO-ish + integrity, never the raw IP.
 *
 * The salt is a high-entropy server secret (SUPABASE_SERVICE_ROLE_KEY, which
 * never reaches the client). If it's unset we refuse to hash and return null
 * rather than fall back to a forgeable constant salt — a misconfigured env
 * degrades to ip_hash=null, it never silently produces a trivially-reversible
 * hash. Shared so every provenance site hashes identically.
 */
export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!salt) {
    console.error("[security] IP salt secret not set; storing ip_hash=null instead of a forgeable fallback");
    return null;
  }
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** First client IP from the standard proxy headers (x-forwarded-for wins, then
 *  x-real-ip). Returns null when neither is present. */
export function getIpFromHeaders(h: Headers): string | null {
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return h.get("x-real-ip") ?? null;
}
