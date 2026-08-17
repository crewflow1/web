import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pending staff invites.
 *
 * BUG H2 — invited teammates were invisible until they accepted.
 * -------------------------------------------------------------
 * `inviteStaff` (Case A, brand-new email) sends a Supabase magic-link
 * invite, which creates an UNCONFIRMED `auth.users` row carrying our
 * invite payload in `user_metadata` (invited_org_id, invited_role,
 * invited_full_name, source: "staff_invite"). No row exists in
 * public.memberships / public.users yet, so the staff directory — which
 * only reads memberships — showed nothing. The teammate effectively
 * vanished until they clicked the link and finished onboarding.
 *
 * Rather than add a dedicated `staff_invites` table (which would need a
 * migration applied to the shared prod DB before any preview could read
 * it, plus a hand-edit of the committed Supabase types), we read the
 * invites straight back out of auth via the admin API and reconcile them
 * against the current membership list. The moment an invite is accepted,
 * `email_confirmed_at` is set AND a membership is created, so the row
 * naturally drops off this list.
 *
 * Scale note: listUsers scans the auth base and filters by metadata —
 * fine at pilot scale. A dedicated org-scoped table is the future-proof
 * approach if the user base grows large.
 */

export type PendingInvite = {
  email: string;
  full_name: string | null;
  role: string;
  invited_at: string | null;
};

export async function listPendingInvites(
  orgId: string,
  memberEmails: ReadonlySet<string>,
): Promise<PendingInvite[]> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    // Service-role key not configured (e.g. a misconfigured preview) —
    // degrade gracefully rather than 500 the whole staff page.
    console.error("[staff] pending invites unavailable (admin client)", e);
    return [];
  }

  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error || !data) {
    console.error("[staff] listPendingInvites failed", error);
    return [];
  }

  const seen = new Set<string>();
  const invites: PendingInvite[] = [];
  for (const u of data.users) {
    // Invite anchor lives in admin-only app_metadata (see sendStaffInvite).
    const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
    // Strict org scoping + only invites we created.
    if (meta.invited_org_id !== orgId) continue;
    if (meta.source !== "staff_invite") continue;
    // Already accepted (signed in via the link) → not pending.
    if (u.email_confirmed_at) continue;

    const email = (u.email ?? "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    // Reconcile: if they're already a member, the invite is stale.
    if (memberEmails.has(key)) continue;
    seen.add(key);

    invites.push({
      email,
      full_name:
        typeof meta.invited_full_name === "string" && meta.invited_full_name
          ? meta.invited_full_name
          : null,
      role: typeof meta.invited_role === "string" ? meta.invited_role : "staff",
      invited_at: u.invited_at ?? u.created_at ?? null,
    });
  }

  return invites.sort((a, b) =>
    (b.invited_at ?? "").localeCompare(a.invited_at ?? ""),
  );
}
