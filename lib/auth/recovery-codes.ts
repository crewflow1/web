import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * MFA recovery (backup) codes — the one thing Supabase's native TOTP MFA does
 * NOT provide. A user who enrols an authenticator and then loses the device is
 * otherwise stranded at the /login/mfa challenge. Recovery codes are the
 * standard escape hatch: single-use, high-entropy strings that let the user
 * disable the lost factor and get back in to re-enrol.
 *
 * ── WHY HASHED, NOT ENCRYPTED ────────────────────────────────────────────────
 * A recovery code is a SECRET we never need to display again after generation —
 * we only ever need to CHECK a presented code against what we stored. That is a
 * one-way relationship, so we hash (never store plaintext, never store anything
 * reversible). This deliberately differs from lib/integrations/token-crypto.ts,
 * which ENCRYPTS OAuth tokens because those must be recovered in plaintext to
 * call a provider. Same doctrine ("never store the raw secret"), correct
 * primitive for the job.
 *
 * ── THE HASH ─────────────────────────────────────────────────────────────────
 * scrypt with a fresh random 16-byte salt per code. Self-describing string:
 *   `scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>`
 * The cost parameters live IN the stored string so they can be raised later
 * without a migration (old rows verify with their own recorded parameters).
 * scrypt needs NO external key, so recovery codes are a fully LIVE feature with
 * zero credential/config dependency — exactly what MFA must be.
 *
 * ── ENTROPY ──────────────────────────────────────────────────────────────────
 * Each code is 10 characters from a 32-symbol Crockford-style alphabet
 * (ambiguous 0/O/1/I/L/U removed) = ~50 bits. Verification is constant-time and
 * salted-slow, so even the theoretical guess space is unreachable. Codes are
 * displayed grouped (xxxxx-xxxxx) for legibility and normalised on the way back
 * in, so a user can type them with or without the dash / in any case.
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 symbols, no 0/O/1/I/L/U
const CODE_LEN = 10; // ~49 bits of entropy per code
const DEFAULT_COUNT = 10;

// scrypt cost parameters (recorded in each hash so they can be raised later).
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_BYTES = 16;

/**
 * Normalise a user-typed code: strip whitespace and dashes, upper-case. Lets a
 * user enter "abcde-fghjk", "ABCDE FGHJK", or "abcdefghjk" interchangeably.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Format a raw 10-char code for display as two dash-separated groups of five. */
function formatForDisplay(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Draw `len` symbols from ALPHABET using rejection sampling for uniformity. */
function randomCode(len: number): string {
  const out: string[] = [];
  const max = 256 - (256 % ALPHABET.length); // rejection bound → no modulo bias
  while (out.length < len) {
    for (const byte of randomBytes(len * 2)) {
      if (byte >= max) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === len) break;
    }
  }
  return out.join("");
}

/** Hash one normalised code into the self-describing `scrypt$...` envelope. */
export function hashRecoveryCode(code: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(normalizeRecoveryCode(code), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verify of a presented code against a stored `scrypt$...` hash.
 * Never throws — a malformed stored value returns false rather than blowing up
 * the sign-in path. The presented code is normalised so display formatting
 * (dashes/case/spaces) never causes a false mismatch.
 */
export function verifyRecoveryCode(presented: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(normalizeRecoveryCode(presented), salt, expected.length, {
      N,
      r,
      p,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export type GeneratedRecoveryCodes = {
  /** Human-facing, dash-grouped codes — shown ONCE, never persisted. */
  display: string[];
  /** `scrypt$...` hashes to persist, index-aligned with `display`. */
  hashes: string[];
};

/**
 * Mint a fresh batch of recovery codes. Returns the display strings (to show
 * the user exactly once) and their hashes (to store). Plaintext never leaves
 * this call — the caller persists only `hashes`.
 */
export function generateRecoveryCodes(count: number = DEFAULT_COUNT): GeneratedRecoveryCodes {
  const display: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomCode(CODE_LEN);
    display.push(formatForDisplay(raw));
    hashes.push(hashRecoveryCode(raw));
  }
  return { display, hashes };
}

export const RECOVERY_CODE_COUNT = DEFAULT_COUNT;
