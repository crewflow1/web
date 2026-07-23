"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitScale, clampZoom, bitmapScale, type FitMode } from "@/lib/blueprints/viewer";

/**
 * DrawingRenderSurface (Programme D) — the reusable render CORE for ONE
 * (versionId, page). Owns the fetch-once byte flow, the hardened pdf.js/image
 * render pipeline (isEvalSupported:false, enableXfa:false, disableAutoFetch:true,
 * worker, DPR + max-side caps, cancellable RenderTask, destroy-on-unmount), and
 * a controlled fit/zoom/pan transform so two surfaces can be driven in lockstep
 * for side-by-side + overlay comparison. Pins/markup/toolbar/keyboard live in the
 * parent — this component is only the engine + a slot for read-only overlays.
 *
 * NB: the render logic mirrors _pdf-viewer.tsx's proven core. The two are kept
 * as siblings deliberately (Programme D protects the green tri-feature viewer by
 * NOT refactoring its internals); a later pass may consolidate the viewer onto
 * this surface once compare has soaked. Any change to the hardened getDocument
 * options must be mirrored in both.
 */

const MAX_CANVAS_PX_DEFAULT = 4096;

export type MemoryTier = "full" | "compare-sxs" | "compare-overlay";
const TIERS: Record<MemoryTier, { dprCap: number; maxSide: number }> = {
  full: { dprCap: 2, maxSide: 4096 },
  "compare-sxs": { dprCap: 1.5, maxSide: 4096 },
  "compare-overlay": { dprCap: 1, maxSide: 3072 },
};

export type SurfacePhase = "loading" | "ready" | "error";
export type SurfaceState = { phase: SurfacePhase; pageCount: number; intrinsic: { w: number; h: number } };

export type DrawingRenderSurfaceProps = {
  jobId: string;
  versionId: string;
  mime: string;
  page: number; // 0-based
  fit: FitMode;
  zoom: number;
  pan: { x: number; y: number };
  opacity?: number;
  visible?: boolean; // overlay layer hidden without unmounting (keeps the doc warm)
  memoryTier?: MemoryTier;
  blend?: boolean; // difference mode → CSS mix-blend-mode on the positioner
  label: string;
  onState?: (s: SurfaceState) => void;
  children?: React.ReactNode; // read-only annotation overlays, positioned in the page box
};

export default function DrawingRenderSurface(props: DrawingRenderSurfaceProps) {
  const { jobId, versionId, mime, page, fit, zoom, pan, opacity = 1, visible = true, memoryTier = "full", blend = false, label, onState } = props;
  const isImage = mime.startsWith("image/");
  const src = `/jobs/${jobId}/blueprints/f/${versionId}`;
  const cap = TIERS[memoryTier];

  const rootRef = useRef<HTMLDivElement>(null);
  const pageBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderTaskRef = useRef<any>(null);
  const intrinsicRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const objUrlRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<SurfacePhase>("loading");
  const [pageCount, setPageCount] = useState(1);

  const report = useCallback((p: SurfacePhase) => {
    onState?.({ phase: p, pageCount, intrinsic: intrinsicRef.current });
  }, [onState, pageCount]);

  // --- load once per versionId (fetch bytes → pdf.js/image) -------------------
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    (async () => {
      try {
        const res = await fetch(src, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        if (isImage) {
          const url = URL.createObjectURL(new Blob([buf], { type: mime }));
          objUrlRef.current = url;
          const img = imgRef.current!;
          img.onload = () => {
            if (cancelled) return;
            intrinsicRef.current = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
            setPageCount(1); setPhase("ready");
          };
          img.onerror = () => { URL.revokeObjectURL(url); if (!cancelled) setPhase("error"); };
          img.src = url;
          return;
        }
        const pdfjs = await import("pdfjs-dist");
        if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false, disableAutoFetch: true });
        const doc = await task.promise;
        if (cancelled) { doc.destroy(); return; }
        pdfRef.current = doc;
        setPageCount(doc.numPages); setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
      pdfRef.current?.destroy?.();
      pdfRef.current = null;
      if (objUrlRef.current) { URL.revokeObjectURL(objUrlRef.current); objUrlRef.current = null; }
      const c = canvasRef.current;
      if (c) { c.width = 0; c.height = 0; } // free the iOS backing store immediately
    };
  }, [src, isImage, mime]);

  useEffect(() => { report(phase); }, [phase, report]);

  const computeLayoutScale = useCallback((): number => {
    const root = rootRef.current;
    if (!root) return 1;
    const base = fitScale({ w: root.clientWidth || 1, h: root.clientHeight || 1 }, intrinsicRef.current, fit);
    return clampZoom(base * zoom);
  }, [fit, zoom]);

  const renderPdfPage = useCallback(async () => {
    const doc = pdfRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    renderTaskRef.current?.cancel?.();
    try {
      const pg = await doc.getPage(page + 1);
      const unit = pg.getViewport({ scale: 1 });
      intrinsicRef.current = { w: unit.width, h: unit.height };
      const layoutScale = computeLayoutScale();
      let renderScale = bitmapScale(layoutScale, Math.min(cap.dprCap, window.devicePixelRatio || 1));
      const maxSide = Math.max(unit.width, unit.height) * renderScale;
      if (maxSide > cap.maxSide) renderScale *= cap.maxSide / maxSide;
      const vp = pg.getViewport({ scale: renderScale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(unit.width * layoutScale)}px`;
      canvas.style.height = `${Math.floor(unit.height * layoutScale)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = pg.render({ canvasContext: ctx, viewport: vp });
      renderTaskRef.current = task;
      await task.promise;
      canvas.setAttribute("data-rendered-page", String(page + 1));
      onState?.({ phase: "ready", pageCount, intrinsic: intrinsicRef.current });
    } catch (e) {
      if ((e as { name?: string })?.name !== "RenderingCancelledException") setPhase("error");
    }
  }, [page, computeLayoutScale, cap.dprCap, cap.maxSide, onState, pageCount]);

  useLayoutEffect(() => { if (phase === "ready" && !isImage) void renderPdfPage(); }, [phase, isImage, renderPdfPage]);
  useLayoutEffect(() => {
    if (phase === "ready" && isImage && imgRef.current) {
      const s = computeLayoutScale();
      imgRef.current.style.width = `${Math.floor(intrinsicRef.current.w * s)}px`;
      imgRef.current.style.height = `${Math.floor(intrinsicRef.current.h * s)}px`;
    }
  }, [phase, isImage, computeLayoutScale]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (isImage && imgRef.current) { const s = computeLayoutScale(); imgRef.current.style.width = `${Math.floor(intrinsicRef.current.w * s)}px`; imgRef.current.style.height = `${Math.floor(intrinsicRef.current.h * s)}px`; } else void renderPdfPage(); }, 120);
    });
    ro.observe(root);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [isImage, renderPdfPage, computeLayoutScale]);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden" data-drawing-surface aria-label={label}>
      {phase === "loading" ? (
        <div className="absolute inset-0 grid place-items-center"><div className="h-40 w-56 animate-pulse rounded bg-slate-700" aria-hidden /></div>
      ) : null}
      {phase === "error" ? (
        <div role="alert" className="absolute inset-0 grid place-items-center p-4">
          <div className="max-w-xs rounded-lg border border-red-300 bg-white p-4 text-center text-sm">
            <p className="font-medium text-slate-900">Couldn&apos;t render {label}.</p>
            <a href={src} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white">Open / download</a>
          </div>
        </div>
      ) : null}
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
          opacity, visibility: phase === "ready" && visible ? "visible" : "hidden",
          mixBlendMode: blend ? "difference" : undefined,
        }}
      >
        <div ref={pageBoxRef} className="relative">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img ref={imgRef} alt={label} className="block max-w-none bg-white shadow-2xl" draggable={false} />
          ) : (
            <canvas ref={canvasRef} role="img" aria-label={`${label}, sheet ${page + 1} of ${pageCount}`} className="block bg-white shadow-2xl" />
          )}
          {props.children}
        </div>
      </div>
    </div>
  );
}

export { MAX_CANVAS_PX_DEFAULT };
