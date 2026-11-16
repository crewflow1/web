import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Management-only route: requires the `fleet:view` capability (owner always; an admin only with the grant; plain staff never).
 * (D-17 least-privilege — segment guard; server actions and RLS re-check.)
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("fleet", "view");
  return <>{children}</>;
}
