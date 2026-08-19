import { createHash, randomBytes } from "node:crypto";

/**
 * External worker sign-off token — pure, deterministic helpers for the opaque
 * URL token → hash-at-rest pipeline. No DB / IO here, so the trust-boundary
 * rules (what a token looks like, how it is hashed) are unit-testable in
 * isolation and shared by every path that mints or resolves one.
 *
 * DESIGN — the token is the ENTIRE auth surface for the external worker portal
 * (there is no login, no session, no membership), so it is:
 *   * HIGH ENTROPY — 32 random bytes (256 bits) from crypto.randomBytes, far
 *     beyond guessable, minted server-side only. Encoded base64url (URL-safe,
 *     no padding) → a 43-char slug.
 *   * OPAQUE — it carries no org / job / worker identity; it resolves ONLY via
 *     its hash, so it cannot be decoded or tampered into another scope.
 *   * HASHED AT REST — only the SHA-256 hex of the token is stored
 *     (worker_signoff_tokens.token_hash). The plaintext is shown to staff ONCE
 *     at issue and never persisted, so a DB read (or leaked backup) cannot
 *     reconstruct a working link. This is STRONGER than the customer-portal
 *     UUID pattern (which stores the token in the clear).
 */

/** Raw entropy of a worker token, in bytes. 32 bytes = 256 bits. */
export const WORKER_TOKEN_BYTES = 32;

/** base64url encoding of 32 bytes has no padding and is exactly 43 chars. */
const WORKER_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A SHA-256 hex digest is 64 lowercase hex chars. */
const WORKER_TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

export type MintedWorkerToken = {
  /** The plaintext token — goes in the URL, shown to staff ONCE, never stored. */
  token: string;
  /** SHA-256 hex of the token — the ONLY representation persisted. */
  tokenHash: string;
};

/** Mint a fresh high-entropy worker token + its at-rest hash. Server-only use. */
export function mintWorkerToken(): MintedWorkerToken {
  const token = randomBytes(WORKER_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashWorkerToken(token) };
}

/**
 * SHA-256 hex of a worker token. Deterministic: the same token always hashes to
 * the same value, so the loader can hash an inbound URL token and look the row
 * up by `token_hash`. Unsalted ON PURPOSE — the token itself is 256 bits of
 * entropy, so a salt adds nothing against brute force, and an unsalted hash is
 * what lets the loader resolve a link by a single indexed equality lookup.
 */
export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Tight shape check for a URL token BEFORE it ever reaches the DB, so a stray
 * path segment (or a probing junk value) can't trigger a lookup. Returns false
 * for anything that isn't exactly a 43-char base64url slug.
 */
export function isValidWorkerTokenShape(value: unknown): value is string {
  return typeof value === "string" && WORKER_TOKEN_SHAPE.test(value);
}

/** Shape check for a stored hash (mirrors the DB CHECK on token_hash). */
export function isValidWorkerTokenHashShape(value: unknown): value is string {
  return typeof value === "string" && WORKER_TOKEN_HASH_SHAPE.test(value);
}
