/**
 * CrewFlow HQ — the standard AI output envelope + the evidence-drain
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §10).
 *
 * P3 (Volume XIII §10) names ONE shape every AI employee's terminal result should
 * take — `summary · reasoning · confidence · evidence[] · alternatives[] ·
 * approvalRequired · actions[]` — so a result reads the same whoever produced it.
 * Phase A introduces it as the SDK's canonical return type and wires the runner to
 * AUTO-POPULATE `evidence[]` from the memory facet (the drain), so an employee gets a
 * provenance trail with zero handler code.
 *
 * Backward compatibility (the SDK Stability Rule, ADR 0008; Architecture-Freeze §2.4
 * "extend before replace"). EVERY field is optional and an index signature admits
 * extra domain keys, so a handler returning its existing free-form result object is
 * still a valid output — the envelope is ADDITIVE, never a forced migration. The
 * runner therefore NARROWS nothing it accepted before Phase A (see {@link TaskResult}).
 *
 * Pure + I/O-free (deliberately NO `server-only`): the timeline / Boardroom UI may
 * import these types to render an employee's output, exactly as it imports the event
 * registry's `Verb` union. It carries no secrets and reaches for no server module.
 */

/** One alternative an employee considered but did not choose (§10). */
export interface AiAlternative {
  /** The alternative, in one line. */
  summary: string;
  /** Why it was weighed — and ultimately not chosen. */
  reasoning?: string;
  /** Confidence in it, 0..1. */
  confidence?: number;
}

/**
 * One action an employee PROPOSES as part of its result (§10). Phase A only TYPES this
 * field — nothing here executes or authorises an action. The permission gate that turns
 * a proposed action into an approval request is Phase B; the capability a given action
 * requires is sourced by the Capability Registry (#015). An action is a description of
 * intent, never an execution.
 */
export interface AiAction {
  /** A capability-style verb naming what the employee proposes to do. */
  type: string;
  /** Human-readable description of the proposed action. */
  description?: string;
  /** Structured parameters the action would take. */
  payload?: Record<string, unknown>;
  /** The capability token this action would require (Phase B authorises; #015 sources). */
  capability?: string;
}

/**
 * The standard output envelope (P3, Volume XIII §10) — the canonical shape an AI
 * employee's terminal result takes. EVERY field is optional (an employee fills what it
 * has) and the index signature admits domain-specific keys, so the envelope is a
 * back-compatible superset of the legacy free-form result (ADR 0008 SDK Stability Rule).
 * `evidence[]` is the memory provenance the runner drains in automatically.
 */
export interface AiOutput {
  /** A short natural-language summary of the outcome. */
  summary?: string;
  /** The reasoning behind it. */
  reasoning?: string;
  /** Confidence in the outcome, 0..1. */
  confidence?: number;
  /**
   * The ids of the memories this result drew on. A handler MAY set it; the runner
   * AUTO-FILLS it from the memory facet's recalled ids (the evidence-drain), merging
   * with anything the handler supplied — the §10 provenance trail, for free.
   */
  evidence?: string[];
  /** Alternatives the employee considered but did not choose. */
  alternatives?: AiAlternative[];
  /** Whether the outcome needs human approval before it takes effect. */
  approvalRequired?: boolean;
  /** Actions the employee proposes (typed in Phase A; gated in Phase B). */
  actions?: AiAction[];
  /** Domain-specific result fields — the envelope never forbids extra keys. */
  [key: string]: unknown;
}

/**
 * What a task handler may return. The CANONICAL form is the {@link AiOutput} envelope;
 * for backward compatibility a handler may also return any plain result object (the
 * legacy free-form result), which the runner treats as an envelope carrying only extra
 * keys. `void` records an empty result. This union is deliberately WIDE so #014 narrows
 * nothing the runner accepted before Phase A (ADR 0008 SDK Stability Rule).
 */
export type TaskResult = AiOutput | Record<string, unknown>;

/** De-duplicate a string list, preserving first-seen order. */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Fold the memory facet's recalled ids into a result's `evidence[]` (the evidence-drain,
 * Volume XIII §10) — the runner calls this at completion so an employee never threads
 * provenance by hand:
 *
 *   • no recalled ids        → the result is returned UNCHANGED (a handler that never
 *                              reads memory pays nothing; void stays void);
 *   • a result object        → `evidence[]` becomes (handler-supplied ∪ recalled),
 *                              de-duplicated in first-seen order; every other field is
 *                              preserved — a SHALLOW COPY, so the handler's object is
 *                              never mutated;
 *   • void / null + evidence → a minimal `{ evidence }` envelope is synthesised so the
 *                              provenance is not silently dropped.
 *
 * Operates structurally on `Record<string, unknown>`, so it is valid for BOTH a typed
 * {@link AiOutput} and a legacy free-form result.
 */
export function drainEvidenceInto(
  result: TaskResult | void,
  recalledIds: readonly string[],
): TaskResult | void {
  if (recalledIds.length === 0) return result ?? undefined;

  const supplied =
    result && typeof result === "object" && Array.isArray((result as AiOutput).evidence)
      ? ((result as AiOutput).evidence as string[])
      : [];
  const evidence = dedupeStrings([...supplied, ...recalledIds]);

  const base: Record<string, unknown> =
    result && typeof result === "object" ? { ...result } : {};
  base.evidence = evidence;
  return base;
}
