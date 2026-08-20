"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isPhotoQueueSupported,
  listPhotosForPartition,
  markPhotoAttemptFailed,
  markPhotoRejected,
  purgeForeignPhotos,
  removeQueuedPhoto,
  type QueuedPhoto,
} from "@/lib/offline/photo-queue";
import { syncQueuedPhoto } from "@/app/(app)/offline-photo-sync-actions";

/**
 * THE PHOTO OUTBOX — the honest status of every binary capture authored with no
 * signal, and the BACKGROUND-SYNC trigger that flushes it on reconnect.
 *
 * Mounted in the authenticated app layout, so `userId`/`orgId` are the identity the
 * SERVER resolved (`requireOrgContext()`), never read back from the browser — the
 * same shared-device discipline as the JSON write outbox. The photo queue is
 * partitioned by `userId::orgId`; this component only ever reads its own partition.
 *
 * Renders NOTHING when the queue is empty (the common case).
 *
 * ── Flush discipline (mirrors the write outbox) ──────────────────────────────
 * - Drains in seq order and STOPS on the first transient failure, so a dead
 *   network does not burn through 100 doomed multipart uploads.
 * - One flush at a time (`busy` ref). Two tabs are still safe: the DB unique index
 *   on (org_id, client_write_key) is the real duplicate guarantee, and a second
 *   delivery returns "duplicate", not a second attachment.
 * - A THROWN action (expired cookie → requireOrgContext redirects) is TRANSIENT: a
 *   signed-out moment must never destroy a captured photo.
 *
 * ── Background sync ──────────────────────────────────────────────────────────
 * Flushes on: mount, `online`, tab foreground (a pocketed phone fires no `online`
 * on wake), a custom `crewflow:photo-outbox-changed` event (fired right after a
 * capture is queued), AND a periodic timer (a long drive back into coverage that
 * fires no event still drains). If the browser supports the Background Sync API a
 * one-off sync is also registered, but the timer + events are the guarantee.
 */

type Phase = "idle" | "syncing";

export function OfflinePhotoOutbox({
  userId,
  orgId,
}: {
  userId: string;
  orgId: string;
}) {
  const [items, setItems] = useState<QueuedPhoto[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    setItems(await listPhotosForPartition(userId, orgId));
  }, [userId, orgId]);

  const flush = useCallback(async () => {
    if (busy.current || !isPhotoQueueSupported()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    busy.current = true;
    try {
      const pending = (await listPhotosForPartition(userId, orgId)).filter(
        (i) => i.status === "pending",
      );
      if (pending.length === 0) return;
      setPhase("syncing");
      let sent = 0;
      for (const item of pending) {
        try {
          const bytes = new Uint8Array(await item.blob.arrayBuffer());
          const outcome = await syncQueuedPhoto({
            clientKey: item.clientKey,
            orgId: item.orgId,
            targetTable: item.targetTable,
            targetId: item.targetId,
            filename: item.filename,
            mimeType: item.mimeType,
            bytes,
            authoredAt: item.authoredAt,
          });
          if (outcome.status === "accepted" || outcome.status === "duplicate") {
            // The ONLY delete path — the idempotency key did its job.
            await removeQueuedPhoto(item.key);
            sent += 1;
            continue;
          }
          if (outcome.status === "rejected") {
            await markPhotoRejected(item.key, outcome.reason);
            continue; // permanent for THIS capture; later ones may be fine
          }
          // transient — keep ordering, stop the drain here
          await markPhotoAttemptFailed(item.key, outcome.reason);
          break;
        } catch {
          await markPhotoAttemptFailed(item.key, "unreachable");
          break;
        }
      }
      if (sent > 0) setUploadedCount((n) => n + sent);
    } finally {
      busy.current = false;
      setPhase("idle");
      await reload();
    }
  }, [userId, orgId, reload]);

  // Mount: shared-device purge FIRST, then load + drain.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await purgeForeignPhotos(userId);
      if (cancelled) return;
      await reload();
      if (cancelled) return;
      await flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reload, flush]);

  // Background-sync triggers.
  useEffect(() => {
    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    const onChanged = () => void reload().then(() => flush());
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("crewflow:photo-outbox-changed", onChanged);
    // A long-lived session that never fires an event still drains periodically.
    const timer = window.setInterval(() => void flush(), 60_000);
    // Best-effort Background Sync registration (extra, not the guarantee).
    void (async () => {
      try {
        const reg = await navigator.serviceWorker?.ready;
        await (
          reg as unknown as { sync?: { register: (t: string) => Promise<void> } }
        )?.sync?.register("crewflow-photo-flush");
      } catch {
        /* Background Sync unavailable — the timer + events cover it */
      }
    })();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("crewflow:photo-outbox-changed", onChanged);
      window.clearInterval(timer);
    };
  }, [flush, reload]);

  const pending = items.filter((i) => i.status === "pending");
  const rejected = items.filter((i) => i.status === "rejected");

  if (items.length === 0 && uploadedCount === 0) return null;

  if (items.length === 0) {
    return (
      <div
        role="status"
        data-photo-outbox-uploaded
        className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-center text-xs font-medium text-emerald-900"
      >
        ✓ {uploadedCount} offline {uploadedCount === 1 ? "photo" : "photos"} uploaded
        to CrewFlow.
      </div>
    );
  }

  const tone = rejected.length
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div
      data-photo-outbox
      data-photo-outbox-pending={pending.length}
      data-photo-outbox-rejected={rejected.length}
      className={`border-b ${tone}`}
    >
      <div className="container flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
        <p className="min-w-0 flex-1 text-xs font-medium" role="status" aria-live="polite">
          {phase === "syncing" ? (
            <>Uploading photos…</>
          ) : rejected.length > 0 ? (
            <>
              <strong>
                {rejected.length}{" "}
                {rejected.length === 1 ? "photo was" : "photos were"} not accepted
              </strong>
              {pending.length > 0 ? ` · ${pending.length} still to upload.` : ""}
            </>
          ) : (
            <>
              <strong>
                {pending.length} {pending.length === 1 ? "photo" : "photos"} saved on
                this device
              </strong>{" "}
              — will upload when you get a signal. Don&apos;t sign out first.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => void flush()}
          disabled={phase === "syncing" || pending.length === 0}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white/70 px-3 text-xs font-semibold disabled:opacity-50"
        >
          Upload now
        </button>
      </div>
    </div>
  );
}
