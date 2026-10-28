import type { ReactNode } from "react";
import { requireManagementContext } from "@/server/auth/session";

/**
 * Shared segment guard — the whole subtree is management-only (owner/admin).
 *
 * Re-exported as the `layout.tsx` of every segment that the founder's role
 * policy puts off-limits to `staff` (Operations, the Site & Safety admin
 * registers, Inbox customer-comms). A layout wraps EVERY child route (list,
 * [id], nested tabs), so a staff member cannot reach any sub-page by typing the
 * URL — nav-hiding is presentation only; this is the server enforcement, with
 * RLS as the last line.
 *
 * Interim note: until the custom-admin capability model (impact-assessment R2/R4)
 * lands, "management" = owner|admin via requireManagementContext. The server
 * actions inside these segments are NOT protected by this layout (a layout never
 * guards a server action), so any mutation that must exclude staff re-checks
 * management in its own body.
 */
export default async function ManagementSegmentLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireManagementContext();
  return <>{children}</>;
}
