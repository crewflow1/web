import "server-only";
import { buildAlertsSnapshot } from "@/server/services/hq-alerts-snapshot";
import { runAlertRules } from "@/lib/hq/alert-rules";
import { mapSignalsToProposals } from "@/lib/hq/decision-autoproposal";
import { openDeterministicProposal } from "@/server/services/hq-decisions";

/**
 * CrewFlow HQ — the Decision-Centre AUTO-PROPOSAL service.
 *
 * The runtime tier of the deterministic auto-proposer. It reads the platform's REAL
 * signals (the HQ alert-rules engine's live snapshot), maps the CRITICAL ones to
 * DRAFT decision proposals (lib/hq/decision-autoproposal.ts, pure), and OPENS each
 * one in the Decision Centre as a `proposed` row for a HUMAN to weigh.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NEVER DO
 * ───────────────────────────────────────────────────────────────────────────
 *   • It NEVER decides. It calls ONE authority — the Decision-Centre service's
 *     `openDeterministicProposal` — which only ever inserts a `proposed` row with no
 *     decider (and the DB guard forbids a decision being born terminal anyway).
 *     approve / reject / delay / delegate remain a super-admin's act, at the console.
 *   • It NEVER executes anything. Opening a proposal is the whole action.
 *   • It NEVER raises a duplicate. Each proposal carries the signal's stable key; the
 *     partial-unique index (this milestone's migration) makes a repeat for the same
 *     signal a clean no-op, so the service can run daily (and overlap itself) without
 *     ever double-proposing.
 *
 * This module owns NO direct table access — hq_decisions is touched by exactly one
 * module (the Decision-Centre service), the invariant its security suite pins. Runs
 * from the daily cron /api/cron/hq-decision-autopropose.
 */

export type AutoProposalResult = {
  /** Draft proposals produced from the snapshot (post-mapping). */
  evaluated: number;
  /** Proposals newly opened this run. */
  created: number;
  /** Signals that already had a proposal (idempotent skip). */
  skipped_existing: number;
  /** Failures (logged; the run continues). */
  errors: number;
  durationMs: number;
};

/**
 * Build the live alert snapshot, map its CRITICAL signals to draft proposals, and
 * open each one that does not already exist. `now` is injected for deterministic
 * tests; production passes the wall clock.
 */
export async function runDecisionAutoProposal(
  now: Date = new Date(),
): Promise<AutoProposalResult> {
  const startedAt = Date.now();
  const { snapshot } = await buildAlertsSnapshot();
  // Pin the snapshot's clock so the rules — and therefore the proposals — are
  // deterministic for a given `now`.
  const alerts = runAlertRules({ ...snapshot, now: now.toISOString() });
  const proposals = mapSignalsToProposals(alerts);

  let created = 0;
  let skippedExisting = 0;
  let errors = 0;

  for (const proposal of proposals) {
    try {
      const outcome = await openDeterministicProposal({
        title: proposal.title,
        problem: proposal.problem,
        revenueImpact: proposal.revenueImpact,
        risk: proposal.risk,
        demand: proposal.demand,
        recommendation: proposal.recommendation,
        sourceSignalKey: proposal.sourceSignalKey,
      });
      if (outcome === "created") created++;
      else if (outcome === "exists") skippedExisting++;
      else errors++;
    } catch (e) {
      console.error(
        "[hq-decision-autoproposal] proposal failed",
        proposal.sourceSignalKey,
        e instanceof Error ? e.message : String(e),
      );
      errors++;
    }
  }

  return {
    evaluated: proposals.length,
    created,
    skipped_existing: skippedExisting,
    errors,
    durationMs: Date.now() - startedAt,
  };
}
