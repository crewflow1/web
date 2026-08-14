/**
 * CrewFlow HQ — the deterministic Decision-Centre debate producer (P2 HQ AI Operating System).
 *
 * The Decision Centre (server/services/hq-decisions.ts, migration 20261091000000) reserved an
 * `ai_debate` slot on every decision — "empty today; the AI tier fills it once a tier is bound".
 * The detail page renders it and shows "AI debate populates once a model tier is bound." Nothing
 * ever produced it. This module is that producer's DETERMINISTIC tier: it composes a structured
 * pro/con debate from the decision's REAL, already-captured signals — revenue impact, demand,
 * engineering cost, risk, timeline — and NOTHING else.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HONESTY DOCTRINE — labels the real signals, fabricates nothing
 * ───────────────────────────────────────────────────────────────────────────
 * Each entry's `detail` is the operator's OWN signal text, verbatim; the producer only decides
 * whether a given signal argues FOR (a benefit — revenue, demand), AGAINST (a cost — engineering
 * effort, risk), or is a neutral CONSIDERATION (timeline, the problem being solved). It invents no
 * argument and paraphrases nothing. When a decision carries NO structured signals, it returns a
 * single explicit `insufficient` entry rather than manufacturing a debate — the honesty doctrine
 * made a matter of code (insufficient, never fabricated).
 *
 * Every entry is stamped `source: "deterministic"`. The GENERATIVE variant — a model reasoning
 * freely over the same signals to argue positions the operator did not write — is DARK: it would
 * stamp `source: "generated"` and pass through the governor (lib/ai/governor), whose every tier is
 * null today, so it cannot run. This module makes NO model call.
 *
 * PURE + TOTAL: same signals → same debate, always. No clock, no randomness, no I/O — so it is
 * trivially testable and the produced debate can always be re-derived from the decision row.
 */

/** Whether a debate entry argues for, against, or is a neutral consideration. */
export type DebatePosition = "pro" | "con" | "consideration";

/**
 * One structured debate entry — the deterministic shape stored in `hq_decisions.ai_debate`. It is
 * a plain object (the column is `DebateEntry[] = Record<string, unknown>[]`), so this is the typed
 * view of what the producer writes. `detail` is the operator's verbatim signal; `headline` is a
 * fixed deterministic label; `source` is unconditionally `"deterministic"`.
 */
export interface DecisionDebateEntry {
  readonly position: DebatePosition;
  /** Which decision signal this entry is derived from (stable machine key). */
  readonly signal: string;
  /** A fixed, deterministic label for the signal — never generated. */
  readonly headline: string;
  /** The decision's own signal text, verbatim (fabricates nothing). */
  readonly detail: string;
  /** Unconditional — this is the deterministic tier; the generative tier is dark. */
  readonly source: "deterministic";
}

/**
 * The subset of a decision the debate is composed from — its real, structured signals. A subset of
 * `DecisionRow` (server/services/hq-decisions.ts), decoupled so this producer stays pure and
 * DB-free. Every field is nullable, exactly as the column is.
 */
export interface DecisionDebateSignals {
  readonly problem?: string | null;
  readonly businessImpact?: string | null;
  readonly revenueImpact?: string | null;
  readonly demand?: string | null;
  readonly engineeringCost?: string | null;
  readonly risk?: string | null;
  readonly timeline?: string | null;
}

/**
 * The fixed signal → (position, headline) map, in the deterministic ORDER entries are emitted. A
 * revenue impact and customer demand argue FOR; an engineering cost and a risk argue AGAINST; the
 * problem, business impact and timeline are neutral considerations. The order is stable so the same
 * decision always yields the same debate.
 */
const SIGNAL_PLAN: ReadonlyArray<{
  readonly key: keyof DecisionDebateSignals;
  readonly signal: string;
  readonly position: DebatePosition;
  readonly headline: string;
}> = [
  { key: "revenueImpact", signal: "revenue_impact", position: "pro", headline: "Revenue impact" },
  { key: "demand", signal: "demand", position: "pro", headline: "Customer demand" },
  { key: "businessImpact", signal: "business_impact", position: "pro", headline: "Business impact" },
  { key: "engineeringCost", signal: "engineering_cost", position: "con", headline: "Engineering cost" },
  { key: "risk", signal: "risk", position: "con", headline: "Risk" },
  { key: "problem", signal: "problem", position: "consideration", headline: "Problem to solve" },
  { key: "timeline", signal: "timeline", position: "consideration", headline: "Timeline" },
];

/** A non-empty, trimmed signal string, or null. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The single honest entry emitted when a decision carries no structured signals. */
export const INSUFFICIENT_DEBATE_ENTRY: DecisionDebateEntry = Object.freeze({
  position: "consideration",
  signal: "insufficient",
  headline: "Insufficient signal",
  detail:
    "No structured signals (revenue, demand, cost, risk, timeline) were captured for this decision, so a debate cannot be composed without inventing one.",
  source: "deterministic",
});

/**
 * Compose the deterministic pro/con debate for a decision from its real signals. Returns entries in
 * the fixed {@link SIGNAL_PLAN} order — pros, then cons, then considerations — one per PRESENT
 * signal, each carrying that signal's verbatim text. When no signal is present, returns exactly one
 * {@link INSUFFICIENT_DEBATE_ENTRY} rather than fabricating a debate. Pure and total; makes no model
 * call.
 */
export function composeDecisionDebate(
  signals: DecisionDebateSignals,
): DecisionDebateEntry[] {
  const entries: DecisionDebateEntry[] = [];
  for (const plan of SIGNAL_PLAN) {
    const detail = present(signals[plan.key]);
    if (detail === null) continue;
    entries.push(
      Object.freeze({
        position: plan.position,
        signal: plan.signal,
        headline: plan.headline,
        detail,
        source: "deterministic",
      }),
    );
  }
  if (entries.length === 0) return [INSUFFICIENT_DEBATE_ENTRY];
  return entries;
}

/** Whether a composed debate is the honest "insufficient" placeholder (no real signals). */
export function isInsufficientDebate(entries: readonly DecisionDebateEntry[]): boolean {
  return entries.length === 1 && entries[0]!.signal === "insufficient";
}
