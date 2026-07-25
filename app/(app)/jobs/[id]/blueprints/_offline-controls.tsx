"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { put, getByVersion, list, remove, isOfflineSupported, type OfflineBlueprintMeta } from "@/lib/blueprints/offline-store";

/**
 * Per-drawing offline control on the register card (Programme E). Downloads the
 * CURRENT revision's authorized BYTES (via the same RLS-gated /f/[versionId]
 * route) into IndexedDB so the viewer renders it offline. Shows explicit states
 * (§10), the stale-revision warning (§17), and Remove (§22). No signed URL is
 * ever stored — only bytes + safe metadata. 44px targets, aria-live.
 */

type Drawing = {
  jobId: string; blueprintId: string;
  currentVersionId: string; currentVersion: number; currentRevision: string;
  drawingName: string; fileName: string; mimeType: string;
};
type Identity = { userId: string; orgId: string } | null;
type State = "checking" | "not-cached" | "downloading" | "available" | "stale" | "removing" | "error";

export function OfflineControls({ drawing, identity }: { drawing: Drawing; identity: Identity }) {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [cached, setCached] = useState<OfflineBlueprintMeta | null>(null); // any cached revision of this drawing
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!identity || !isOfflineSupported()) { setState("not-cached"); return; }
    const currentMeta = await getByVersion(identity.userId, identity.orgId, drawing.currentVersionId);
    if (currentMeta) { setCached(currentMeta); setState("available"); return; }
    const all = await list(identity.userId, identity.orgId);
    const older = all.filter((m) => m.blueprintId === drawing.blueprintId).sort((a, b) => b.version - a.version)[0];
    if (older) { setCached(older); setState("stale"); return; }
    setCached(null); setState("not-cached");
  }, [identity, drawing.currentVersionId, drawing.blueprintId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const download = useCallback(async () => {
    if (!identity) return;
    setState("downloading"); setError("");
    try {
      const res = await fetch(`/jobs/${drawing.jobId}/blueprints/f/${drawing.currentVersionId}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const bytes = await res.arrayBuffer();
      const r = await put({
        userId: identity.userId, orgId: identity.orgId, bytes,
        descriptor: {
          jobId: drawing.jobId, blueprintId: drawing.blueprintId, versionId: drawing.currentVersionId, version: drawing.currentVersion,
          revision: drawing.currentRevision, revisionDate: null, drawingName: drawing.drawingName,
          fileName: drawing.fileName, mimeType: drawing.mimeType, currentAtDownload: true,
        },
      });
      if (!r.ok) {
        setError(r.error === "quota_exceeded" ? "Not enough device storage to save this drawing offline." : r.error === "too_large" ? "This drawing is too large to save offline." : "Download failed.");
        setState("error"); return;
      }
      // Warm the offline-critical code so "Available offline" truly means openable
      // offline: the SW caches the /offline shell route + the viewer + pdf.js chunks
      // + the pdf.js render WORKER (the viewer paints nothing without it) — opt-in on
      // download, no eager per-page cost. Best-effort, time-bounded.
      try {
        router.prefetch("/offline");
        if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
          await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(res, 4000))]);
        }
        await Promise.allSettled([
          import("./_pdf-viewer"),
          import("pdfjs-dist"),
          // fully drain the worker body so the SW's cache-first clone finishes writing
          fetch("/pdf.worker.min.mjs", { credentials: "same-origin" }).then((r) => r.blob()),
        ]);
      } catch { /* warming is best-effort */ }
      await refresh();
    } catch {
      setError("Download failed — check your connection."); setState("error");
    }
  }, [identity, drawing, refresh, router]);

  const removeDownload = useCallback(async (versionId: string) => {
    if (!identity) return;
    setState("removing");
    await remove(identity.userId, identity.orgId, versionId);
    await refresh();
  }, [identity, refresh]);

  if (!identity || (state === "not-cached" && !isOfflineSupported())) return null;

  const btn = "min-h-[44px] rounded-md border border-slate-300 px-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" aria-live="polite" data-offline-controls>
      {state === "checking" ? <span className="text-xs text-slate-400">…</span> : null}

      {state === "not-cached" ? (
        <button type="button" onClick={download} className={btn}>⤓ Download for offline</button>
      ) : null}

      {state === "downloading" ? <span className="text-xs text-slate-500">Downloading…</span> : null}
      {state === "removing" ? <span className="text-xs text-slate-500">Removing…</span> : null}

      {state === "available" && cached ? (
        <>
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800" data-offline-available>✓ Available offline · {cached.revision}</span>
          <button type="button" onClick={() => removeDownload(cached.versionId)} className={btn}>Remove</button>
        </>
      ) : null}

      {state === "stale" && cached ? (
        <>
          <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900" role="status">
            ⚠ Offline copy: {cached.revision}. {drawing.currentRevision} is now current.
          </span>
          <button type="button" onClick={download} className={btn}>Download {drawing.currentRevision}</button>
          <button type="button" onClick={() => removeDownload(cached.versionId)} className={btn}>Remove</button>
        </>
      ) : null}

      {state === "error" ? (
        <>
          <span className="text-[11px] font-medium text-red-700" role="alert">{error}</span>
          <button type="button" onClick={download} className={btn}>Retry</button>
        </>
      ) : null}
    </span>
  );
}
