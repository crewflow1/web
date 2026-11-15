import type { ReactNode } from "react";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * Segment authorization guard (least-privilege enforcement).
 *
 * The cross-job Variations register is priced scope change — company financial
 * data, hidden from `staff` in the navigation. It requires `quotes:view` (owner
 * always; an admin with the grant; never staff). A site-raised variation
 * REQUEST stays available to assigned staff from the job workspace
 * (/jobs/[id]/variations/new), which is a different route.
 */
export default async function Layout({ children }: { children: ReactNode }) {
  await requireCapability("quotes", "view");
  return <>{children}</>;
}
