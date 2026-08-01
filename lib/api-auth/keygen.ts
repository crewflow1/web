import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * API-key generation + hashing (Train 9 substrate).
 *
 * Key format: `crewflow_sk_` + 43 base62 characters encoding 32 random bytes
 * (256 bits of entropy — ceil(256 / log2(62)) = 43 digits, left-padded with
 * the base62 zero digit so the length is constant).
 *
 * THE PLAINTEXT RULE: the plaintext key returned by {@link generateApiKey}
 * exists exactly once — in the create action's response to the admin who
 * minted it. It is NEVER logged, NEVER stored (only the sha256 hex digest is
 * persisted, as api_keys.key_hash), and no read path can reproduce it.
 * __tests__/security/api-keys.test.ts pins the forbidden sinks.
 *
 * Bias note: the 256-bit value is base62-encoded as ONE big integer
 * (bijective), not per-byte modulo — so every one of the 2^256 values maps to
 * a distinct 43-digit string and no character position is skewed.
 */

export const API_KEY_PREFIX = "crewflow_sk_";

/** Secret entropy, in bytes, behind the prefix. */
export const API_KEY_SECRET_BYTES = 32;

/** base62 digits of a 256-bit integer, constant-length via left-padding. */
export const API_KEY_SECRET_LENGTH = 43;

/** How many secret chars the display prefix keeps (api_keys.key_prefix). */
export const API_KEY_DISPLAY_CHARS = 8;

/** Shape of a full plaintext key. The resolver refuses anything else before
 *  it ever touches the database. */
export const API_KEY_REGEX = /^crewflow_sk_[0-9A-Za-z]{43}$/;

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Encode a buffer as base62 (big-endian bigint), left-padded to `length`. */
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

/** Hex sha256 of a plaintext key — the ONLY form of the key that is ever
 *  persisted (api_keys.key_hash) or used for lookup. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export type GeneratedApiKey = {
  /** The full key. Show ONCE, then let it go. Never log, never store. */
  plaintext: string;
  /** `crewflow_sk_` + first 8 secret chars — the stored display identifier. */
  keyPrefix: string;
  /** Hex sha256 of `plaintext` — the stored verifier / lookup key. */
  keyHash: string;
};

/** Mint a new key. crypto.randomBytes — CSPRNG, never Math.random. */
export function generateApiKey(): GeneratedApiKey {
  const secret = toBase62(randomBytes(API_KEY_SECRET_BYTES), API_KEY_SECRET_LENGTH);
  const plaintext = `${API_KEY_PREFIX}${secret}`;
  return {
    plaintext,
    keyPrefix: `${API_KEY_PREFIX}${secret.slice(0, API_KEY_DISPLAY_CHARS)}`,
    keyHash: hashApiKey(plaintext),
  };
}
