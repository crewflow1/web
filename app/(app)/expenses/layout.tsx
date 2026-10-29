import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (Role & Permissions R4 — capability enforcement).
 *
 * The whole Expenses area requires the `expenses:view` capability. OWNER always
 * passes; an ADMIN passes only if granted `expenses:view` (or a broadening
 * `expenses:manage` / wildcard); staff never hold a management capability. The
 * layout wraps every child route (list, new, budgets); server actions re-check
 * their own capability for the POST path. Nav-hiding is presentation only; RLS
 * is the last line.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("expenses", "view");
  return <>{children}</>;
}
