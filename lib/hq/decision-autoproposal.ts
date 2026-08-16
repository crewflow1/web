/**
 * CrewFlow HQ — the deterministic Decision-Centre AUTO-PROPOSAL mapper.
 *
 * The Decision Centre (server/services/hq-decisions.ts, migration 20261091000000) has
 * always taken HAND-AUTHORED proposals: a super-admin types the problem, revenue
 * impact, risk and demand. This module is the deterministic tier that OPENS a DRAFT
 * proposal automatically from REAL system signals — so a critical, revenue-bearing
 * condition the platform already detects (a failed payment, a stalled migration, a
 * churn/health risk, an overdue invoice, an urgent support ticket) surfaces as a
 * proposal a human can act on, rather than sitting only on the alerts board.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY, made a matter of code
 * ───────────────────────────────────────────────────────────────────────────
 *   • It maps signals to a DRAFT proposal ONLY. Every proposal is born `proposed`;
 *     the mapper produces no status, no decider, no outcome. A HUMAN approves,
 *     rejects, delays or delegates. It NEVER decides and NEVER executes.
 *   • HONESTY DOCTRINE (shared with lib/hq/decision-debate.ts): every field is
 *     derived from the signal's OWN real data — the alert's evidence bullets, its
 *     attached MRR, its severity, its suggested action — and NOTHING is invented.
 *     A signal with no MRR says so; it does not fabricate a number.
 *   • DETERMINISTIC + PURE: same signals in → same proposals out. No clock, no
 *     randomness, no I/O, no model call. Trivially testable; the service layer adds
 *     the DB write and the idempotency check.
 *
 * The source-of-truth for signals is the existing HQ alert-rules engine
 * (lib/hq/alert-rules.ts), which is itself pure and deterministic. Only CRITICAL
 * alerts are mapped — a decision proposal is a heavyweight object a human must weigh,
 * so warning/info signals stay on the alerts board and do not raise proposals.
 */

import type { Alert } from "@/lib/hq/alert-rules";

/**
 * A DRAFT decision proposal produced from a signal — the shape the service writes
 * into `hq_decisions` (born `proposed`). Mirrors the human-authored proposal fields,
 * plus the provenance the migration added (`source`, `source_signal_key`).
 */
export interface DraftDecisionProposal {
  /** Concise proposal title, e.g. "Failed payment — Acme Ltd". */
  readonly title: string;
  /** The problem, verbatim from the signal's evidence. */
  readonly problem: string;
  /** Revenue at stake, from the signal's real MRR (honest when none). */
  readonly revenueImpact: string;
  /** The risk this signal represents, from its severity + health band. */
  readonly risk: string;
  /** Customer demand, when the signal carries it; null otherwise (never invented). */
  readonly demand: string | null;
  /** The signal's own suggested next action, verbatim. */
  readonly recommendation: string;
  /** Unconditional — this is the deterministic tier. */
  readonly source: "deterministic";
  /** The originating signal's stable key — the idempotency axis. */
  readonly sourceSignalKey: string;
}

/** A non-empty, trimmed string, or null. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map ONE alert to a draft proposal, or null when the alert should not raise one.
 * Only CRITICAL alerts are mapped; every field is derived from the alert's real
 * data. PURE.
 */
export function mapAlertToProposal(alert: Alert): DraftDecisionProposal | null {
  if (alert.severity !== "critical") return null;

  const orgName = present(alert.orgName) ?? "an organisation";
  const evidence = alert.reason.map((r) => r.trim()).filter((r) => r.length > 0);
  const problem =
    evidence.length > 0
      ? evidence.join(" · ")
      : `${alert.ruleLabel} detected for ${orgName}.`;

  // Revenue impact: the alert's attached MRR, honestly. A zero/absent MRR is stated,
  // never dressed up as a number.
  const revenueImpact =
    alert.mrr > 0
      ? `£${alert.mrr.toLocaleString("en-GB")}/mo MRR at risk (${orgName}).`
      : `No MRR recorded for ${orgName}.`;

  // Risk: severity + the health band when known — the signal's own reading, labelled.
  const healthPart =
    alert.health !== null
      ? ` Health ${alert.health}${alert.healthRisk ? ` (${alert.healthRisk} risk)` : ""}.`
      : "";
  const risk = `Critical signal: ${alert.ruleLabel}.${healthPart}`;

  // Demand is not a signal the alerts engine carries; leave it null rather than
  // fabricate one (the honesty doctrine).
  const demand: string | null = null;

  const recommendation = present(alert.suggestion) ?? "Review this decision and act.";

  return Object.freeze({
    title: `${alert.ruleLabel} — ${orgName}`,
    problem,
    revenueImpact,
    risk,
    demand,
    recommendation,
    source: "deterministic",
    sourceSignalKey: alert.key,
  });
}

/**
 * Map a batch of alerts to draft proposals. Deterministic and total: filters to
 * CRITICAL, maps each, and de-duplicates by signal key WITHIN the batch (a stable
 * signal key can only yield one proposal per run). The persistent, cross-run
 * idempotency (never re-raising a proposal for a signal already seen) is the DB's
 * job via the partial-unique index; this only guards against a duplicate inside one
 * snapshot. Order is preserved from the input for a stable, testable result.
 */
export function mapSignalsToProposals(
  alerts: ReadonlyArray<Alert>,
): DraftDecisionProposal[] {
  const seen = new Set<string>();
  const proposals: DraftDecisionProposal[] = [];
  for (const alert of alerts) {
    const proposal = mapAlertToProposal(alert);
    if (proposal === null) continue;
    if (seen.has(proposal.sourceSignalKey)) continue;
    seen.add(proposal.sourceSignalKey);
    proposals.push(proposal);
  }
  return proposals;
}
