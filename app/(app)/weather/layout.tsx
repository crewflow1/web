import type { ReactNode } from "react";
import { requireAnyCapability } from "@/server/auth/capabilities";

/**
 * Site duties area: management (site_safety) or the crew's field baseline (site_safety_field).
 * (D-17 least-privilege — segment guard; server actions and RLS re-check.)
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireAnyCapability([["site_safety", "view"], ["site_safety_field", "view"]]);
  return <>{children}</>;
}
