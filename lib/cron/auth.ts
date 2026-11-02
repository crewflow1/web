import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { isMaintenanceMode } from "@/lib/maintenance";

/**
 * Constant-time string equality.
 *
 * `timingSafeEqual` throws on a length mismatch, so compare lengths first and
 * return early — but do the early return in a way that still runs the digest
 * comparison for equal-length inputs, so the only timing signal an attacker can
 * observe is the secret's LENGTH, never its contents. This mirrors the comms
 * webhook verifiers (lib/comms/providers/*), which all use timingSafeEqual
 * rather than `===`; the cron chokepoint was the one secret comparison still on
 * a short-circuiting `===`.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  if (aBuf.length === 0) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Vercel Cron auth.
 *
 * Vercel attaches `Authorization: Bearer <CRON_SECRET>` to scheduled
 * invocations of routes listed in vercel.json. We refuse the call unless
 * the header matches the server-side secret. This keeps the cron URLs
 * safe even though they're public paths.
 *
 * Returns true when authorised; false when the caller is not allowed.
 * Callers should respond with 401 on false.
 */
export function isCronAuthorised(request: Request): boolean {
  // Maintenance-window suppression: during a controlled cutover, no scheduled
  // job may mutate the database. Refusing here skips ALL 19 crons at their one
  // shared chokepoint; they resume automatically on the next tick once
  // MAINTENANCE_MODE is cleared. (Vercel crons do not retry a skipped tick.)
  if (isMaintenanceMode()) {
    return false;
  }
  const secret = env.CRON_SECRET;
  if (!secret) {
    // No secret configured. Refuse rather than allow-by-default; an
    // unprotected cron URL is a public abuse vector.
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  // Constant-time compare — never a short-circuiting `===` on a secret.
  return constantTimeEquals(header, `Bearer ${secret}`);
}
