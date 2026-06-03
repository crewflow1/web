import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { staffInviteEmail } from "@/lib/email/demo-templates";
import { env } from "@/lib/env";

/**
 * Staff invite — branded magic-link flow.
 *
 * Brings staff invites to parity with the customer-onboarding fix in
 * promoteDemoToCustomer (server/services/demo-lifecycle.ts):
 *
 *   inviteUserByEmail sent Supabase's default invite email, whose link
 *   uses the PKCE code-exchange flow. The code_verifier cookie only
 *   exists in the browser that initiated the request — but a staff invite
 *   is generated server-side from an admin's device, so a construction
 *   worker opening the email on their phone (or a different browser) hits
 *   "magic link invalid". We now bypass Supabase's email entirely:
 *     1. createUser carrying the invite metadata.
 *     2. generateLink({ type: "magiclink" }) → an action_link the
 *        /auth/callback route exchanges via verifyOtp (no PKCE verifier).
 *     3. email that link from hello@crewflow.uk via Resend.
 *
 * IMPORTANT — why we do NOT pass `email_confirm: true` (unlike
 * promoteDemoToCustomer):
 *   Staff invites stay UNCONFIRMED until the teammate clicks the link.
 *   listPendingInvites (app/(app)/staff/_invites.ts) and resendStaffInvite
 *   both key off `email_confirmed_at === null` as the "still pending"
 *   signal so an invited teammate is visible in the staff directory before
 *   they accept (bug H2). Pre-confirming the email would make them
 *   instantly disappear from that list. A magic link verifies the email on
 *   use anyway, so confirmation still happens — just at accept time, not
 *   invite time.
 *
 * Used by all three staff-invite entry points:
 *   - inviteStaff           (app/(app)/staff/actions.ts)
 *   - resendStaffInvite     (app/(app)/staff/actions.ts)
 *   - sendStaffInvitesFromImport (app/(app)/imports/actions.ts)
 */

/**
 * The auth user_metadata contract the join flow depends on. Consumed by
 * app/onboarding/company/page.tsx, app/onboarding/join/actions.ts and
 * app/(app)/staff/_invites.ts. `source: "staff_invite"` + `invited_org_id`
 * are the load-bearing keys; the rest pre-fill the profile on accept.
 */
export type StaffInviteMetadata = {
  invited_org_id: string;
  invited_role: string;
  invited_full_name: string | null;
  invited_phone?: string | null;
  invited_employment_type?: string | null;
  invited_hourly_pay?: number | null;
  invited_emergency_contact?: {
    name: string | null;
    phone: string | null;
    relationship: string | null;
  } | null;
  source: "staff_invite";
};

export type StaffInviteResult =
  | { ok: true; alreadyExisted: boolean; hadMagicLink: boolean }
  | { ok: false; reason: string };

export async function sendStaffInvite(args: {
  email: string;
  /** For the email greeting only. */
  fullName: string | null;
  /** Org display name for the email subject/body. */
  orgName: string;
  metadata: StaffInviteMetadata;
}): Promise<StaffInviteResult> {
  const admin = createAdminClient(); // service role — provisions auth users + generates sign-in links (RLS N/A on auth schema)
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const email = args.email.trim();

  // -------------------------------------------------------------------
  // 1. Create the auth user carrying the invite metadata. No
  //    email_confirm (see file header) — the teammate stays pending
  //    until they click the link.
  // -------------------------------------------------------------------
  let alreadyExisted = false;
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    user_metadata: args.metadata,
  });

  if (createErr) {
    const msg = createErr.message ?? "";
    // Idempotent: a prior pending invite (or a pre-existing account) for
    // this email. Refresh the metadata so the join flow hydrates the
    // latest org/role/profile, then re-send a fresh link.
    if (/already (registered|exists|signed|been)/i.test(msg) || createErr.status === 422) {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (listErr) return { ok: false, reason: listErr.message };
      const existing = list?.users.find(
        (u) => (u.email ?? "").trim().toLowerCase() === email.toLowerCase(),
      );
      if (!existing) return { ok: false, reason: msg || "user_lookup_failed" };
      alreadyExisted = true;
      const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
        user_metadata: args.metadata,
      });
      if (updErr) return { ok: false, reason: updErr.message };
    } else {
      return { ok: false, reason: msg || "create_user_failed" };
    }
  }

  // -------------------------------------------------------------------
  // 2. Generate the magic-link URL we embed in our branded email.
  //    Non-fatal on failure: the email still goes out with /login
  //    recovery instructions (the account exists, so the teammate can
  //    request a fresh link or sign in with Google).
  // -------------------------------------------------------------------
  let magicLinkUrl: string | null = null;
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${appUrl}/auth/callback` },
  });
  if (linkErr) {
    console.error("[staff-invite] generateLink failed", linkErr);
  } else {
    magicLinkUrl = linkData?.properties?.action_link ?? null;
  }

  // -------------------------------------------------------------------
  // 3. Branded invite email via Resend — same channel as the customer
  //    magic link.
  // -------------------------------------------------------------------
  const tmpl = staffInviteEmail({
    name: args.fullName,
    orgName: args.orgName,
    magicLinkUrl,
  });
  const res = await sendEmail({
    to: email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    replyTo: env.RESEND_REPLY_TO,
  });
  if (!res.sent) {
    const reason =
      res.reason === "error"
        ? `error: ${res.error}`
        : res.reason === "self_loop"
          ? `self_loop: from=${res.from} to=${res.to}`
          : res.reason; // "no_key"
    return { ok: false, reason };
  }

  return { ok: true, alreadyExisted, hadMagicLink: magicLinkUrl != null };
}
