import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (R4) — requires price_book:view. A layout wraps
 * every child route (list, detail, nested tabs), so a member without the
 * capability cannot reach any sub-page by URL. Owner passes unconditionally; an
 * admin needs the grant; staff/members are denied (prices are a money boundary).
 * RLS remains the last line.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("price_book", "view");
  return <>{children}</>;
}
