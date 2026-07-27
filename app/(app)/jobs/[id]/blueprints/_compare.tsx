"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DrawingRenderSurface, { type SurfaceState } from "./_drawing-render-surface";
import {
  defaultRevisionPair, isValidPair, clampPageNum, pageCountsDiffer, overlayAllowed,
  clampOpacity, compareSummary, clampZoom, COMPARE_MODES, COMPARE_MODE_LABELS,
  DEFAULT_COMPARE_VIEW, NO_ANNOTATIONS,
  type CompareVersion, type CompareMode, type CompareView, type AnnToggles,
} from "@/lib/blueprints/compare";
import { zoomStep } from "@/lib/blueprints/viewer";
import { getPinsAction } from "./pin-actions";
import { getMarkupAction } from "./markup-actions";
import { MarkupShape, MarkupTextLayer } from "./_markup-ui";
import { normalizedToPercent } from "@/lib/blueprints/markup";
import type { BlueprintPin } from "@/lib/blueprints/pins";
import type { BlueprintMarkup } from "@/lib/blueprints/markup";

/**
 * Blueprint Revision Comparison (Programme D) — full-screen, view-only compare of
 * two revisions of ONE drawing. Two DrawingRenderSurfaces, driven by one shared
 * fit/zoom/pan when synced. Side-by-side + overlay (opacity/swap) + difference
 * (mix-blend). Zero migration: each surface fetches its own versionId via the
 * RLS-gated /f/[versionId] route (both independently tenant-gated). Annotations
 * are version-scoped reads, A/B badged, never merged. Compare is view-only.
 */

type Props = {
  jobId: string;
  blueprintId: string;
  drawingNumber: string;
  title: string;
  versions: CompareVersion[]; // version-DESC (register order)
  isAdmin: boolean;
  initialA?: string;
  initialB?: string;
  onClose: () => void;
};

const badge = (which: "A" | "B") =>
  which === "A" ? "bg-sky-500 text-white" : "bg-amber-500 text-slate-900";

export default function BlueprintCompare(props: Props) {
  const { jobId, versions, onClose } = props;
  const def = defaultRevisionPair(versions);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [aId, setAId] = useState(props.initialA && isValidPair(versions, props.initialA, props.initialB ?? "") ? props.initialA : def?.a ?? "");
  const [bId, setBId] = useState(props.initialB && isValidPair(versions, props.initialA ?? "", props.initialB) ? props.initialB : def?.b ?? "");
  const [mode, setMode] = useState<CompareMode>("side");
  const [view, setView] = useState<CompareView>(DEFAULT_COMPARE_VIEW);
  const [pageA, setPageA] = useState(0); // 0-based
  const [pageB, setPageB] = useState(0);
  const [opacity, setOpacity] = useState(0.5);
  const [sync, setSync] = useState(true);
  const [ann, setAnn] = useState<AnnToggles>(NO_ANNOTATIONS);
  const [stA, setStA] = useState<SurfaceState | null>(null);
  const [stB, setStB] = useState<SurfaceState | null>(null);
  const [narrow, setNarrow] = useState(false);

  const verA = versions.find((v) => v.id === aId);
  const verB = versions.find((v) => v.id === bId);
  const countA = stA?.pageCount ?? 1;
  const countB = stB?.pageCount ?? 1;
  const overlayOK = stA && stB ? overlayAllowed(stA.intrinsic, stB.intrinsic) : true;
  const effMode: CompareMode = mode !== "side" && !overlayOK ? "side" : mode;

  // phone → overlay-first, single surface + A|B toggle
  const [phoneShow, setPhoneShow] = useState<"a" | "b">("b");
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // --- shared view: wheel zoom + drag pan on the stage (sync on) --------------
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setView((v) => ({ ...v, zoom: clampZoom(v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) }));
  }, []);
  const onDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: view.pan.x, py: view.pan.y };
  }, [view.pan]);
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    setView((v) => ({ ...v, pan: { x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) } }));
  }, []);
  const onUp = useCallback(() => { dragRef.current = null; }, []);

  const doZoom = useCallback((dir: 1 | -1) => setView((v) => ({ ...v, zoom: zoomStep(v.zoom, dir) })), []);
  const resetView = useCallback(() => setView(DEFAULT_COMPARE_VIEW), []);
  const swap = useCallback(() => { setAId(bId); setBId(aId); setPageA(pageB); setPageB(pageA); }, [aId, bId, pageA, pageB]);
  const stepPage = useCallback((delta: number) => {
    setPageA((p) => clampPageNum(p + 1 + delta, countA) - 1);
    if (sync) setPageB((p) => clampPageNum(p + 1 + delta, countB) - 1);
  }, [countA, countB, sync]);

  // --- keyboard (§17): shortcuts disabled while typing in the pickers ---------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "SELECT" || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        if (e.key === "Escape") (el as HTMLElement).blur();
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current; if (!root) return;
        const f = root.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select,input,[tabindex]:not([tabindex="-1"])');
        const first = f[0], last = f[f.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === root)) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
        return;
      }
      switch (e.key) {
        case "Escape": onClose(); break;
        case "s": case "S": setMode("side"); break;
        case "o": case "O": if (overlayOK) setMode("overlay"); break;
        case "x": case "X": swap(); break;
        case "+": case "=": doZoom(1); break;
        case "-": doZoom(-1); break;
        case "0": resetView(); break;
        case "ArrowRight": case "PageDown": stepPage(1); break;
        case "ArrowLeft": case "PageUp": stepPage(-1); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, overlayOK, swap, doZoom, resetView, stepPage]);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  const summary = useMemo(() => compareSummary(verA, verB, effMode) + (overlayOK ? "" : " Overlay unavailable: sheets differ in size."), [verA, verB, effMode, overlayOK]);

  const surface = (which: "A" | "B", versionId: string, page: number, ver: CompareVersion | undefined, tier: "compare-sxs" | "compare-overlay", overlayLayer: boolean) => (
    <DrawingRenderSurface
      key={versionId}
      jobId={jobId} versionId={versionId} mime={ver?.mime_type ?? "application/pdf"}
      page={page} fit={view.fit} zoom={view.zoom} pan={view.pan}
      opacity={overlayLayer && which === "B" ? opacity : 1}
      blend={effMode === "diff" && which === "B"}
      memoryTier={tier}
      label={`Revision ${ver?.revision ?? which}`}
      onState={which === "A" ? setStA : setStB}
    >
      <CompareAnnotations versionId={versionId} which={which} page={page} ann={ann} />
    </DrawingRenderSurface>
  );

  const pickerRow = (which: "A" | "B", value: string, set: (id: string) => void, other: string) => (
    <label className="flex items-center gap-1.5 text-xs">
      <span className={`grid h-6 w-6 place-items-center rounded font-bold ${badge(which)}`} aria-hidden>{which}</span>
      <span className="sr-only">Revision {which}</span>
      <select
        value={value}
        onChange={(e) => set(e.target.value)}
        className="max-w-[13rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white"
      >
        {versions.map((v) => (
          <option key={v.id} value={v.id} disabled={v.id === other}>
            {v.revision}{v.revision_date ? ` · ${v.revision_date}` : ""}{v.id === versions[0]?.id ? " · current" : ""}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Compare revisions of ${props.drawingNumber} ${props.title}`} tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 outline-none">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-3 py-2 text-white">
        <div className="min-w-0 truncate text-sm">
          <span className="font-mono font-semibold">{props.drawingNumber}</span>
          <span className="ml-2 text-slate-300">{props.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pickerRow("A", aId, setAId, bId)}
          <button type="button" onClick={swap} aria-label="Swap revisions A and B" className="grid h-9 min-w-[36px] place-items-center rounded-md border border-slate-600 px-2 text-xs font-semibold hover:bg-slate-800">⇄</button>
          {pickerRow("B", bId, setBId, aId)}
          <button type="button" onClick={onClose} aria-label="Close comparison" className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800">✕ Close</button>
        </div>
      </div>

      {/* mode + dimension warning */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-1.5 text-white">
        <div role="radiogroup" aria-label="Comparison mode" className="flex items-center gap-1">
          {COMPARE_MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={effMode === m}
              disabled={m !== "side" && !overlayOK}
              onClick={() => setMode(m)}
              className={`min-h-[36px] rounded-md px-3 text-xs font-semibold ${effMode === m ? "bg-white text-slate-900" : "border border-slate-600 hover:bg-slate-800 disabled:opacity-40"}`}>
              {COMPARE_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {!overlayOK ? (
          <span role="status" className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            ⚠ Overlay unavailable — these sheets have different dimensions. Showing side by side.
          </span>
        ) : null}
        {pageCountsDiffer(countA, countB) ? (
          <span role="status" className="rounded bg-slate-700 px-2 py-0.5 text-[11px] font-medium text-slate-200">
            Sheet counts differ (A {countA} · B {countB}) — check you&apos;re comparing matching sheets.
          </span>
        ) : null}
        <span className="ml-auto text-[11px] tabular-nums text-slate-400">
          A {pageA + 1}/{countA} · B {pageB + 1}/{countB}
        </span>
      </div>

      {/* stage */}
      <div className="relative flex-1 touch-none select-none overflow-hidden" onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {effMode === "side" ? (
          narrow ? (
            <div className="absolute inset-0">
              <div className="absolute inset-0">{surface(phoneShow === "a" ? "A" : "B", phoneShow === "a" ? aId : bId, phoneShow === "a" ? pageA : pageB, phoneShow === "a" ? verA : verB, "compare-sxs", false)}</div>
              <div className="pointer-events-none absolute left-2 top-2"><span className={`rounded px-2 py-1 text-xs font-bold ${badge(phoneShow === "a" ? "A" : "B")}`}>{phoneShow === "a" ? verA?.revision : verB?.revision}</span></div>
            </div>
          ) : (
            <div className="flex h-full w-full">
              {(["A", "B"] as const).map((w) => (
                <div key={w} className="relative h-full w-1/2 border-slate-700 first:border-r">
                  {surface(w, w === "A" ? aId : bId, w === "A" ? pageA : pageB, w === "A" ? verA : verB, "compare-sxs", false)}
                  <div className="pointer-events-none absolute left-2 top-2"><span className={`rounded px-2 py-1 text-xs font-bold ${badge(w)}`}>{(w === "A" ? verA : verB)?.revision}</span></div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="absolute inset-0">
            {surface("A", aId, pageA, verA, "compare-overlay", true)}
            <div className="absolute inset-0">{surface("B", bId, pageB, verB, "compare-overlay", true)}</div>
          </div>
        )}
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-slate-700 bg-slate-900 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-white">
        {narrow && effMode === "side" ? (
          <div role="radiogroup" aria-label="Show revision" className="flex items-center gap-1">
            <button type="button" role="radio" aria-checked={phoneShow === "a"} onClick={() => setPhoneShow("a")} className={`min-h-[44px] rounded-md px-3 text-xs font-semibold ${phoneShow === "a" ? "bg-white text-slate-900" : "border border-slate-600"}`}>A</button>
            <button type="button" role="radio" aria-checked={phoneShow === "b"} onClick={() => setPhoneShow("b")} className={`min-h-[44px] rounded-md px-3 text-xs font-semibold ${phoneShow === "b" ? "bg-white text-slate-900" : "border border-slate-600"}`}>B</button>
          </div>
        ) : null}
        {effMode !== "side" ? (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-slate-300">B opacity</span>
            <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(clampOpacity(Number(e.target.value)))}
              aria-label="Revision B opacity" aria-valuetext={`${Math.round(opacity * 100)} percent`} className="h-2 w-32" />
            <span className="w-9 tabular-nums text-slate-400">{Math.round(opacity * 100)}%</span>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => stepPage(-1)} aria-label="Previous sheet" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">‹</button>
          <button type="button" onClick={() => stepPage(1)} aria-label="Next sheet" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">›</button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => doZoom(-1)} aria-label="Zoom out" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">−</button>
          <button type="button" onClick={resetView} aria-label="Reset zoom" className="min-h-[44px] rounded-md px-2 text-xs hover:bg-slate-800">Reset</button>
          <button type="button" onClick={() => doZoom(1)} aria-label="Zoom in" className="grid h-11 w-11 place-items-center rounded-md hover:bg-slate-800">+</button>
        </div>
        <button type="button" onClick={() => setSync((s) => !s)} aria-pressed={sync} className={`min-h-[44px] rounded-md px-3 text-xs font-semibold ${sync ? "bg-white text-slate-900" : "border border-slate-600"}`}>Link views</button>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Annotations">
          {([["aPins", "A pins"], ["bPins", "B pins"], ["aMarkup", "A markup"], ["bMarkup", "B markup"]] as const).map(([k, lbl]) => (
            <button key={k} type="button" aria-pressed={ann[k]} onClick={() => setAnn((a) => ({ ...a, [k]: !a[k] }))}
              className={`min-h-[44px] rounded-md px-2 text-[11px] font-semibold ${ann[k] ? "bg-white text-slate-900" : "border border-slate-600 hover:bg-slate-800"}`}>{lbl}</button>
          ))}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{summary}</p>
    </div>
  );
}

/** Read-only version-scoped annotation overlays for one surface (A/B). */
function CompareAnnotations({ versionId, which, page, ann }: { versionId: string; which: "A" | "B"; page: number; ann: AnnToggles }) {
  const showPins = which === "A" ? ann.aPins : ann.bPins;
  const showMarkup = which === "A" ? ann.aMarkup : ann.bMarkup;
  const [pins, setPins] = useState<BlueprintPin[]>([]);
  const [markups, setMarkups] = useState<BlueprintMarkup[]>([]);

  useEffect(() => { if (showPins && pins.length === 0) getPinsAction(versionId).then(setPins).catch(() => {}); }, [showPins, versionId, pins.length]);
  useEffect(() => { if (showMarkup && markups.length === 0) getMarkupAction(versionId).then(setMarkups).catch(() => {}); }, [showMarkup, versionId, markups.length]);

  const p1 = page + 1;
  return (
    <>
      {showMarkup ? (
        <>
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {markups.filter((m) => m.page_number === p1).map((m) => <MarkupShape key={m.id} m={m} selected={false} />)}
          </svg>
          <div className="pointer-events-none absolute inset-0"><MarkupTextLayer items={markups.filter((m) => m.page_number === p1)} selectable={false} /></div>
        </>
      ) : null}
      {showPins ? (
        <div className="pointer-events-none absolute inset-0">
          {pins.filter((p) => p.page_number === p1).map((p) => {
            const pos = normalizedToPercent({ u: p.u, v: p.v });
            return (
              <span key={p.id} className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white px-1.5 text-[10px] font-bold shadow ${badge(which)}`}
                style={{ left: pos.left, top: pos.top }} title={`${which}: ${p.title ?? p.kind}`}>{which}</span>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
