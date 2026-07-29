"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { list, remove, readOfflineIdentity, type OfflineBlueprintMeta } from "@/lib/blueprints/offline-store";
// STATIC import (not next/dynamic): the viewer must ride in THIS route's own
// prefetchable chunk so `router.prefetch("/offline")` (run when a drawing is saved
// for offline) fetches it and the SW caches it. A per-route next/dynamic() lazy
// chunk is only fetched when /offline itself loads — which happens OFFLINE, too
// late to cache. pdf.js stays lazy (the viewer import()s it internally) and the
// viewer only renders on user action, so SSR of this public shell is unaffected.
import BlueprintViewer from "@/app/(app)/jobs/[id]/blueprints/_pdf-viewer";

/**
 * CrewFlow offline application shell (Programme F). A PUBLIC route (no auth, so it
 * renders with zero connectivity) precached by the service worker. When the app
 * is launched or deep-linked with no network, the SW serves this page instead of
 * the browser's network-error screen. It surfaces the drawings the user already
 * downloaded to THIS device (Programme E IndexedDB, scoped to the last active
 * user+org) and opens the REAL blueprint viewer from local bytes. It shows NO
 * server-fetched private data — only what Programme E deliberately persisted.
 */

type Open = { versionId: string; jobId: string; mime: string; drawingName: string; revision: string } | null;

export default function OfflinePage() {
  const [online, setOnline] = useState(true);
  const [items, setItems] = useState<OfflineBlueprintMeta[] | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const openBtn = useRef<HTMLButtonElement>(null);
  // Read ONCE, lazily. Calling readOfflineIdentity() during render returned a fresh
  // object every render, so `refresh` (useCallback dep [identity]) was new every
  // render and the useEffect([refresh]) below re-ran after every setItems — an
  // unbounded render + IndexedDB-read loop whenever an identity existed.
  const [identity] = useState(readOfflineIdentity);

  const refresh = useCallback(async () => {
    if (!identity) { setItems([]); return; }
    setItems(await list(identity.userId, identity.orgId));
  }, [identity]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const set = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    set();
    window.addEventListener("online", set); window.addEventListener("offline", set);
    return () => { window.removeEventListener("online", set); window.removeEventListener("offline", set); };
  }, []);

  const removeItem = async (m: OfflineBlueprintMeta) => {
    if (!identity) return;
    await remove(identity.userId, identity.orgId, m.versionId);
    await refresh();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-5 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-900 text-sm font-bold text-amber-400" aria-hidden>CF</span>
        <span className="text-lg font-bold text-slate-900">CrewFlow</span>
      </header>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
          <h1 className="text-xl font-bold text-slate-900">{online ? "Back online" : "You're offline"}</h1>
        </div>
        <p className="mt-1.5 text-sm text-slate-600" role="status" aria-live="polite">
          {online
            ? "Your connection is back. Return to CrewFlow to continue."
            : "No internet connection. You can still open drawings you've downloaded to this device."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/dashboard" className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">
            {online ? "Continue to CrewFlow" : "Retry connection"}
          </a>
        </div>
      </div>

      <section className="mt-6" aria-label="Offline drawings">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Drawings on this device</h2>
        {items === null ? (
          <p className="mt-2 text-sm text-slate-500">Checking…</p>
        ) : items.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No drawings downloaded {identity ? "for this account" : ""} yet. When you have a connection, open a drawing and choose <strong>Download for offline</strong>.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {items.map((m) => (
              <li key={m.versionId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{m.drawingName}</p>
                  <p className="text-xs text-slate-500">
                    {m.revision}{m.currentAtDownload ? "" : " (was current at download)"} · {(m.sizeBytes / 1_048_576).toFixed(1)} MB · downloaded {new Date(m.downloadedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button ref={openBtn} type="button" onClick={() => setOpen({ versionId: m.versionId, jobId: m.jobId, mime: m.mimeType, drawingName: m.drawingName, revision: m.revision })}
                    className="min-h-[44px] rounded-md bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800">Open</button>
                  <button type="button" onClick={() => removeItem(m)}
                    className="min-h-[44px] rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50">Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {open ? (
        <BlueprintViewer
          jobId={open.jobId}
          versionId={open.versionId}
          mime={open.mime}
          label={open.drawingName}
          drawingNumber={open.drawingName}
          revision={open.revision}
          supersededNotice={null}
          canDeletePins={false}
          identity={identity}
          onClose={() => { setOpen(null); openBtn.current?.focus(); }}
        />
      ) : null}
    </main>
  );
}
