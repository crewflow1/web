import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (Role & Permissions R4 — capability enforcement).
 *
 * The whole Customers area requires the `customers:view` capability. OWNER
 * always passes (full access to their own org); an ADMIN passes only if the
 * owner granted them `customers:view` (or a broadening `customers:manage` /
 * wildcard); `staff` never hold a management capability (they reach a specific
 * customer/site only through an assigned job, enforced separately). A layout
 * wraps EVERY child route (list, `[id]` detail, `new`, nested tabs), so a denied
 * member cannot reach any sub-page by URL. Nav-hiding is presentation only; this
 * is the server boundary; RLS remains the last line. requireCapability redirects
 * a denied caller to /dashboard?error=forbidden — never a 500, never a blank page.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("customers", "view");
  return <>{children}</>;
}
