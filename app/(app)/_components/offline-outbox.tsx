"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isWriteQueueSupported,
  listForPartition,
  markAttemptFailed,
  markRejected,
  purgeForeignUsers,
  removeQueued,
  type QueuedWrite,
} from "@/lib/offline/write-queue";
import { offlineWriteEntity } from "@/lib/offline/registry";
import { syncQueuedWrite } from "@/app/(app)/offline-sync-actions";

/**
 * THE OUTBOX — the honest status of every write authored with no signal.
 *
 * Mounted in the authenticated app layout, so `userId`/`orgId` are the identity the
 * SERVER resolved for this request (`requireOrgContext()`), never a value read back
 * out of the browser. That distinction is the whole shared-device story: the queue
 * is partitioned by `userId::orgId`, and this component only ever reads its own
 * partition, so user B's session can neither see nor flush user A's unsent work.
 *
 * Renders NOTHING when the queue is empty, which is almost always.
 *
 * ── What it guarantees the user ───────────────────────────────────────────────
 * Two states exist and are never conflated:
 *   "saved on this device"  — in IndexedDB, the server has never seen it;
 *   "synced"               — the server accepted it and it is in the diary.
 * Anything the server PERMANENTLY refuses becomes a third, loud state: the item is
 * KEPT, its content is shown so the words can be copied, and only the user's
 * explicit "Discard" deletes it. Nothing is ever silently dropped.
 *
 * ── Flush discipline ─────────────────────────────────────────────────────────
 * - Drains in `seq` order and STOPS on the first transient failure, so ordering is
 *   preserved and a dead network does not burn through 200 doomed requests.
 * - One flush at a time (`busy` ref). Two tabs are still possible, and that is
 *   fine: the database's unique index on (org_id, client_write_key) is the real
 *   duplicate guarantee, and a second delivery returns "duplicate", not a new row.
 * - A THROWN action (expired cookie → `requireOrgContext()` redirects, which
 *   surfaces here as a rejected promise) is TRANSIENT. A signed-out moment must
 *   never destroy queued work.
 */

type Phase = "idle" | "syncing";

export function OfflineOutbox({
  userId,
  orgId,
}: {
  userId: string;
  orgId: string;
}) {
  const [items, setItems] = useState<QueuedWrite[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);
  const [syncedCount, setSyncedCount] = useState(0);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    setItems(await listForPartition(userId, orgId));
  }, [userId, orgId]);

  const flush = useCallback(async () => {
    if (busy.current || !isWriteQueueSupported()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    busy.current = true;
    try {
      const pending = (await listForPartition(userId, orgId)).filter(
        (i) => i.status === "pending",
      );
      if (pending.length === 0) return;
      setPhase("syncing");
      let sent = 0;
      for (const item of pending) {
        try {
          const outcome = await syncQueuedWrite({
            clientKey: item.clientKey,
            kind: item.kind,
            orgId: item.orgId,
            payload: item.payload,
            authoredAt: item.authoredAt,
          });
          if (outcome.status === "accepted" || outcome.status === "duplicate") {
            // The ONLY delete path. "duplicate" means the row already exists — the
            // idempotency key did its job, so the item is done, not lost.
            await removeQueued(item.key);
            sent += 1;
            continue;
          }
          if (outcome.status === "rejected") {
            await markRejected(item.key, outcome.reason);
            continue; // permanent for THIS item; later items may still be fine
          }
          // transient — keep ordering, stop the drain here
          await markAttemptFailed(item.key, outcome.reason);
          break;
        } catch {
          // Network died mid-flush, or the session expired and the action
          // redirected. Either way: transient, content untouched, stop draining.
          await markAttemptFailed(item.key, "unreachable");
          break;
        }
      }
      if (sent > 0) setSyncedCount((n) => n + sent);
    } finally {
      busy.current = false;
      setPhase("idle");
      await reload();
    }
  }, [userId, orgId, reload]);

  // Mount: shared-device purge FIRST (before this session can flush anything),
  // then load our own partition and try to drain it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      /**
       * SHARED-DEVICE GATE. Deletes every queued item belonging to a DIFFERENT
       * user, using the server-trusted id above. This covers what the sign-out
       * purge cannot: a session that simply expired, or a tablet closed and handed
       * over, followed by someone else signing in. Runs before any flush, so a
       * foreign item can never be sent under this session even for one request.
       */
      await purgeForeignUsers(userId);
      if (cancelled) return;
      await reload();
      if (cancelled) return;
      await flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reload, flush]);

  // Retry when connectivity returns, when the tab comes back to the foreground
  // (a phone that was in a pocket fires no `online` event on wake), and when the
  // diary form has just queued something.
  useEffect(() => {
    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    const onChanged = () => void reload().then(() => flush());
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("crewflow:outbox-changed", onChanged);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("crewflow:outbox-changed", onChanged);
    };
  }, [flush, reload]);

  const pending = items.filter((i) => i.status === "pending");
  const rejected = items.filter((i) => i.status === "rejected");

  // Nothing queued and nothing to confess → render nothing at all.
  if (items.length === 0 && syncedCount === 0) return null;

  if (items.length === 0) {
    return (
      <div
        role="status"
        data-outbox-synced
        className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-center text-xs font-medium text-emerald-900"
      >
        ✓ {syncedCount} offline {syncedCount === 1 ? "entry" : "entries"} synced to
        CrewFlow.
      </div>
    );
  }

  const tone = rejected.length
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div
      data-outbox
      data-outbox-pending={pending.length}
      data-outbox-rejected={rejected.length}
      className={`border-b ${tone}`}
    >
      <div className="container flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
        <p className="min-w-0 flex-1 text-xs font-medium" role="status" aria-live="polite">
          {phase === "syncing" ? (
            <>Syncing…</>
          ) : rejected.length > 0 ? (
            <>
              <strong>
                {rejected.length}{" "}
                {rejected.length === 1 ? "entry was" : "entries were"} not accepted
              </strong>{" "}
              — open to copy the text before discarding.
              {pending.length > 0 ? ` ${pending.length} still waiting to sync.` : ""}
            </>
          ) : (
            <>
              <strong>
                {pending.length} {pending.length === 1 ? "entry" : "entries"} saved on
                this device
              </strong>{" "}
              — not sent yet. Keep the app open when you get a signal, and don&apos;t
              sign out.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white/70 px-3 text-xs font-semibold"
        >
          {open ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          onClick={() => void flush()}
          disabled={phase === "syncing" || pending.length === 0}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white/70 px-3 text-xs font-semibold disabled:opacity-50"
        >
          Sync now
        </button>
      </div>

      {open ? (
        <ul className="container space-y-2 pb-3">
          {items.map((item) => (
            <OutboxItem key={item.key} item={item} onChanged={reload} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const REJECT_REASON: Record<string, string> = {
  invalid_payload:
    "The server wouldn't accept these values (check the date). Copy the text below and re-enter it.",
  job_missing:
    "The job this was filed against no longer exists in this company. Copy the text below and re-enter it against a current job.",
  org_mismatch:
    "This was written for a different company. It has NOT been filed anywhere. Copy the text below and re-enter it in the right company.",
  not_permitted:
    "You no longer have permission to add entries here. Copy the text below before discarding.",
  unknown_kind: "This kind of entry can't be synced. Copy the text below.",
  malformed_item: "This saved entry is unreadable. Copy anything useful below.",
};

/**
 * One queued item. A REJECTED item shows its full content: the server refused it,
 * so this browser holds the only copy of what the foreman wrote, and destroying it
 * to keep the UI tidy would be the exact data loss this feature is meant to prevent.
 */
function OutboxItem({
  item,
  onChanged,
}: {
  item: QueuedWrite;
  onChanged: () => Promise<void>;
}) {
  const entity = offlineWriteEntity(item.kind);
  const rejected = item.status === "rejected";
  const text = entity.recoverFields
    .map((f) => {
      const v = item.payload[f];
      return v === undefined || v === null || v === "" ? null : `${f}: ${String(v)}`;
    })
    .filter(Boolean)
    .join("\n");

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 text-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold">
            {entity.label}
            {" · "}
            <span className="font-normal text-slate-500">
              written {new Date(item.authoredAt).toLocaleString()} on this device
            </span>
          </p>
          <p
            className={`mt-0.5 text-xs font-medium ${rejected ? "text-red-700" : "text-amber-800"}`}
          >
            {rejected
              ? `Not accepted — ${REJECT_REASON[item.lastError ?? ""] ?? "the server refused it."}`
              : item.attempts > 0
                ? `Waiting to sync · ${item.attempts} attempt${item.attempts === 1 ? "" : "s"} so far`
                : "Waiting to sync"}
          </p>
        </div>
        {rejected ? (
          <button
            type="button"
            onClick={async () => {
              // Explicit, per-item, and only ever reachable for a rejected entry
              // whose text is on screen right now.
              if (
                !window.confirm(
                  "Delete this entry from the device? The text above will be gone for good.",
                )
              )
                return;
              await removeQueued(item.key);
              await onChanged();
            }}
            className="min-h-[44px] shrink-0 rounded-md border border-red-300 px-3 text-xs font-semibold text-red-700"
          >
            Discard
          </button>
        ) : null}
      </div>
      {rejected && text ? (
        <pre
          data-outbox-recover
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-700"
        >
          {text}
        </pre>
      ) : null}
    </li>
  );
}
