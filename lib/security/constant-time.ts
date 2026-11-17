import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for two SECRET-bearing strings (a bearer header vs the
 * configured secret, a verify token vs its env value).
 *
 * `===` on strings short-circuits at the first differing byte, so response time
 * leaks how long a correct prefix an attacker has guessed. `timingSafeEqual`
 * needs equal-length inputs, and comparing lengths first would leak the secret's
 * length — so both sides are hashed to a fixed 32 bytes and the DIGESTS are
 * compared. Null / undefined / empty on either side is never a match (an unset
 * secret must fail closed, never compare equal to an absent header).
 */
export function constantTimeEqual(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
