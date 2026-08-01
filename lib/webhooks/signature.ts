import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signing (Train A).
 *
 * Mirrors the Stripe INBOUND signature shape we already verify
 * (app/api/webhooks/stripe), applied the other direction so receivers can verify
 * us with the same well-known scheme:
 *
 *   X-CrewFlow-Signature: t=<unix_ts>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
 *
 * The timestamp is INSIDE the signed material, so a captured body cannot be
 * replayed under a different time. `signWebhookPayload` builds the header the
 * delivery pass sends; `verifyWebhookSignature` is the reference verifier the
 * signature-vector tests (and any receiver) use, constant-time by construction.
 */

export const SIGNATURE_HEADER = "X-CrewFlow-Signature";
export const DELIVERY_ID_HEADER = "X-CrewFlow-Delivery-Id";

/** Compute the hex HMAC-SHA256 over `${timestamp}.${body}`. */
export function computeSignature(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");
}

/** Build the full `t=…,v1=…` signature header value for a payload. */
export function signWebhookPayload(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = computeSignature(secret, body, timestampSeconds);
  return `t=${timestampSeconds},v1=${v1}`;
}

/** Parse a `t=…,v1=…` header into its parts (null if malformed). */
export function parseSignatureHeader(
  header: string | null | undefined,
): { t: number; v1: string } | null {
  if (!header) return null;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") {
      const n = Number(v);
      if (Number.isFinite(n)) t = n;
    } else if (k?.trim() === "v1") {
      v1 = v?.trim() ?? null;
    }
  }
  if (t === null || !v1) return null;
  return { t, v1 };
}

/**
 * Reference verifier — constant-time, with an optional freshness window. Returns
 * true iff the header's v1 matches HMAC(secret, `${t}.${body}`) and (when
 * `toleranceSeconds` is given) the timestamp is within that window of `now`.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (typeof opts.toleranceSeconds === "number") {
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - parsed.t) > opts.toleranceSeconds) return false;
  }

  const expected = computeSignature(secret, body, parsed.t);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.v1, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
