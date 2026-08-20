import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) + state/nonce helpers for the OIDC authorization-code flow.
 * All values come from crypto.randomBytes (CSPRNG), never Math.random.
 */

/** A high-entropy URL-safe token (base64url, no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export type PkcePair = { verifier: string; challenge: string; method: "S256" };

/** Generate a PKCE code_verifier and its S256 challenge. */
export function generatePkce(): PkcePair {
  const verifier = randomToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}
