import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (Role & Permissions R4 — capability enforcement).
 *
 * The whole Reports area requires the `reports:view` capability. OWNER always
 * passes (full access to their own org); an ADMIN passes only if the owner
 * granted them `reports:view` (or a broadening `reports:manage` / wildcard);
 * `staff` never hold a management capability. A layout wraps EVERY child route
 * (dashboard, ageing, cashflow, pipeline, profit, retention, utilisation,
 * accounting, subscribe), so no one reaches a sub-page by URL without the
 * capability. Nav-hiding is presentation only; this is the server boundary; RLS
 * remains the last line. requireCapability redirects a denied caller to
 * /dashboard?error=forbidden — never a 500, never a blank page.
 *
 * NOTE: the shared report EXPORT API (/api/reports/[report]/export) is NOT under
 * this layout and keeps its own per-report sensitivity gate (non-management
 * reports stay member-exportable; management-only reports require reports:export).
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("reports", "view");
  return <>{children}</>;
}
