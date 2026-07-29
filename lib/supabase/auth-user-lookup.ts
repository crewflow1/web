import "server-only";
import type { User } from "@supabase/supabase-js";
import type { createAdminClient } from "./admin";

/**
 * Paginated by-email lookup against the Supabase auth admin API.
 *
 * `auth.admin.listUsers()` is PAGINATED — a bare call returns only the
 * first page (50 users by default), and the installed supabase-js has no
 * by-email admin lookup (only listUsers/getUserById). Every "find the
 * auth user for this email" recovery path that called listUsers() bare
 * (or with a single perPage:1000 page) silently stopped seeing accounts
 * once the auth base outgrew one page, turning idempotent invite
 * recovery into a hard failure (loud-read-failures audit finding).
 *
 * This helper walks the pages via the API's `nextPage` cursor until it
 * finds the address or exhausts the list. Matching is trim +
 * case-insensitive on both sides. It never throws — transport errors
 * come back as `{ ok: false, reason }` so callers surface them loudly
 * instead of misreading them as "user not found".
 */

export const AUTH_USER_LOOKUP_PER_PAGE = 1000;

/**
 * Safety valve so a misbehaving API (nextPage never null) cannot loop
 * forever. 50 pages × 1000/page = 50k auth users — far beyond current
 * scale. Hitting it fails loudly rather than returning a false
 * "not found".
 */
export const AUTH_USER_LOOKUP_MAX_PAGES = 50;

export type AuthUserByEmailResult =
  | { ok: true; user: User | null }
  | { ok: false; reason: string };

export async function findAuthUserByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<AuthUserByEmailResult> {
  const needle = email.trim().toLowerCase();
  let page = 1;

  for (let hop = 0; hop < AUTH_USER_LOOKUP_MAX_PAGES; hop++) {
    let res: Awaited<ReturnType<typeof admin.auth.admin.listUsers>>;
    try {
      res = await admin.auth.admin.listUsers({
        page,
        perPage: AUTH_USER_LOOKUP_PER_PAGE,
      });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (res.error || !res.data) {
      return { ok: false, reason: res.error?.message || "list_users_failed" };
    }

    const match = res.data.users.find(
      (u) => (u.email ?? "").trim().toLowerCase() === needle,
    );
    if (match) return { ok: true, user: match };

    const nextPage = res.data.nextPage ?? null;
    if (nextPage === null) return { ok: true, user: null };
    page = nextPage;
  }

  return {
    ok: false,
    reason: `auth user lookup aborted after ${AUTH_USER_LOOKUP_MAX_PAGES} pages without exhausting the list`,
  };
}
