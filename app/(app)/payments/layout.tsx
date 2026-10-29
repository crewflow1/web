import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (Role & Permissions R4 — capability enforcement).
 *
 * The whole Payments area requires the `payments:view` capability. OWNER always
 * passes; an ADMIN passes only if granted `payments:view` (or a broadening
 * `payments:manage` / wildcard); staff never hold a management capability. The
 * layout wraps every child route (list, new, reconcile), so this is the page
 * boundary for the module; the server actions re-check the capability for the
 * POST path. Nav-hiding is presentation only; RLS is the last line.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("payments", "view");
  return <>{children}</>;
}
