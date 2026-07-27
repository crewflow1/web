import "server-only";
import { env } from "@/lib/env";
import { isMaintenanceMode } from "@/lib/maintenance";

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
  return header === `Bearer ${secret}`;
}
