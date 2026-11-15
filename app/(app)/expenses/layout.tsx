import type { ReactNode } from "react";
import { requireAnyCapability } from "@/server/auth/capabilities";

/**
 * Shared area: management (expenses) or the crew's field baseline (job_costs_field). Sensitive child routes carry a stricter guard.
 * (D-17 least-privilege — segment guard; server actions and RLS re-check.)
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireAnyCapability([["expenses", "view"], ["job_costs_field", "view"]]);
  return <>{children}</>;
}
