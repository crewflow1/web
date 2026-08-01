import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Webhook signing-secret generation (Train A).
 *
 * Secret format: `whsec_` + 43 base62 chars encoding 32 random bytes (256 bits of
 * entropy) — the same CSPRNG bijective-base62 encoding as the API-key generator
 * (lib/api-auth/keygen.ts), so no character position is skewed.
 *
 * THE SECRET RULE: the secret returned by {@link generateWebhookSecret} is shown
 * to the admin exactly ONCE (in the create action's response), stored verbatim in
 * webhook_endpoints.secret to sign outbound deliveries, and NEVER read back to any
 * tenant surface (column-level privilege, migration 20261087). It is never logged.
 */

export const WEBHOOK_SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function toBase62(bytes: Buffer, length: number): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  const base = 62n;
  let out = "";
  while (value > 0n) {
    out = BASE62_ALPHABET[Number(value % base)] + out;
    value /= base;
  }
  return out.padStart(length, "0");
}

/** Mint a new endpoint signing secret. crypto.randomBytes — CSPRNG, never Math.random. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${toBase62(randomBytes(SECRET_BYTES), SECRET_LENGTH)}`;
}
