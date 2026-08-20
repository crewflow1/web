"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  isReadCacheSupported,
  purgeForeignReads,
  putSnapshot,
} from "@/lib/offline/read-cache";
import { fetchOfflineReadSnapshots } from "@/app/(app)/offline-read-actions";

/**
 * OFFLINE READ CACHE hydrator.
 *
 * Mounted once in the authenticated app layout, so `userId`/`orgId` are the
 * identity the SERVER resolved for this request (`requireOrgContext()`), never a
 * value read back out of the browser — the same shared-device discipline the
 * write outbox uses. It renders nothing; its whole job is to keep the device's
 * offline read cache warm so pages still show something with no signal.
 *
 * Lifecycle:
 *   - on mount: purge any OTHER user's cached snapshots FIRST (shared-device
 *     gate), then hydrate this session's cache if we are online;
 *   - re-hydrate when connectivity returns, when the tab returns to the
 *     foreground (a pocketed phone fires no `online` on wake), and on a slow
 *     periodic timer so a long-lived session keeps a fresh copy.
 *
 * Hydration is best-effort and quiet: a snapshot is a re-downloadable copy, so a
 * failed refresh simply leaves the previous copy in place. It never touches the
 * WRITE queue and always leaves it quota headroom (read-cache.ts refuses rather
 * than evict), so warming the read cache can never cost a foreman his unsent work.
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function OfflineReadCache({
  userId,
  orgId,
}: {
  userId: string;
  orgId: string;
}) {
  const busy = useRef(false);

  const hydrate = useCallback(async () => {
    if (busy.current || !isReadCacheSupported()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    busy.current = true;
    try {
      const snapshots = await fetchOfflineReadSnapshots();
      for (const snap of snapshots) {
        await putSnapshot({
          userId,
          orgId,
          kind: snap.kind,
          rows: snap.rows,
          // A full page means the server had at least one more row → partial cache.
          serverTotal: snap.full ? Number.MAX_SAFE_INTEGER : snap.rows.length,
        });
      }
    } catch {
      /* best-effort: an expired session or a dead network leaves the prior copy */
    } finally {
      busy.current = false;
    }
  }, [userId, orgId]);

  // Mount: shared-device purge FIRST, then hydrate.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await purgeForeignReads(userId);
      if (cancelled) return;
      await hydrate();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, hydrate]);

  // Re-hydrate on reconnect, foreground, and a slow periodic timer.
  useEffect(() => {
    const onOnline = () => void hydrate();
    const onVisible = () => {
      if (document.visibilityState === "visible") void hydrate();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void hydrate(), REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [hydrate]);

  return null;
}
