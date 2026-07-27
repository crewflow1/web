import "server-only";
import { notFound } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getUser, requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * HQ access — the SINGLE source of truth for "this server surface is HQ-only"
 * (CEO Directive #005, STEP 4).
 *
 * "Super-admin" is an ENV allowlist (CREWFLOW_SUPERADMIN_EMAILS), not a database
 * role or a JWT claim — so it cannot be expressed as an RLS policy. The gate must
 * therefore live in the request path, and it must live in EXACTLY ONE place so it
 * can never drift: every HQ page funnels through `requireHqPage()`, every HQ route
 * handler through `requireHqApi()`. Both reduce to the same predicate
 * (`isSuperAdminEmail`), so there is one allowlist, one decision, one behaviour.
 *
 * The non-allowlisted answer is 404, never 403: an HQ surface does not announce
 * its own existence. An anonymous visitor to a page is sent to /login (they might
 * be staff who simply aren't signed in); everyone else — signed-in non-staff,
 * anonymous API callers — gets an indistinguishable "not found".
 */

/**
 * Gate a SERVER COMPONENT / page. Redirects anonymous users to /login and 404s
 * everyone who is not on the super-admin allowlist; returns the authenticated HQ
 * user otherwise. This is the only call an HQ page needs for auth — do not
 * re-check the allowlist inline.
 */
export async function requireHqPage(): Promise<User> {
  const user = await requireUser(); // → /login when anonymous
  if (!isSuperAdminEmail(user.email)) notFound(); // → 404 for non-HQ
  return user;
}

/**
 * Gate a ROUTE HANDLER (an /api/* endpoint). Unlike the page gate this never
 * redirects — a fetch() caller wants a status code, not an HTML login page — so
 * it returns a discriminated result: the HQ user, or a ready-to-return 404
 * Response (the same "don't reveal the surface" semantics as the page gate, for
 * both anonymous and signed-in-but-not-staff callers).
 */
export async function requireHqApi(): Promise<
  { ok: true; user: User } | { ok: false; response: Response }
> {
  const user = await getUser();
  if (!user || !isSuperAdminEmail(user.email)) {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
  return { ok: true, user };
}
