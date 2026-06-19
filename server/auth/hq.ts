import "server-only";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * CrewFlow HQ — the single authorization gate (CEO Directive 007.5,
 * Phase 4: one source of truth for permissions).
 *
 * Before this module the same `requireUser() + isSuperAdminEmail()` dance
 * was copy-pasted as a private `requireAdmin()` in every HQ server-action
 * file (~15 byte-identical clones) and re-derived inline in every HQ page.
 * That is exactly the duplication the directive forbids — there must be
 * ONE implementation. Server actions call `requireHq()`; pages and the
 * `/admin` layout call `requireHqPage()`.
 *
 * The two entry points differ only in how they reject a non-allowlisted
 * caller, and that difference is deliberate:
 *   - actions redirect to /dashboard (a POST bounce the client follows);
 *   - pages 404 (hide the very existence of the HQ surface from snoopers).
 */

/**
 * The actor behind an HQ mutation — id + email, ready to stamp onto an
 * `admin_activity_log` row. `email` is always a real, non-empty string:
 * `requireHq()` only returns once `isSuperAdminEmail(email)` has passed,
 * and that predicate is false for any empty/missing email.
 */
export type HqActor = { id: string; email: string };

/**
 * HQ gate for server actions. Requires an authenticated super-admin:
 *   - unauthenticated            → redirect("/login")  (via requireUser)
 *   - authenticated, not allowed → redirect("/dashboard")
 *   - allowlisted                → returns { id, email } for audit stamping
 */
export async function requireHq(): Promise<HqActor> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

/**
 * HQ gate for pages and the `/admin` layout. Same authenticated-super-admin
 * requirement as `requireHq()`, but a non-allowlisted caller gets
 * `notFound()` (a 404) rather than a redirect. That is deliberate: a 404
 * hides the very existence of the HQ surface from snoopers, whereas a
 * redirect would confirm the route is real.
 *   - unauthenticated            → redirect("/login")  (via requireUser)
 *   - authenticated, not allowed → notFound()  (404, route stays hidden)
 *   - allowlisted                → returns { id, email }
 */
export async function requireHqPage(): Promise<HqActor> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();
  return { id: user.id, email: user.email ?? "" };
}
