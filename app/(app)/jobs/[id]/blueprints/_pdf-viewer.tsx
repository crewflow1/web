"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fitScale, clampZoom, zoomStep, bitmapScale, clampPage,
  type FitMode,
} from "@/lib/blueprints/viewer";
import {
  pointerToNormalized, isTap, pinsForSheet, filterPins, toStoredPage, DEFAULT_PIN_FILTER,
  type BlueprintPin,
} from "@/lib/blueprints/pins";
import { getPinsAction, getLinkableSnagsAction } from "./pin-actions";
import { PinMarker, DraftMarker, PlacementSheet, PinDetail, FilterChips } from "./_pins-ui";
import {
  appendSample, simplifyStroke, isDegenerate, markupForSheet,
  type BlueprintMarkup, type MarkupKind, type Norm,
} from "@/lib/blueprints/markup";
import { getMarkupAction, createMarkupAction, removeMarkupAction, deleteMarkupAction } from "./markup-actions";
import { MarkupShape, MarkupTextLayer, MarkupTextInput, MarkupToolbar, MARKUP_COLORS, MARKUP_WIDTHS, type MarkupTool } from "./_markup-ui";

type ViewerMode = "view" | "pin" | "markup";

/** SVG path `d` for the live (in-progress) shape preview, in the 0..1 viewBox. */
function toPathD(kind: MarkupKind, pts: Norm[]): string {
  if (pts.length === 0) return "";
  if (kind === "freehand") return "M " + pts.map((p) => `${p.u},${p.v}`).join(" L ");
  const a = pts[0]!, b = pts[pts.length - 1] ?? a;
  if (kind === "line" || kind === "arrow" || kind === "text") return `M ${a.u},${a.v} L ${b.u},${b.v}`;
  const x = Math.min(a.u, b.u), y = Math.min(a.v, b.v), w = Math.abs(b.u - a.u), h = Math.abs(b.v - a.v);
  if (kind === "rect") return `M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z`;
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  return `M ${cx - rx},${cy} a ${rx},${ry} 0 1,0 ${2 * rx},0 a ${rx},${ry} 0 1,0 ${-2 * rx},0`;
}

/**
 * Blueprint interactive viewer (M2) — a full-screen pdf.js/image canvas.
 *
 * Loaded ONLY via next/dynamic({ssr:false}) so pdf.js never enters the shared
 * bundle or runs under SSR. pdf.js is hardened per the security review:
 * isEvalSupported:false, enableXfa:false, disableAutoFetch:true, NO scripting,
 * NO annotation layer. Bytes are fetched ONCE from the same-origin serve route
 * (keeps the 60s signed-URL token out of app strings; avoids range-expiry).
 * Render scale is DPR- and 4096px-capped (iOS canvas limit); every render is a
 * cancellable RenderTask. A positioned overlay container sized to the page (0..1
 * normalized coords) is exposed for future pins. Any failure degrades to the
 * guaranteed Open/download link.
 */

const MAX_CANVAS_PX = 4096; // iOS Safari per-side canvas cap

type Props = {
  jobId: string;
  versionId: string;
  mime: string;
  label: string;
  drawingNumber: string;
  revision: string;
  supersededNotice: string | null;
  canDeletePins: boolean;
  onClose: () => void;
};

type Phase = "loading" | "ready" | "error";

export default function BlueprintViewer(props: Props) {
  const { jobId, versionId, mime, label, onClose } = props;
  const isImage = mime.startsWith("image/");
  const src = `/jobs/${jobId}/blueprints/f/${versionId}`;

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderTaskRef = useRef<any>(null);
  const intrinsicRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const pageBoxRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(0); // 0-based
  const [fitMode, setFitMode] = useState<FitMode>("page");
  const [userZoom, setUserZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [status, setStatus] = useState(""); // aria-live

  // --- pins layer state -----------------------------------------------------
  const [mode, setMode] = useState<ViewerMode>("view");
  const placeMode = mode === "pin"; // derived alias — all pin code below reads this unchanged
  const [pins, setPins] = useState<BlueprintPin[]>([]);
  const [linkable, setLinkable] = useState<{ id: string; title: string; status: string }[]>([]);
  const [draft, setDraft] = useState<{ u: number; v: number; page: number } | null>(null);
  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [pinFilter, setPinFilter] = useState(DEFAULT_PIN_FILTER);

  // markup layer state
  const [markups, setMarkups] = useState<BlueprintMarkup[]>([]);
  const [tool, setTool] = useState<MarkupTool>("select");
  const [mkColor, setMkColor] = useState<string>(MARKUP_COLORS[0]);
  const [mkWidth, setMkWidth] = useState<number>(MARKUP_WIDTHS[1]);
  const [selMarkupId, setSelMarkupId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<{ u: number; v: number } | null>(null);
  const liveRef = useRef<SVGPathElement>(null);
  const drawRef = useRef<{ pts: Norm[]; kind: MarkupKind } | null>(null);
  const rafRef = useRef(0);

  const refreshPins = useCallback(async () => {
    try { setPins(await getPinsAction(versionId)); } catch { /* leave prior pins */ }
  }, [versionId]);
  const refreshMarkups = useCallback(async () => {
    try { setMarkups(await getMarkupAction(versionId)); } catch { /* leave prior markups */ }
  }, [versionId]);
  useEffect(() => { void refreshPins(); }, [refreshPins]);
  useEffect(() => { void refreshMarkups(); }, [refreshMarkups]);
  useEffect(() => { getLinkableSnagsAction(jobId).then(setLinkable).catch(() => {}); }, [jobId]);

  // --- load the document once (fetch bytes, then pdf.js) --------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setPhase("loading");
        setStatus("Loading drawing…");
        const res = await fetch(src, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        if (isImage) {
          const url = URL.createObjectURL(new Blob([buf], { type: mime }));
          const img = imgRef.current!;
          img.onload = () => {
            if (cancelled) return;
            intrinsicRef.current = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
            URL.revokeObjectURL(url);
            setPageCount(1);
            setPhase("ready");
            setStatus("Drawing loaded.");
          };
          img.onerror = () => { URL.revokeObjectURL(url); if (!cancelled) setPhase("error"); };
          img.src = url;
          return;
        }

        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const task = pdfjs.getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
          enableXfa: false,
          disableAutoFetch: true,
        });
        const doc = await task.promise;
        if (cancelled) { doc.destroy(); return; }
        pdfRef.current = doc;
        setPageCount(doc.numPages);
        setPhase("ready");
        setStatus(`Drawing loaded, ${doc.numPages} sheet${doc.numPages === 1 ? "" : "s"}.`);
      } catch {
        if (!cancelled) { setPhase("error"); setStatus("Couldn't render this drawing."); }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
      pdfRef.current?.destroy?.();
      pdfRef.current = null;
    };
  }, [src, isImage, mime]);

  // --- compute layout scale from container + intrinsic + fit + zoom ---------
  const computeLayoutScale = useCallback((): number => {
    const stage = stageRef.current;
    if (!stage) return 1;
    const cw = stage.clientWidth || 1;
    const ch = stage.clientHeight || 1;
    const base = fitScale({ w: cw, h: ch }, intrinsicRef.current, fitMode);
    return clampZoom(base * userZoom);
  }, [fitMode, userZoom]);

  // --- render the current PDF page (cancellable, DPR+px capped) -------------
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
      // bitmap scale = layout × DPR, capped so no side exceeds MAX_CANVAS_PX.
      let renderScale = bitmapScale(layoutScale, Math.min(2, window.devicePixelRatio || 1));
      const maxSide = Math.max(unit.width, unit.height) * renderScale;
      if (maxSide > MAX_CANVAS_PX) renderScale *= MAX_CANVAS_PX / maxSide;
      const vp = pg.getViewport({ scale: renderScale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      // CSS size = layout px (bitmap may be higher-res for crispness).
      canvas.style.width = `${Math.floor(unit.width * layoutScale)}px`;
      canvas.style.height = `${Math.floor(unit.height * layoutScale)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = pg.render({ canvasContext: ctx, viewport: vp });
      renderTaskRef.current = task;
      await task.promise;
      canvas.setAttribute("data-rendered-page", String(page + 1));
    } catch (e) {
      // RenderingCancelledException is expected on rapid re-render; ignore it.
      if ((e as { name?: string })?.name !== "RenderingCancelledException") {
        setPhase("error");
      }
    }
  }, [page, computeLayoutScale]);

  // re-render the PDF page on page/scale/fit change
  useLayoutEffect(() => {
    if (phase === "ready" && !isImage) void renderPdfPage();
  }, [phase, isImage, renderPdfPage]);

  // size the image via CSS on scale/fit change
  useLayoutEffect(() => {
    if (phase === "ready" && isImage && imgRef.current) {
      const s = computeLayoutScale();
      imgRef.current.style.width = `${Math.floor(intrinsicRef.current.w * s)}px`;
      imgRef.current.style.height = `${Math.floor(intrinsicRef.current.h * s)}px`;
    }
  }, [phase, isImage, computeLayoutScale]);

  // resize handling
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (isImage) { void computeLayoutScale(); setPan((p) => ({ ...p })); } else void renderPdfPage(); }, 120);
    });
    ro.observe(stage);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [isImage, renderPdfPage, computeLayoutScale]);

  // --- interactions: wheel zoom (anchored), drag pan ------------------------
  const doZoom = useCallback((dir: 1 | -1) => { setUserZoom((z) => zoomStep(z, dir)); }, []);
  const resetView = useCallback(() => { setUserZoom(1); setFitMode("page"); setPan({ x: 0, y: 0 }); }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setUserZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  }, []);

  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (mode === "markup" && tool !== "select") return; // the capture layer owns the pointer while drawing
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }, [pan, mode, tool]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }, []);
  const onPointerCancel = useCallback(() => { dragRef.current = null; }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    // A placement tap (not a pan-drag) in place mode drops a pin here.
    if (!placeMode || !d || !isTap(d.x, d.y, e.clientX, e.clientY)) return;
    const box = pageBoxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    // ignore taps in the letterbox margin (outside the page box itself)
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return;
    const { u, v } = pointerToNormalized(e.clientX, e.clientY, box);
    setActivePinId(null);
    setDraft({ u, v, page });
    setMode("view");
  }, [placeMode, page]);

  // --- markup drawing (capture layer owns the pointer; live node is imperative) --
  const flushLive = useCallback(() => {
    rafRef.current = 0;
    const d = drawRef.current;
    if (d && liveRef.current) liveRef.current.setAttribute("d", toPathD(d.kind, d.pts));
  }, []);
  const onMarkupDown = useCallback((e: React.PointerEvent) => {
    if (tool === "select" || tool === "text") return; // select = no capture; text = on up
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const box = pageBoxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    drawRef.current = { kind: tool, pts: [pointerToNormalized(e.clientX, e.clientY, box)] };
  }, [tool]);
  const onMarkupMove = useCallback((e: React.PointerEvent) => {
    const d = drawRef.current;
    if (!d) return;
    const box = pageBoxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const p = pointerToNormalized(e.clientX, e.clientY, box);
    d.pts = d.kind === "freehand" ? appendSample(d.pts, p) : [d.pts[0]!, p];
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushLive);
  }, [flushLive]);
  const onMarkupUp = useCallback(async (e: React.PointerEvent) => {
    if (tool === "text") {
      const box = pageBoxRef.current?.getBoundingClientRect();
      if (box && box.width > 0) { const p = pointerToNormalized(e.clientX, e.clientY, box); setTextDraft({ u: p.u, v: p.v }); }
      return;
    }
    const d = drawRef.current;
    drawRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (liveRef.current) liveRef.current.setAttribute("d", "");
    if (!d) return;
    const pts = d.kind === "freehand" ? simplifyStroke(d.pts) : d.pts;
    if (pts.length < 2) return;
    const geom = { kind: d.kind, points: pts };
    if (isDegenerate(geom)) return; // ignore an accidental zero-size drag
    const res = await createMarkupAction(jobId, { blueprint_version_id: versionId, page_number: toStoredPage(page), geom, color: mkColor, stroke_width: mkWidth });
    if (res.ok) void refreshMarkups();
  }, [tool, jobId, versionId, page, mkColor, mkWidth, refreshMarkups]);
  const onMarkupCancel = useCallback(() => {
    drawRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (liveRef.current) liveRef.current.setAttribute("d", "");
  }, []);
  const commitText = useCallback(async (text: string) => {
    const td = textDraft;
    setTextDraft(null);
    if (!td) return;
    const res = await createMarkupAction(jobId, { blueprint_version_id: versionId, page_number: toStoredPage(page), geom: { kind: "text", points: [{ u: td.u, v: td.v }] }, color: mkColor, text });
    if (res.ok) void refreshMarkups();
  }, [textDraft, jobId, versionId, page, mkColor, refreshMarkups]);
  const removeSelMarkup = useCallback(async () => {
    if (!selMarkupId) return;
    const res = await removeMarkupAction(jobId, selMarkupId);
    if (res.ok) { setSelMarkupId(null); void refreshMarkups(); }
  }, [selMarkupId, jobId, refreshMarkups]);
  const deleteSelMarkup = useCallback(async () => {
    if (!selMarkupId) return;
    const res = await deleteMarkupAction(jobId, selMarkupId);
    if (res.ok) { setSelMarkupId(null); void refreshMarkups(); }
  }, [selMarkupId, jobId, refreshMarkups]);

  // --- page nav -------------------------------------------------------------
  const goPage = useCallback((next: number) => {
    setPage((p) => {
      const np = clampPage(next, pageCount);
      if (np !== p) { setPan({ x: 0, y: 0 }); setStatus(`Sheet ${np + 1} of ${pageCount}`); }
      return np;
    });
  }, [pageCount]);

  // --- keyboard + focus trap ------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Focus trap: the dialog is aria-modal, so keyboard focus must not escape
      // to the (inert) app behind it. Wrap Tab / Shift+Tab at the edges.
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const f = root.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])',
        );
        const first = f[0];
        const last = f[f.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === root)) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selMarkupId) { void removeSelMarkup(); e.preventDefault(); return; }
      switch (e.key) {
        case "Escape":
          if (textDraft) { setTextDraft(null); break; }
          if (draft) { setDraft(null); break; }
          if (selMarkupId) { setSelMarkupId(null); break; }
          if (activePinId) { setActivePinId(null); break; }
          if (mode !== "view") { setMode("view"); break; }
          onClose();
          break;
        case "+": case "=": doZoom(1); break;
        case "-": doZoom(-1); break;
        case "0": resetView(); break;
        case "f": setFitMode((m) => (m === "width" ? "page" : "width")); break;
        case "ArrowRight": setPan((p) => ({ ...p, x: p.x - 60 })); break;
        case "ArrowLeft": setPan((p) => ({ ...p, x: p.x + 60 })); break;
        case "ArrowUp": setPan((p) => ({ ...p, y: p.y + 60 })); break;
        case "ArrowDown": setPan((p) => ({ ...p, y: p.y - 60 })); break;
        case "PageDown": goPage(page + 1); break;
        case "PageUp": goPage(page - 1); break;
        case "Home": goPage(0); break;
        case "End": goPage(pageCount - 1); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, doZoom, resetView, goPage, page, pageCount, draft, activePinId, placeMode, mode, textDraft, selMarkupId, removeSelMarkup]);

  // focus the dialog on mount; restore handled by the opener
  useEffect(() => { dialogRef.current?.focus(); }, []);

  const zoomPct = Math.round(computeLayoutScale() * 100);
  const activePin = activePinId ? pins.find((p) => p.id === activePinId) ?? null : null;
  const visiblePins = filterPins(pinsForSheet(pins, page), pinFilter);
  const visibleMarkups = markupForSheet(markups, page);
  const selectable = mode === "markup" && tool === "select";
  const selMarkup = selMarkupId ? markups.find((m) => m.id === selMarkupId) ?? null : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Drawing viewer: ${label}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 outline-none"
    >
      {/* top bar */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-4 py-2 text-white">
        <div className="min-w-0 truncate text-sm">
          <span className="font-mono font-semibold">{props.drawingNumber}</span>
          <span className="ml-2 text-slate-300">{props.revision}</span>
        </div>
        <div className="flex items-center gap-1">
          {pins.length > 0 && mode !== "markup" ? <FilterChips value={pinFilter} onChange={setPinFilter} /> : null}
          <button
            type="button"
            onClick={() => { setMode((mm) => (mm === "pin" ? "view" : "pin")); setDraft(null); setActivePinId(null); setSelMarkupId(null); }}
            aria-pressed={placeMode}
            className={`min-h-[36px] rounded-md px-3 py-1.5 text-xs font-semibold ${placeMode ? "bg-white text-slate-900" : "border border-slate-600 hover:bg-slate-800"}`}
          >
            {placeMode ? "Tap the drawing…" : "+ Add pin"}
          </button>
          <button
            type="button"
            onClick={() => { setMode((mm) => (mm === "markup" ? "view" : "markup")); setDraft(null); setActivePinId(null); setSelMarkupId(null); }}
            aria-pressed={mode === "markup"}
            className={`min-h-[36px] rounded-md px-3 py-1.5 text-xs font-semibold ${mode === "markup" ? "bg-white text-slate-900" : "border border-slate-600 hover:bg-slate-800"}`}
          >
            ✎ Markup
          </button>
          <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open or download ${label}`} className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800">Open</a>
          <button type="button" onClick={onClose} aria-label="Close viewer" className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800">✕ Close</button>
        </div>
      </div>

      {props.supersededNotice ? (
        <div role="status" className="flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-900">
          ⚠ {props.supersededNotice}
        </div>
      ) : null}

      {/* stage */}
      <div
        ref={stageRef}
        className="relative flex-1 touch-none select-none overflow-hidden"
        style={{ cursor: placeMode ? "crosshair" : dragRef.current ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {phase === "loading" ? (
          <div className="absolute inset-0 grid place-items-center">
            <div className="h-40 w-56 animate-pulse rounded bg-slate-700" aria-hidden />
          </div>
        ) : null}

        {phase === "error" ? (
          <div role="alert" className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm rounded-xl border border-red-300 bg-white p-6 text-center">
              <p className="text-3xl">📄</p>
              <p className="mt-2 text-sm font-medium text-slate-900">We couldn&apos;t render this drawing here.</p>
              <p className="mt-1 text-sm text-slate-500">Open or download the file to view it.</p>
              <div className="mt-4 flex justify-center gap-2">
                <a href={src} target="_blank" rel="noopener noreferrer" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">Open / download</a>
                <button type="button" onClick={() => { setPhase("loading"); setUserZoom((z) => z); location.reload(); }} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">Try again</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* the page + overlay container (normalized 0..1 for future pins) */}
        <div
          className="absolute left-1/2 top-1/2"
          style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`, visibility: phase === "ready" ? "visible" : "hidden" }}
        >
          <div ref={pageBoxRef} className="relative">
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img ref={imgRef} alt={label} className="block max-w-none bg-white shadow-2xl" draggable={false} />
            ) : (
              <canvas ref={canvasRef} role="img" aria-label={`${label}, sheet ${page + 1} of ${pageCount}`} className="block bg-white shadow-2xl" />
            )}
            {/* markup layer (Programme C) — SVG shapes BENEATH the pins overlay */}
            <svg data-blueprint-markup viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
              {phase === "ready"
                ? visibleMarkups.map((m) => (
                    <MarkupShape key={m.id} m={m} selected={m.id === selMarkupId} onSelect={selectable ? setSelMarkupId : undefined} />
                  ))
                : null}
              <path ref={liveRef} fill="none" stroke={mkColor} strokeWidth={mkWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            </svg>
            {/* markup text — HTML sibling (auto-escaped) */}
            <div className="pointer-events-none absolute inset-0">
              {phase === "ready" ? <MarkupTextLayer items={visibleMarkups} selectable={selectable} onSelect={setSelMarkupId} /> : null}
            </div>

            {/* pins overlay — Programme B markers ride this, normalized to the page box */}
            <div className="pointer-events-none absolute inset-0" data-blueprint-overlay>
              {phase === "ready"
                ? visiblePins.map((p) => (
                    <PinMarker key={p.id} pin={p} active={p.id === activePinId} onActivate={(id) => { setDraft(null); setActivePinId(id); }} />
                  ))
                : null}
              {draft && draft.page === page ? <DraftMarker u={draft.u} v={draft.v} /> : null}
            </div>

            {/* markup capture layer — owns the pointer while drawing (top of the box) */}
            {mode === "markup" && tool !== "select" && phase === "ready" ? (
              <div
                data-markup-capture
                className="absolute inset-0 z-40 touch-none"
                style={{ cursor: tool === "text" ? "text" : "crosshair" }}
                onPointerDown={onMarkupDown}
                onPointerMove={onMarkupMove}
                onPointerUp={onMarkupUp}
                onPointerCancel={onMarkupCancel}
              />
            ) : null}
            {textDraft ? (
              <MarkupTextInput u={textDraft.u} v={textDraft.v} color={mkColor} onCommit={commitText} onCancel={() => setTextDraft(null)} />
            ) : null}
          </div>
        </div>
      </div>

      {mode === "markup" ? (
        <MarkupToolbar
          tool={tool} setTool={setTool} color={mkColor} setColor={setMkColor} width={mkWidth} setWidth={setMkWidth}
          canDelete={props.canDeletePins} selected={selMarkup} onRemove={removeSelMarkup} onDelete={deleteSelMarkup}
        />
      ) : null}

      {/* controls — bottom bar (thumb zone on mobile) */}
      <div className="flex items-center justify-center gap-1 border-t border-slate-700 bg-slate-900 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-white">
        <button type="button" onClick={() => doZoom(-1)} aria-label="Zoom out" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">−</button>
        <button type="button" onClick={resetView} aria-label={`Zoom ${zoomPct} percent, reset to fit`} className="min-w-[3.5rem] rounded-md px-2 py-1 text-xs tabular-nums hover:bg-slate-800">{zoomPct}%</button>
        <button type="button" onClick={() => doZoom(1)} aria-label="Zoom in" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">+</button>
        <button type="button" onClick={() => setFitMode("width")} aria-pressed={fitMode === "width"} className={`ml-2 rounded-md px-3 py-1.5 text-xs font-semibold ${fitMode === "width" ? "bg-white text-slate-900" : "hover:bg-slate-800"}`}>Fit width</button>
        <button type="button" onClick={() => setFitMode("page")} aria-pressed={fitMode === "page"} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${fitMode === "page" ? "bg-white text-slate-900" : "hover:bg-slate-800"}`}>Fit page</button>
        {!isImage && pageCount > 1 ? (
          <span className="ml-2 flex items-center gap-1">
            <button type="button" onClick={() => goPage(page - 1)} disabled={page <= 0} aria-label="Previous sheet" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800 disabled:opacity-40">‹</button>
            <span className="min-w-[3rem] text-center text-xs tabular-nums" aria-hidden>{page + 1} / {pageCount}</span>
            <button type="button" onClick={() => goPage(page + 1)} disabled={page >= pageCount - 1} aria-label="Next sheet" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800 disabled:opacity-40">›</button>
          </span>
        ) : null}
      </div>

      {draft ? (
        <PlacementSheet
          jobId={jobId} versionId={versionId} page={toStoredPage(draft.page)} u={draft.u} v={draft.v}
          linkable={linkable}
          onDone={() => { setDraft(null); void refreshPins(); getLinkableSnagsAction(jobId).then(setLinkable).catch(() => {}); }}
          onCancel={() => setDraft(null)}
        />
      ) : null}
      {activePin ? (
        <PinDetail pin={activePin} jobId={jobId} canDelete={props.canDeletePins} onClose={() => setActivePinId(null)} onChanged={refreshPins} />
      ) : null}

      {placeMode ? (
        <p role="status" className="pointer-events-none absolute inset-x-0 top-16 z-30 text-center text-xs font-medium text-white/90">Tap the drawing to place a pin · Esc to cancel</p>
      ) : null}

      <p className="sr-only" aria-live="polite">{status}</p>
      <p className="sr-only">Interactive drawing viewer. For a screen-reader-accessible copy, use the Open or download link. Press Escape to close.</p>
    </div>
  );
}
