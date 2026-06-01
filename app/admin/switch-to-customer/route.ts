import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { getActiveImpersonation } from "@/server/services/impersonation";

export const runtime = "nodejs";

/**
 * "Switch to customer view" resolver.
 *
 * The old sidebar link pointed straight at /dashboard. But an HQ operator
 * (super-admin) usually has NO org membership, so /dashboard couldn't
 * resolve an org context and requireOrgContext() bounced them to
 * /onboarding/company — so clicking appeared to do nothing.
 *
 * Resolve a real destination instead:
 *   1. Active impersonation session  → /dashboard (renders that customer).
 *   2. Otherwise                      → /admin/customers to pick a customer
 *      to impersonate (the actual entry point into a customer workspace).
 *
 * NOTE: there is deliberately no "admin has their own org → /dashboard" path.
 * requireOrgContext() now bounces any super-admin out of the (app) group
 * unless they're actively impersonating, so impersonation is the ONLY way an
 * HQ operator reaches a customer workspace. Do not add a self-org shortcut
 * here — it would land an HQ user in tenant UI and immediately get redirected
 * back to /admin/organizations anyway.
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();

  // HQ-only feature. A non-admin should never reach here (the link only
  // renders in the HQ layout); if they do, send them to their own workspace.
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Active impersonation → that customer workspace is live at /dashboard.
  const impersonation = await getActiveImpersonation(user.email ?? null);
  if (impersonation) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // No active impersonation → open the company selector to pick one.
  return NextResponse.redirect(new URL("/admin/customers", request.url));
}
