import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Server-only opaque-token minting. Kept OUT of `lib/assets/qr.ts` so that the
 * isomorphic scan helpers there (used by the client scanner) never drag
 * `node:crypto` into the browser bundle. Only server code (the QR generate/
 * rotate action) imports this. The explicit `server-only` import makes the
 * boundary a compile-time contract (a client import fails with a clear error),
 * rather than relying implicitly on the `node:crypto` scheme breaking the build.
 */

/** 24 random bytes → a 32-char URL-safe (base64url) opaque token. */
export function generateOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
