/**
 * CrewFlow HQ — Executive runner derivations (MP Wave: exec execution path).
 *
 * The 13 EXECUTIVE employees (CEO, CTO, CFO, COO, Sales, Marketing, Product, QA,
 * Finance, Operations, Support, Customer Success, Executive Assistant) each produced
 * a DETERMINISTIC board + a DARK LLM narrative, but NONE had an execution path: none
 * registered a Task-Engine handler, drained a queue, or wrote an auditable result.
 * This module is the pure, DETERMINISTIC core of that execution path — it folds an
 * employee's ALREADY-COMPUTED board (the same deterministic board the super-admin
 * console renders) into an explainable REVIEW: a prioritised, sourced set of findings
 * a HUMAN can act on, plus an honest coverage/gap ledger.
 *
 * Server/client-safe — NO Supabase / server-only / model imports, exactly like
 * `lib/hq/roster-runners.ts` and `lib/hq/boardroom-cards.ts`. `now` is INJECTED
 * everywhere so every derivation is deterministic and testable.
 *
 * The two first principles (shared with lib/hq/roster-runners.ts) run through it:
 *   1. HONEST "insufficient" — when the board carries no fact and no signal we say so
 *      and never conjure a green review. A board metric that is `insufficient` is
 *      reported as a GAP (a data source not yet wired), never as a fabricated figure.
 *   2. NO irreversible action, HUMAN keeps final approval — the review COMPUTES and
 *      REPORTS. Every result carries `requiresHumanApproval: true` and
 *      `autonomousApply: false` as first-class, testable facts. Nothing here sends,
 *      commits, decides, or mutates; the service layer completes a Task-Engine task
 *      with the result, and the engine's terminal transition is the audit of record.
 *
 * The shape is a superset of the standard AI output envelope (`RunnerEnvelope`), so a
 * runner returns it verbatim and the engine persists it into the task `result` jsonb
 * the Boardroom already reads.
 */

import type { RunnerEnvelope } from "@/lib/hq/roster-runners";

// ---------------------------------------------------------------------
// Shared shapes.
// ---------------------------------------------------------------------

/** The uniform metric shape every exec board exposes (`{Role}Metric`). */
export interface ExecMetricInput {
  key: string;
  label: string;
  /** `fact`/`derived` = a covered figure; `insufficient` = a data gap (no source). */
  kind: "fact" | "derived" | "insufficient";
  value: number | null;
  /** The metric's own one-line basis (provenance / why-insufficient). */
  basis?: string;
}

/** A concerning domain signal the runner extracts from board-specific fields. */
export type ExecSeverity = "critical" | "warning" | "watch";

export interface ExecSignal {
  /** Stable key within the review (dedupe axis). */
  key: string;
  label: string;
  severity: ExecSeverity;
  /** Human-legible detail, derived from the board's OWN real figures. */
  detail: string;
  /** The data source this signal was read from — provenance, never fabricated. */
  source: string;
}

/** A finding = a validated signal + the human-approvable next step it maps to. */
export interface ExecFinding extends ExecSignal {
  /** The suggested next step — a HUMAN acts on it; the runner never does. */
  proposedAction: string;
}

/** The review verdict rolled up from the findings. */
export type ExecReviewVerdict = "critical" | "attention" | "clear" | "insufficient";

export interface ExecReviewResult extends RunnerEnvelope {
  kind: "exec_review";
  /** The employee slug this review is attributed to (e.g. "cfo-ai"). */
  role: string;
  /** Human role label (e.g. "CFO"). */
  roleLabel: string;
  verdict: ExecReviewVerdict;
  /** Coverage ledger — how much of the domain the board could actually report. */
  coverage: { facts: number; derived: number; gaps: number; total: number };
  /** The data gaps — metrics with no source yet (honest, never fabricated). */
  gaps: Array<{ key: string; label: string; basis: string }>;
  /** The prioritised, sourced findings a human can act on. */
  findings: ExecFinding[];
  /** ALWAYS true — the human-approval floor, pinned in the output. */
  requiresHumanApproval: true;
  /** ALWAYS false — the review never applies anything autonomously. */
  autonomousApply: false;
}

const SEVERITY_RANK: Record<ExecSeverity, number> = {
  critical: 0,
  warning: 1,
  watch: 2,
};

/** The human-approvable next step a severity maps to. Deterministic, never an act. */
function proposedActionFor(severity: ExecSeverity): string {
  switch (severity) {
    case "critical":
      return "Escalate for a human decision now.";
    case "warning":
      return "Review and prioritise with the human owner.";
    case "watch":
      return "Monitor; no action required yet.";
  }
}

/** A non-empty trimmed string, or a fallback. */
function present(value: string | null | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const t = value.trim();
  return t.length > 0 ? t : fallback;
}

export interface ExecReviewInput {
  /** Employee slug (attribution). */
  role: string;
  /** Human role label. */
  roleLabel: string;
  /** The board's uniform metrics. */
  metrics: ReadonlyArray<ExecMetricInput>;
  /** Domain signals the runner extracted from board-specific fields. */
  signals: ReadonlyArray<ExecSignal>;
  /** Named data sources this review was derived from — provenance. */
  sources: ReadonlyArray<string>;
}

/**
 * Fold an exec board (its uniform metrics) + the runner's extracted domain signals
 * into a single explainable review. PURE + DETERMINISTIC: same inputs → same output.
 *
 * Honesty:
 *   • A board with no metric AND no signal is honestly `insufficient` (confidence 0) —
 *     never a green review conjured from an empty board.
 *   • `insufficient`-kind metrics are reported as GAPS with their own basis; they are
 *     never counted as covered figures and never fabricated into a number.
 *   • Signals are deduped by key and ordered deterministically (severity, then key),
 *     so the review is stable for a given board.
 */
export function summariseExecReview(
  input: ExecReviewInput,
  now: Date,
): ExecReviewResult {
  const generatedAt = now.toISOString();
  const { role, roleLabel, metrics, signals } = input;
  const sources = [...input.sources];

  // Coverage ledger.
  let facts = 0;
  let derived = 0;
  const gaps: Array<{ key: string; label: string; basis: string }> = [];
  for (const m of metrics) {
    if (m.kind === "fact") facts += 1;
    else if (m.kind === "derived") derived += 1;
    else {
      gaps.push({
        key: m.key,
        label: m.label,
        basis: present(m.basis, "No data source wired for this figure yet."),
      });
    }
  }
  const coverage = { facts, derived, gaps: gaps.length, total: metrics.length };

  // Dedupe signals by key (first wins) and normalise into findings.
  const seen = new Set<string>();
  const findings: ExecFinding[] = [];
  for (const s of signals) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    findings.push({
      key: s.key,
      label: s.label,
      severity: s.severity,
      detail: s.detail,
      source: s.source,
      proposedAction: proposedActionFor(s.severity),
    });
  }
  // Stable order: severity (critical→watch), then key.
  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.key.localeCompare(b.key),
  );

  // Honest insufficient: nothing to review at all.
  const covered = facts + derived;
  if (metrics.length === 0 && findings.length === 0) {
    return Object.freeze({
      kind: "exec_review",
      role,
      roleLabel,
      summary: `Insufficient data — no ${roleLabel} board metric or signal to review yet.`,
      reasoning:
        `The ${roleLabel} review read an empty board — zero metrics and zero signals — so no ` +
        `finding can be claimed. This is an honest empty read, not a clear result.`,
      confidence: 0,
      insufficient: true,
      generatedAt,
      sources,
      verdict: "insufficient",
      coverage,
      gaps,
      findings,
      requiresHumanApproval: true,
      autonomousApply: false,
    }) as ExecReviewResult;
  }

  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasWarning = findings.some((f) => f.severity === "warning");
  const hasWatch = findings.some((f) => f.severity === "watch");

  // Verdict roll-up: worst signal wins; gaps alone raise "attention" (a domain we
  // cannot fully report is not "clear"); a fully-covered board with no signal is
  // genuinely "clear".
  let verdict: ExecReviewVerdict;
  if (hasCritical) verdict = "critical";
  else if (hasWarning) verdict = "attention";
  else if (hasWatch || gaps.length > 0) verdict = "attention";
  else if (covered > 0) verdict = "clear";
  else verdict = "insufficient";

  // Confidence: a review over at least one covered figure is fully determined (1);
  // a review carrying only gaps/signals but no covered figure is honestly partial (0).
  const confidence = covered > 0 ? 1 : 0;
  const insufficient = verdict === "insufficient";

  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  const summary =
    verdict === "clear"
      ? `${roleLabel}: all clear across ${covered} covered figure${covered === 1 ? "" : "s"}` +
        (gaps.length > 0 ? ` (${gaps.length} data gap${gaps.length === 1 ? "" : "s"}).` : ".")
      : verdict === "critical"
        ? `${roleLabel}: ${criticalCount} critical finding${criticalCount === 1 ? "" : "s"} need a human decision.`
        : verdict === "attention"
          ? `${roleLabel}: ${findings.length} finding${findings.length === 1 ? "" : "s"} for review` +
            (gaps.length > 0 ? ` and ${gaps.length} data gap${gaps.length === 1 ? "" : "s"}.` : ".")
          : `${roleLabel}: insufficient covered data to review.`;

  const reasoning =
    `Deterministic review of the ${roleLabel} board: ${facts} fact${facts === 1 ? "" : "s"}, ` +
    `${derived} derived figure${derived === 1 ? "" : "s"}, ${gaps.length} gap${gaps.length === 1 ? "" : "s"}. ` +
    `Findings (${criticalCount} critical, ${warningCount} warning) are read straight from the board's own ` +
    `figures and carry their source; no figure is estimated and no model is consulted. Every finding is a ` +
    `draft for a human — nothing is applied.`;

  return Object.freeze({
    kind: "exec_review",
    role,
    roleLabel,
    summary,
    reasoning,
    confidence,
    insufficient,
    generatedAt,
    sources,
    verdict,
    coverage,
    gaps,
    findings,
    requiresHumanApproval: true,
    autonomousApply: false,
  }) as ExecReviewResult;
}
