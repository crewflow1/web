import type { ReactNode } from "react";
import { requireManagementContext } from "@/server/auth/session";

/**
 * Segment authorization guard (least-privilege enforcement).
 *
 * Reviews is a Sales surface (hidden from `staff` in the navigation): it lists
 * customers and sends them e-mail. Owner/admin only — a staff member who types
 * the URL is redirected like on every other management page. The server actions
 * re-check the role themselves (app/(app)/reviews/actions.ts).
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireManagementContext();
  return <>{children}</>;
}
