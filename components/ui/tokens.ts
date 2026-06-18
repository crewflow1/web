/**
 * CrewFlow design system — accent tokens.
 *
 * One source of truth for every accent colour used across HQ and the product.
 * Tailwind needs whole literal class strings (it can't see `bg-${a}-500/15`),
 * so each accent spells out its full set once, here, and every component reads
 * from this map instead of re-deriving colour strings. Add an accent in one
 * place and the whole system gains it.
 *
 * Grounded in the live HQ Command Centre + Research surfaces: a `text-300`
 * foreground, a soft `/15` chip with a `/30` ring, an even softer `/10` pill,
 * a blurred `/20` glow blob, a progress-bar fill and a status dot.
 */

export type Accent =
  | "indigo"
  | "emerald"
  | "amber"
  | "sky"
  | "violet"
  | "cyan"
  | "fuchsia"
  | "rose"
  | "slate";

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
  "sky",
  "violet",
  "cyan",
  "fuchsia",
  "rose",
  "slate",
];

export const ACCENT: Record<Accent, AccentClasses> = {
  indigo: {
    text: "text-indigo-300",
    glow: "bg-indigo-500/20",
    chip: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
    soft: "bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-400/20",
    bar: "bg-indigo-400/80",
    dot: "bg-indigo-400",
  },
  emerald: {
    text: "text-emerald-300",
    glow: "bg-emerald-500/20",
    chip: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
    soft: "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20",
    bar: "bg-emerald-400/80",
    dot: "bg-emerald-400",
  },
  amber: {
    text: "text-amber-300",
    glow: "bg-amber-500/20",
    chip: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
    soft: "bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/20",
    bar: "bg-amber-400/80",
    dot: "bg-amber-400",
  },
  sky: {
    text: "text-sky-300",
    glow: "bg-sky-500/20",
    chip: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
    soft: "bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
    bar: "bg-sky-400/80",
    dot: "bg-sky-400",
  },
  violet: {
    text: "text-violet-300",
    glow: "bg-violet-500/20",
    chip: "bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-400/30",
    soft: "bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
    bar: "bg-violet-400/80",
    dot: "bg-violet-400",
  },
  cyan: {
    text: "text-cyan-300",
    glow: "bg-cyan-500/20",
    chip: "bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-400/30",
    soft: "bg-cyan-500/10 text-cyan-300 ring-1 ring-inset ring-cyan-400/20",
    bar: "bg-cyan-400/80",
    dot: "bg-cyan-400",
  },
  fuchsia: {
    text: "text-fuchsia-300",
    glow: "bg-fuchsia-500/20",
    chip: "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/30",
    soft: "bg-fuchsia-500/10 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/20",
    bar: "bg-fuchsia-400/80",
    dot: "bg-fuchsia-400",
  },
  rose: {
    text: "text-rose-300",
    glow: "bg-rose-500/20",
    chip: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
    soft: "bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/20",
    bar: "bg-rose-400/80",
    dot: "bg-rose-400",
  },
  slate: {
    text: "text-slate-200",
    glow: "bg-slate-500/20",
    chip: "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
    soft: "bg-slate-800/80 text-slate-300 ring-1 ring-inset ring-slate-700",
    bar: "bg-slate-600",
    dot: "bg-slate-400",
  },
};

/** Resolve an accent's class bundle, defaulting to the calm slate set. */
export function accent(a: Accent | null | undefined): AccentClasses {
  return ACCENT[a ?? "slate"];
}
