import { randomBytes } from "node:crypto";

/**
 * Server-only opaque-token minting. Kept OUT of `lib/assets/qr.ts` so that the
 * isomorphic scan helpers there (used by the client scanner) never drag
 * `node:crypto` into the browser bundle. Only server code (the QR generate/
 * rotate action) imports this; a client import would fail the build on the
 * `node:crypto` scheme — the boundary is enforced at build time.
 */

/** 24 random bytes → a 32-char URL-safe (base64url) opaque token. */
export function generateOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
