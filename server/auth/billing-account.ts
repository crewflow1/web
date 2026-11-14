import "server-only";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import {
  getOrgForUser,
  getUser,
  orgHasActiveAccess,
  requireOrgContext,
  requireUser,
  type OrgContext,
} from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * Auth for the BILLING ACCOUNT surfaces — the things an org's owner is entitled
 * to even when the workspace has NO active access (cancelled / suspended):
 * cancelling, billing history, a data export, and asking to reactivate.
 *
 * Why this is not requireOrgContext(): that gate redirects every non-active org
 * to /access-pending. A customer whose card failed (org `suspended`) could
 * therefore not reach the cancel button, and a customer who cancelled could not
 * reach their invoices or their data. These guards admit any org status but are
 * STRICTER about who the caller is:
 *
 *   • the org comes from the caller's OWN membership row (getOrgForUser with no
 *     impersonation option) — never from request input, and never from an HQ
 *     impersonation session, which presents a synthetic `owner` role;
 *   • HQ super-admins are refused outright (they act through /admin);
 *   • owner-only: `admin` and `staff` members are refused.
 *
 * When the org DOES have active access the action guard additionally runs
 * requireOrgContext(), so the org's MFA policy applies to a cancel exactly as it
 * does to every other privileged action.
 */

export type BillingAccountContext = {
  user: User;
  ctx: OrgContext;
  /** The caller's real membership role in this org is `owner`. */
  isOwner: boolean;
};

/**
 * PAGE guard. Redirects: no session → /login; HQ super-admin → /admin; no org →
 * onboarding. Does NOT redirect on org status — that is the point.
 */
export async function requireBillingAccount(): Promise<BillingAccountContext> {
  const user = await requireUser();
  if (isSuperAdminEmail(user.email)) redirect("/admin/organizations");
  const ctx = await getOrgForUser(user.id);
  if (!ctx) redirect("/onboarding/company");
  return { user, ctx, isOwner: ctx.membership.role === "owner" };
}

export type BillingOwnerResolution =
  | { ok: true; user: User; ctx: OrgContext }
  | { ok: false; reason: "unauthenticated" | "forbidden" | "no_org" };

/**
 * ACTION / ROUTE guard. Never throws a redirect for an authorisation failure —
 * returns a refusal the caller turns into an error state or a 401/403 — so a
 * denied caller can never be mistaken for a successful one.
 */
export async function resolveBillingOwner(): Promise<BillingOwnerResolution> {
  const user = await getUser();
  if (!user) return { ok: false, reason: "unauthenticated" };
  if (isSuperAdminEmail(user.email)) return { ok: false, reason: "forbidden" };

  const ctx = await getOrgForUser(user.id);
  if (!ctx) return { ok: false, reason: "no_org" };
  if (ctx.membership.role !== "owner") return { ok: false, reason: "forbidden" };

  // Active workspace → the full session policy (MFA enforcement) applies.
  if (orgHasActiveAccess(ctx.org.status)) {
    await requireOrgContext();
  }
  return { ok: true, user, ctx };
}
