/**
 * PROVENANCE — the shared labelling contract for the deterministic
 * intelligence layer. PURE: types, constants and two tiny constructors. No
 * I/O, no clock, no imports beyond nothing at all.
 *
 * ── THE DOCTRINE THIS MODULE ENFORCES ───────────────────────────────────────
 * Every figure the intelligence layer emits LABELS ITSELF. There is no opaque
 * composite score anywhere in lib/intelligence/** and none may be added —
 * lib/suppliers/performance.ts header points 1 to 2 are the house precedent (a
 * weight is an opinion wearing a number's clothes; no honest arithmetic
 * combines metrics with different denominators). A ratchet test greps this
 * directory for composite-score words.
 *
 * The kind ladder is modelled on the richest existing conventions:
 *   · lib/commercial/cash-out.ts — the OWED/DUE/COMMITTED/UNTRACKED certainty
 *     ladder with an orthogonal `isEstimate` flag and a plain-English `basis`
 *     string on every component;
 *   · lib/suppliers/performance.ts — `Ratio` withholds a percentage below
 *     MIN_RATED_SAMPLE, so a rate the sample has not earned cannot render;
 *   · lib/job-progress/series.ts — per-point `source` provenance;
 *   · lib/profitability/compute.ts — `marginBand`'s explicit 'neutral'
 *     no-data state (absence is an answer, never a zero).
 *
 * ── THE THREE KINDS ─────────────────────────────────────────────────────────
 *   fact       Ledger rows read directly and restated — a count of rows, a
 *              stored column echoed back. Nothing was computed beyond reading.
 *   derived    Arithmetic over facts, exact. A sum, a difference, a clamp, a
 *              ratio of observed quantities. Reproducible from the inputs
 *              alone; two people with the same rows get the same number.
 *   heuristic  A JUDGEMENT RULE applied to derived figures — a threshold
 *              somebody chose ("top customer above 40 %", "no reading for 14
 *              days"). The rule itself is stated VERBATIM in `basis`, because
 *              a heuristic whose assumptions are hidden is indistinguishable
 *              from a fact to the reader, and that is the lie this enum
 *              exists to prevent.
 *
 * ── DELIBERATELY ABSENT KINDS ───────────────────────────────────────────────
 * There is NO 'prediction', NO 'model' and NO 'ai_narrative' variant here.
 * Nothing generative ships in this train. Those labels arrive together with a
 * bound model behind the governed provider abstraction — never before, and
 * never as a relabelling of a heuristic. Adding a member to `SignalKind` is a
 * product decision, not a refactor.
 */

// ---------------------------------------------------------------------------
// The kind ladder
// ---------------------------------------------------------------------------

export const SIGNAL_KINDS = ["fact", "derived", "heuristic"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** The badge word. Rendered as TEXT next to every figure — never colour-only. */
export const SIGNAL_KIND_LABEL: Record<SignalKind, string> = {
  fact: "Fact",
  derived: "Derived",
  heuristic: "Heuristic",
};

/** One-line reader-facing gloss, for tooltips / legend rows. */
export const SIGNAL_KIND_DESCRIPTION: Record<SignalKind, string> = {
  fact: "Read straight from your records.",
  derived: "Exact arithmetic over your records — no assumptions.",
  heuristic: "A stated rule of thumb applied to your records. The rule is in the basis line.",
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** A record set a figure was computed from, with somewhere to go and check it. */
export interface EvidenceRef {
  /** Human name of the source ("Invoices", "Rota", "Snags"). */
  label: string;
  /** In-app drill-through to the underlying records. */
  href: string;
}

/** A Europe/London calendar-day window, both ends inclusive. */
export interface DayWindow {
  fromDay: string;
  toDay: string;
}

export interface SignalProvenance {
  kind: SignalKind;
  /**
   * Plain English: where the number comes from, what it does not include, and
   * — for a heuristic — the rule verbatim. The cash-out convention: the basis
   * travels WITH the number so no surface can print one without the other.
   */
  basis: string;
  /** The London-pinned day window the figure covers, when it is windowed. */
  window?: DayWindow | null;
  /** Every record set behind the figure. Never empty on a shipped metric. */
  computedFrom: EvidenceRef[];
  /**
   * True when a rate or a flag was WITHHELD because the sample was too small
   * (the MIN_RATED_SAMPLE discipline). The surface says so instead of showing
   * a percentage the data has not earned.
   */
  sampleFloorApplied?: boolean;
}

/**
 * A value that carries its own label. The intelligence surface renders ONLY
 * these — a bare number with no provenance has no way onto a card.
 */
export interface LabelledMetric<T> {
  value: T;
  provenance: SignalProvenance;
}

/**
 * Construct a labelled metric. Throws on an empty basis in development-style
 * usage (a metric with nothing to say for itself is exactly what this layer
 * forbids); kept as a plain construction otherwise.
 */
export function labelled<T>(value: T, provenance: SignalProvenance): LabelledMetric<T> {
  if (!provenance.basis || provenance.basis.trim().length === 0) {
    throw new Error("intelligence: a metric must state its basis");
  }
  if (!provenance.computedFrom || provenance.computedFrom.length === 0) {
    throw new Error("intelligence: a metric must name what it was computed from");
  }
  return { value, provenance };
}
