/**
 * CrewFlow design system — tone tokens.
 *
 * ONE place that spells the colour of a status pill or a KPI value. Before this
 * file the same recipes were re-typed per surface: `bg-red-100 text-red-800`
 * appears 24 times across app/(app), `bg-amber-100 text-amber-800` 43 times,
 * `bg-emerald-100 text-emerald-800` 39 times, `bg-slate-100 text-slate-700` 51
 * times. Retune a tone here and every surface that reads from this map follows.
 *
 * WHOLE LITERAL CLASS STRINGS, ALWAYS. Tailwind's scanner cannot see
 * `bg-${tone}-100`, so every class is spelled out in full below and callers
 * select a bundle rather than interpolating a colour. Adding a tone is a
 * one-entry addition to `TONE`; nothing else changes.
 *
 * SOLID FILLS, NEVER OPACITY. Each recipe is an opaque `-50`/`-100`/`-700`
 * swatch, never `bg-x-500/15`. A blended fill's contrast depends on whatever
 * sits behind it, so it cannot be verified once and stay verified — and this
 * codebase has already paid for that lesson (see the "Solid tones, never
 * opacity-*: the blended count fell below WCAG AA 4.5:1" note in
 * app/(app)/fleet/_components/ui.tsx, and the sub-AA idioms catalogued in
 * e2e/contrast-sweep-a11y.spec.ts). Opaque swatches let
 * __tests__/ui/tokens.test.ts compute every ratio from Tailwind's own palette
 * and fail the build if one drops below AA.
 *
 * LIGHT ONLY. The product renders light: app/layout.tsx roots `bg-white
 * text-slate-900`, `.dark` is applied nowhere in app/, and there is not one
 * `dark:` class in the 269 files under app/(app). Tokens therefore carry no
 * `dark:` half — a variant that can never activate is not a feature, it is 14
 * accents' worth of dead string to keep in sync.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every consumer renders a text label inside
 * the pill; the tone reinforces meaning, it never carries it alone.
 */

/**
 * The product's tone vocabulary. Six, each earned by real usage in app/(app) —
 * none invented:
 *   slate   neutral / inert            blue    informational, not yet due
 *   emerald good, inside its window    amber   needs attention soon
 *   red     breach, overdue, blocked   indigo  brand accent
 */
export type Tone = "slate" | "blue" | "emerald" | "amber" | "red" | "indigo";

export interface ToneClasses {
  /** The default status pill — an opaque `-100` fill with `-800` text. */
  pill: string;
  /** Low-emphasis pill — a `-50` fill with `-700` text. For "not yet due". */
  soft: string;
  /** Emphatic pill — a `-700` fill with white text. For "this is blocking". */
  solid: string;
  /** A KPI headline value or an accented figure, on a white card. */
  value: string;
}

export const TONES: readonly Tone[] = [
  "slate",
  "blue",
  "emerald",
  "amber",
  "red",
  "indigo",
] as const;

/**
 * The tone map. Contrast ratios are measured against Tailwind's own palette by
 * __tests__/ui/tokens.test.ts, which recomputes them on every run — the numbers
 * in the comments are documentation, the test is the enforcement.
 *
 * `solid` deliberately uses `-700`, not `-600`: at `-600` white text falls below
 * AA for two of the six tones (emerald 3.77:1, amber 3.19:1), so a single safe
 * rule beats a per-tone exception that a future tone would silently get wrong.
 */
export const TONE: Record<Tone, ToneClasses> = {
  // slate keeps the `-700`/`-900` pairing the 51 shipped neutral pills use;
  // `-800` would be a gratuitous shade change for the most common tone.
  slate: {
    pill: "bg-slate-100 text-slate-700", //  9.45:1
    soft: "bg-slate-50 text-slate-700", //  9.90:1
    solid: "bg-slate-700 text-white", // 10.35:1
    value: "text-slate-900", // 17.85:1
  },
  blue: {
    pill: "bg-blue-100 text-blue-800", //  7.15:1
    soft: "bg-blue-50 text-blue-700", //  6.16:1
    solid: "bg-blue-700 text-white", //  6.70:1
    value: "text-blue-700", //  6.70:1
  },
  emerald: {
    pill: "bg-emerald-100 text-emerald-800", //  6.78:1
    soft: "bg-emerald-50 text-emerald-700", //  5.21:1
    solid: "bg-emerald-700 text-white", //  5.48:1
    value: "text-emerald-700", //  5.48:1
  },
  amber: {
    pill: "bg-amber-100 text-amber-800", //  6.37:1
    soft: "bg-amber-50 text-amber-700", //  4.84:1
    solid: "bg-amber-700 text-white", //  5.02:1
    value: "text-amber-700", //  5.02:1
  },
  red: {
    pill: "bg-red-100 text-red-800", //  6.80:1
    soft: "bg-red-50 text-red-700", //  5.91:1
    solid: "bg-red-700 text-white", //  6.47:1
    value: "text-red-700", //  6.47:1
  },
  indigo: {
    pill: "bg-indigo-100 text-indigo-800", //  8.06:1
    soft: "bg-indigo-50 text-indigo-700", //  7.07:1
    solid: "bg-indigo-700 text-white", //  7.90:1
    value: "text-indigo-700", //  7.90:1
  },
};

/** Which of a tone's four recipes to render. */
export type ToneVariant = keyof ToneClasses;

/** Resolve a tone's bundle. Unknown / absent falls back to the inert neutral. */
export function tone(t: Tone | null | undefined): ToneClasses {
  return TONE[t ?? "slate"];
}

/**
 * The class string for one tone/variant pair — the single function every
 * pill, chip and accented value resolves through.
 *
 *   toneClass("red")            → "bg-red-100 text-red-800"
 *   toneClass("blue", "soft")   → "bg-blue-50 text-blue-700"
 *   toneClass("red", "solid")   → "bg-red-700 text-white"
 *   toneClass("amber", "value") → "text-amber-700"
 */
export function toneClass(
  t: Tone | null | undefined,
  variant: ToneVariant = "pill",
): string {
  return tone(t)[variant];
}
