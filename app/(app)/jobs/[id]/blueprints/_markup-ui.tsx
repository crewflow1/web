"use client";

import { useState } from "react";
import { MARKUP_KINDS, MARKUP_KIND_LABELS, normalizedToPercent, type BlueprintMarkup, type MarkupKind, type Norm } from "@/lib/blueprints/markup";

/**
 * Blueprint Markup — presentational surfaces (tool palette, committed-shape SVG,
 * text HTML layer, inline text input). Geometry maps 1:1 into the parent SVG
 * viewBox="0 0 1 1" (u→x, v→y). Text renders as an HTML sibling (React child —
 * auto-escaped, no HTML/SVG injection) to dodge the non-uniform viewBox skew.
 */

export type MarkupTool = "select" | MarkupKind;
export const MARKUP_TOOLS: MarkupTool[] = ["select", ...MARKUP_KINDS];
export const MARKUP_COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#111827"] as const;
export const MARKUP_WIDTHS = [2, 3, 5] as const;

const TOOL_GLYPH: Record<MarkupTool, string> = {
  select: "▤", freehand: "✎", line: "╱", arrow: "↗", rect: "▭", ellipse: "◯", text: "T",
};

/** The committed geometric shapes (everything except text) as one SVG path set. */
export function MarkupShape({ m, selected, onSelect }: { m: BlueprintMarkup; selected: boolean; onSelect?: (id: string) => void }) {
  const stroke = m.color ?? "#ef4444";
  const w = m.stroke_width ?? 3;
  const common = {
    stroke, strokeWidth: w, fill: "none" as const,
    vectorEffect: "non-scaling-stroke" as const,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    onPointerDown: onSelect ? (e: React.PointerEvent) => { e.stopPropagation(); onSelect(m.id); } : undefined,
    style: { pointerEvents: onSelect ? ("stroke" as const) : ("none" as const), cursor: onSelect ? "pointer" : undefined },
  };
  const halo = selected ? <SelHalo m={m} /> : null;
  const p = m.points;
  if (m.kind === "text") return null; // rendered in the HTML layer
  if (m.kind === "freehand") {
    return <>{halo}<polyline points={p.map((q) => `${q.u},${q.v}`).join(" ")} {...common} /></>;
  }
  const a = p[0] ?? { u: 0, v: 0 };
  const b = p[1] ?? a;
  if (m.kind === "line") return <>{halo}<line x1={a.u} y1={a.v} x2={b.u} y2={b.v} {...common} /></>;
  if (m.kind === "arrow") {
    return (
      <>
        {halo}
        <defs>
          <marker id={`ah-${m.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth">
            <path d="M0,0 L10,5 L0,10 z" fill={stroke} />
          </marker>
        </defs>
        <line x1={a.u} y1={a.v} x2={b.u} y2={b.v} markerEnd={`url(#ah-${m.id})`} {...common} />
      </>
    );
  }
  const x = Math.min(a.u, b.u), y = Math.min(a.v, b.v), ww = Math.abs(b.u - a.u), hh = Math.abs(b.v - a.v);
  if (m.kind === "rect") return <>{halo}<rect x={x} y={y} width={ww} height={hh} {...common} /></>;
  return <>{halo}<ellipse cx={x + ww / 2} cy={y + hh / 2} rx={ww / 2} ry={hh / 2} {...common} /></>;
}

function SelHalo({ m }: { m: BlueprintMarkup }) {
  const p = m.points;
  if (m.kind === "freehand") return <polyline points={p.map((q) => `${q.u},${q.v}`).join(" ")} fill="none" stroke="#2563eb" strokeWidth={(m.stroke_width ?? 3) + 6} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />;
  const a = p[0] ?? { u: 0, v: 0 }, b = p[1] ?? a;
  if (m.kind === "line" || m.kind === "arrow") return <line x1={a.u} y1={a.v} x2={b.u} y2={b.v} stroke="#2563eb" strokeWidth={(m.stroke_width ?? 3) + 6} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />;
  const x = Math.min(a.u, b.u), y = Math.min(a.v, b.v), ww = Math.abs(b.u - a.u), hh = Math.abs(b.v - a.v);
  if (m.kind === "rect") return <rect x={x} y={y} width={ww} height={hh} fill="none" stroke="#2563eb" strokeWidth={(m.stroke_width ?? 3) + 6} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />;
  return <ellipse cx={x + ww / 2} cy={y + hh / 2} rx={ww / 2} ry={hh / 2} fill="none" stroke="#2563eb" strokeWidth={(m.stroke_width ?? 3) + 6} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />;
}

/** Text markup — HTML sibling of the SVG, positioned by %; text is auto-escaped. */
export function MarkupTextLayer({ items, selectable, onSelect }: { items: BlueprintMarkup[]; selectable: boolean; onSelect?: (id: string) => void }) {
  return (
    <>
      {items.filter((m) => m.kind === "text").map((m) => {
        const pos = normalizedToPercent(m.points[0] ?? { u: 0, v: 0 });
        return (
          <button
            key={m.id}
            type={"button"}
            onPointerDown={selectable && onSelect ? (e) => { e.stopPropagation(); onSelect(m.id); } : undefined}
            className="absolute -translate-y-1/2 whitespace-pre text-[13px] font-semibold leading-tight drop-shadow-sm"
            style={{ left: pos.left, top: pos.top, color: m.color ?? "#ef4444", pointerEvents: selectable ? "auto" : "none", cursor: selectable ? "pointer" : "default" }}
          >
            {m.text}
          </button>
        );
      })}
    </>
  );
}

/** Inline text entry mounted at a placed point. */
export function MarkupTextInput({ u, v, color, onCommit, onCancel }: { u: number; v: number; color: string; onCommit: (text: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const pos = normalizedToPercent({ u, v });
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? onCommit(value.trim()) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); if (value.trim()) onCommit(value.trim()); else onCancel(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      maxLength={500}
      placeholder="Type a note…"
      aria-label="Markup text"
      className="absolute z-40 -translate-y-1/2 rounded border border-slate-400 bg-white px-1.5 py-0.5 text-[13px] font-semibold text-slate-900 shadow-lg outline-none"
      style={{ left: pos.left, top: pos.top, color }}
    />
  );
}

/** Tool palette + colour + width, shown when markup mode is active. */
export function MarkupToolbar({
  tool, setTool, color, setColor, width, setWidth, canDelete, selected, onRemove, onDelete,
}: {
  tool: MarkupTool; setTool: (t: MarkupTool) => void;
  color: string; setColor: (c: string) => void;
  width: number; setWidth: (w: number) => void;
  canDelete: boolean; selected: BlueprintMarkup | null;
  onRemove: () => void; onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 border-t border-slate-700 bg-slate-800 px-2 py-2 text-white" role="toolbar" aria-label="Markup tools">
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Drawing tool">
        {MARKUP_TOOLS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTool(t)}
            role="radio"
            aria-checked={tool === t}
            aria-label={t === "select" ? "Select" : MARKUP_KIND_LABELS[t]}
            title={t === "select" ? "Select" : MARKUP_KIND_LABELS[t]}
            className={`grid h-11 w-11 place-items-center rounded-md text-base ${tool === t ? "bg-white text-slate-900" : "hover:bg-slate-700"}`}
          >
            <span aria-hidden>{TOOL_GLYPH[t]}</span>
          </button>
        ))}
      </div>
      <span aria-hidden className="mx-1 h-6 w-px bg-slate-600" />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
        {MARKUP_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} role="radio" aria-checked={color === c} aria-label={`Colour ${c}`}
            className={`h-8 w-8 rounded-full border-2 ${color === c ? "border-white" : "border-transparent"}`} style={{ background: c }} />
        ))}
      </div>
      <span aria-hidden className="mx-1 h-6 w-px bg-slate-600" />
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Stroke width">
        {MARKUP_WIDTHS.map((w) => (
          <button key={w} type="button" onClick={() => setWidth(w)} role="radio" aria-checked={width === w} aria-label={`Width ${w}`}
            className={`grid h-11 w-11 place-items-center rounded-md ${width === w ? "bg-white text-slate-900" : "hover:bg-slate-700"}`}>
            <span aria-hidden className="rounded-full bg-current" style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
      </div>
      {selected ? (
        <>
          <span aria-hidden className="mx-1 h-6 w-px bg-slate-600" />
          <button type="button" onClick={onRemove} className="min-h-[44px] rounded-md border border-slate-500 px-3 text-xs font-semibold hover:bg-slate-700">Remove</button>
          {canDelete ? <button type="button" onClick={onDelete} className="min-h-[44px] rounded-md border border-rose-400 px-3 text-xs font-semibold text-rose-200 hover:bg-rose-900/40">Delete</button> : null}
        </>
      ) : null}
    </div>
  );
}
