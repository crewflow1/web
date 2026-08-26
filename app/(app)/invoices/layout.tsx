import type { ReactNode } from "react";
import { requireManagementContext } from "@/server/auth/session";

/**
 * Segment authorization guard.
 *
 * This whole area is owner/admin only — the nav model marks the Sales and Money
 * groups with ADMIN_ROLES (app/(app)/_nav/nav-model.ts). A layout wraps EVERY
 * child route (the list page, `[id]` detail, `new`, and any nested tab), so a
 * `staff` member cannot reach any sub-page by typing the URL. Nav-hiding is
 * presentation only; this is the server-side enforcement. RLS remains the last
 * line of defence. requireManagementContext() reuses the caller's own membership
 * role (React.cache-memoised requireOrgContext) and redirects non-management
 * members to /dashboard?error=forbidden — never a 500, never a blank page.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireManagementContext();
  return <>{children}</>;
}
