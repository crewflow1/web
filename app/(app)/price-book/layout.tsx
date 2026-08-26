import type { ReactNode } from "react";
import { requireManagementContext } from "@/server/auth/session";

/**
 * Segment authorization guard — owner/admin only (nav marks Sales/Money
 * ADMIN_ROLES). A layout wraps every child route (list, detail, nested tabs), so
 * a `staff` member cannot reach any sub-page by URL. RLS remains the last line.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireManagementContext();
  return <>{children}</>;
}
