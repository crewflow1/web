import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { getActiveImpersonation } from "@/server/services/impersonation";
import { createClient } from "@/lib/supabase/server";

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
 *   2. Admin has their own org        → /dashboard (their workspace).
 *   3. Otherwise                      → /admin/customers to pick a customer
 *      to impersonate (the actual entry point into a customer workspace).
 */
export async function GET(request: NextRequest) {
  const user = await requireUser();
  const toDashboard = NextResponse.redirect(new URL("/dashboard", request.url));

  // A non-admin only ever has their own workspace.
  if (!isSuperAdminEmail(user.email)) return toDashboard;

  // Already impersonating → the customer workspace is live at /dashboard.
  const impersonation = await getActiveImpersonation(user.email ?? null);
  if (impersonation) return toDashboard;

  // Super-admin who also belongs to an org → that workspace.
  const supabase = await createClient();
  const { count } = await supabase
    .from("memberships")
    .select("org_id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) > 0) return toDashboard;

  // Org-less HQ operator: choose a customer to view (impersonate).
  return NextResponse.redirect(new URL("/admin/customers", request.url));
}
