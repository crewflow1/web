import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Inbox segment authorization guard (R4) — requires inbox:view.
 *
 * The inbox IS customer communications, so staff/field members are off-limits
 * (R1 #951 first gated this to owner/admin via the shared management layout;
 * R4 moves it onto the capability model). A layout wraps EVERY child route
 * (list, conversations, conversation detail, review queue, audit), so a member
 * without inbox:view cannot reach any sub-page by typing the URL. Owner passes
 * unconditionally; an admin needs the grant; staff/members are denied. The
 * write actions re-check their own capability (a layout never guards an action).
 * RLS remains the last line.
 */
export default async function InboxSegmentLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireCapability("inbox", "view");
  return <>{children}</>;
}
