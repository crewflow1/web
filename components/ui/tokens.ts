/**
 * CrewFlow design system — accent tokens.
 *
 * One source of truth for every accent colour used across HQ and the product.
 * Tailwind needs whole literal class strings (it can't see `bg-${a}-500/15`),
 * so each accent spells out its full set once, here, and every component reads
 * from this map instead of re-deriving colour strings. Add an accent in one
 * place and the whole system gains it.
 *
 * Theme-aware: each token carries a light default and a `dark:` variant whose
 * value is the exact dark string the system shipped with, so HQ (rooted in
 * `.dark`) renders byte-identical while the customer product gets a legible
 * light treatment. Grounded in the live HQ Command Centre + Research surfaces:
 * a saturated foreground, a soft tinted chip with a hairline ring, an even
 * softer pill, a blurred glow blob, a progress-bar fill and a status dot.
 */

export type Accent =
  | "indigo"
  | "emerald"
  | "amber"
  | "orange"
  | "sky"
  | "violet"
  | "cyan"
  | "fuchsia"
  | "rose"
  | "red"
  | "slate"
  | "neutral"
  | "muted";

export interface AccentClasses {
  /** Foreground for headline values, icons and labels. */
  text: string;
  /** Blurred background blob behind a card corner. */
  glow: string;
  /** Solid chip: icon tiles + emphatic pills (`/15` fill, `/30` ring). */
  chip: string;
  /** Softer pill for chip lists (`/10` fill, `/20` ring). */
  soft: string;
  /** Progress / meter bar fill. */
  bar: string;
  /** Small status dot. */
  dot: string;
}

export const ACCENTS: Accent[] = [
  "indigo",
  "emerald",
  "amber",
  "orange",
  "sky",
  "violet",
  "cyan",
  "fuchsia",
  "rose",
  "red",
  "slate",
  "neutral",
  "muted",
];

export const ACCENT: Record<Accent, AccentClasses> = {
  indigo: {
    text: "text-indigo-600 dark:text-indigo-300",
    glow: "bg-indigo-500/20",
    chip: "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-400/30",
    soft: "bg-indigo-50/60 text-indigo-700 ring-1 ring-inset ring-indigo-600/15 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20",
    bar: "bg-indigo-500 dark:bg-indigo-400/80",
    dot: "bg-indigo-500 dark:bg-indigo-400",
  },
  emerald: {
    text: "text-emerald-600 dark:text-emerald-300",
    glow: "bg-emerald-500/20",
    chip: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30",
    soft: "bg-emerald-50/60 text-emerald-700 ring-1 ring-inset ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
    bar: "bg-emerald-500 dark:bg-emerald-400/80",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  amber: {
    text: "text-amber-600 dark:text-amber-300",
    glow: "bg-amber-500/20",
    chip: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/30",
    soft: "bg-amber-50/60 text-amber-700 ring-1 ring-inset ring-amber-600/15 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
    bar: "bg-amber-500 dark:bg-amber-400/80",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  orange: {
    text: "text-orange-600 dark:text-orange-300",
    glow: "bg-orange-500/20",
    chip: "bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/30",
    soft: "bg-orange-50/60 text-orange-700 ring-1 ring-inset ring-orange-600/15 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20",
    bar: "bg-orange-500 dark:bg-orange-400/80",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  sky: {
    text: "text-sky-600 dark:text-sky-300",
    glow: "bg-sky-500/20",
    chip: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30",
    soft: "bg-sky-50/60 text-sky-700 ring-1 ring-inset ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20",
    bar: "bg-sky-500 dark:bg-sky-400/80",
    dot: "bg-sky-500 dark:bg-sky-400",
  },
  violet: {
    text: "text-violet-600 dark:text-violet-300",
    glow: "bg-violet-500/20",
    chip: "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-600/20 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/30",
    soft: "bg-violet-50/60 text-violet-700 ring-1 ring-inset ring-violet-600/15 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20",
    bar: "bg-violet-500 dark:bg-violet-400/80",
    dot: "bg-violet-500 dark:bg-violet-400",
  },
  cyan: {
    text: "text-cyan-600 dark:text-cyan-300",
    glow: "bg-cyan-500/20",
    chip: "bg-cyan-50 text-cyan-700 ring-1 ring-inset ring-cyan-600/20 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-400/30",
    soft: "bg-cyan-50/60 text-cyan-700 ring-1 ring-inset ring-cyan-600/15 dark:bg-cyan-500/10 dark:text-cyan-300 dark:ring-cyan-400/20",
    bar: "bg-cyan-500 dark:bg-cyan-400/80",
    dot: "bg-cyan-500 dark:bg-cyan-400",
  },
  fuchsia: {
    text: "text-fuchsia-600 dark:text-fuchsia-300",
    glow: "bg-fuchsia-500/20",
    chip: "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-600/20 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-400/30",
    soft: "bg-fuchsia-50/60 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-600/15 dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:ring-fuchsia-400/20",
    bar: "bg-fuchsia-500 dark:bg-fuchsia-400/80",
    dot: "bg-fuchsia-500 dark:bg-fuchsia-400",
  },
  rose: {
    text: "text-rose-600 dark:text-rose-300",
    glow: "bg-rose-500/20",
    chip: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/30",
    soft: "bg-rose-50/60 text-rose-700 ring-1 ring-inset ring-rose-600/15 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
    bar: "bg-rose-500 dark:bg-rose-400/80",
    dot: "bg-rose-500 dark:bg-rose-400",
  },
  red: {
    text: "text-red-600 dark:text-red-300",
    glow: "bg-red-500/20",
    chip: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-400/30",
    soft: "bg-red-50/60 text-red-700 ring-1 ring-inset ring-red-600/15 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
    bar: "bg-red-500 dark:bg-red-400/80",
    dot: "bg-red-500 dark:bg-red-400",
  },
  slate: {
    text: "text-slate-700 dark:text-slate-200",
    glow: "bg-slate-500/20",
    chip: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300 dark:bg-slate-700/40 dark:text-slate-300 dark:ring-slate-600/40",
    soft: "bg-slate-50 text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:ring-slate-700",
    bar: "bg-slate-500 dark:bg-slate-600",
    dot: "bg-slate-400",
  },
  // Two distinct neutral states (CEO Directive 007.6, Option A) — kept
  // separate so an "active but neutral" pill and a "muted / disabled" pill
  // never collapse into one another. Dark halves are byte-identical to the
  // hand-spelled recipes the AI-platform surfaces shipped with.
  neutral: {
    text: "text-slate-600 dark:text-slate-300",
    glow: "bg-slate-500/20",
    chip: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/30 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-400/30",
    soft: "bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-300 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-400/20",
    bar: "bg-slate-500 dark:bg-slate-400/80",
    dot: "bg-slate-500 dark:bg-slate-400",
  },
  muted: {
    text: "text-slate-500 dark:text-slate-400",
    glow: "bg-slate-500/10",
    chip: "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-300 dark:bg-slate-700/40 dark:text-slate-400 dark:ring-slate-600/40",
    soft: "bg-slate-50 text-slate-500 ring-1 ring-inset ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700",
    bar: "bg-slate-400 dark:bg-slate-600",
    dot: "bg-slate-400 dark:bg-slate-600",
  },
};

/** Resolve an accent's class bundle, defaulting to the calm slate set. */
export function accent(a: Accent | null | undefined): AccentClasses {
  return ACCENT[a ?? "slate"];
}

/**
 * The canonical status pill for a tone — the solid chip fill (`/15` bg, `/30`
 * ring). HQ is rooted in `.dark` (app/admin/layout.tsx), so this renders
 * byte-identical to the legacy hand-spelled `bg-{c}-500/15 text-{c}-300 ring-1
 * ring-inset ring-{c}-400/30` recipe the sales / memory / research / employee
 * surfaces each grew independently. One source now: retune a colour here and
 * every status pill across HQ follows. Tailwind sees the literals in `ACCENT`,
 * so the JIT scanner still emits them.
 */
export function pill(tone: Accent | null | undefined): string {
  return accent(tone).chip;
}

/** Softer status pill — `/10` fill, `/20` ring. For low-emphasis tags. */
export function pillSoft(tone: Accent | null | undefined): string {
  return accent(tone).soft;
}

/** The status dot swatch for a tone (pair with `<Dot pulse />` for "live"). */
export function statusDot(tone: Accent | null | undefined): string {
  return accent(tone).dot;
}
