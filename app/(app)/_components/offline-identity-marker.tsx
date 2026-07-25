"use client";

import { useEffect } from "react";
import { writeOfflineIdentity } from "@/lib/blueprints/offline-store";

/**
 * Records the active user+org (opaque UUIDs — not secrets) so the offline shell
 * can scope its IndexedDB read when there is no server session. Cleared on
 * logout by SignOutButton. Renders nothing.
 */
export function OfflineIdentityMarker({ userId, orgId }: { userId: string; orgId: string }) {
  useEffect(() => { writeOfflineIdentity(userId, orgId); }, [userId, orgId]);
  return null;
}
