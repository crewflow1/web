import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (Role & Permissions R4 — capability enforcement).
 *
 * The whole CIS area requires the `cis:view` capability. OWNER always passes
 * (full access to their own org); an ADMIN passes only if the owner granted them
 * `cis:view` (or a broadening `cis:manage` / wildcard); `staff` never hold a
 * management capability. A layout wraps EVERY child route (list, statements,
 * nested tabs), so no one reaches a sub-page by URL without the capability.
 * Nav-hiding is presentation only; this is the server boundary; the admin-only
 * RLS on every CIS table remains the last line. requireCapability redirects a
 * denied caller to /dashboard?error=forbidden — never a 500, never a blank page.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("cis", "view");
  return <>{children}</>;
}
