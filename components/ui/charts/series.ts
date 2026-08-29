import type { Tone } from "../tokens";

/**
 * Chart series vocabulary — the SVG half of the tone map.
 *
 * components/ui/tokens.ts owns the tone VOCABULARY (six tones, earned by
 * usage); this file spells each tone's SVG recipes the same way tokens.ts
 * spells its pill recipes: WHOLE LITERAL CLASS STRINGS (Tailwind's scanner
 * cannot see `fill-${tone}-600`), SOLID swatches only (never `/15` opacity —
 * a blended mark's contrast depends on what's behind it), LIGHT ONLY.
 *
 * Colour is never the only signal: every chart renders axis/value labels,
 * per-mark <title> tooltips, a legend with text names, and a visually-hidden
 * data table — the tone reinforces a series' identity, it never carries it.
 */

export interface SeriesClasses {
  /** Bar / donut-segment fill. `-600` — the darkest step that still reads as a fill. */
  fill: string;
  /** Line / point stroke. */
  stroke: string;
  /** Area fill under a line — a solid `-100`, never an opacity blend. */
  area: string;
  /** Legend swatch background (HTML, not SVG). */
  swatch: string;
}

export const SERIES: Record<Tone, SeriesClasses> = {
  slate: {
    fill: "fill-slate-500",
    stroke: "stroke-slate-500",
    area: "fill-slate-100",
    swatch: "bg-slate-500",
  },
  blue: {
    fill: "fill-blue-600",
    stroke: "stroke-blue-600",
    area: "fill-blue-100",
    swatch: "bg-blue-600",
  },
  emerald: {
    fill: "fill-emerald-600",
    stroke: "stroke-emerald-600",
    area: "fill-emerald-100",
    swatch: "bg-emerald-600",
  },
  amber: {
    fill: "fill-amber-500",
    stroke: "stroke-amber-500",
    area: "fill-amber-100",
    swatch: "bg-amber-500",
  },
  red: {
    fill: "fill-red-600",
    stroke: "stroke-red-600",
    area: "fill-red-100",
    swatch: "bg-red-600",
  },
  indigo: {
    fill: "fill-indigo-600",
    stroke: "stroke-indigo-600",
    area: "fill-indigo-100",
    swatch: "bg-indigo-600",
  },
};

/** One plotted point. `text` is the page's preformatted display value (e.g. "£1,200") — charts never format money themselves beyond axis ticks. */
export type ChartDatum = {
  label: string;
  value: number;
  /** Preformatted display value for tooltips + the accessible table. Falls back to String(value). */
  text?: string;
  /** Per-datum tone override (e.g. red bar for a negative-margin job). */
  tone?: Tone;
};

/** One named series of points. */
export type ChartSeries = {
  name: string;
  tone: Tone;
  data: ChartDatum[];
};

/** Display value for a datum — the page's preformatted text, else the raw number. */
export function datumText(d: ChartDatum): string {
  return d.text ?? String(d.value);
}
