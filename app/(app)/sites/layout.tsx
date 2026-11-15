import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (least-privilege enforcement — same construction
 * as the R4 money modules, e.g. app/(app)/customers/layout.tsx).
 *
 * Sites is hidden from `staff` in the navigation, but hiding a menu item is
 * not a control: until this guard every page here rendered for a staff member
 * who typed the URL. The whole area now requires the `sites:view` capability.
 * OWNER always passes; an ADMIN passes only with the grant (or a broadening
 * `sites:manage` / wildcard); `staff` never hold a capability. A layout wraps
 * EVERY child route, so no sub-page is reachable by URL. The server actions
 * re-check the capability themselves (a server action is a plain POST), and
 * RLS / column ACLs remain the last line (migrations 20261340–20261343).
 * requireCapability redirects a denied caller to /dashboard?error=forbidden —
 * which forwards a staff member to /me — never a 500, never a blank page.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("sites", "view");
  return <>{children}</>;
}
