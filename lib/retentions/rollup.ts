import { round2 } from "@/lib/money";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeRetentionSchedule } from "@/lib/retentions/schedule";

/**
 * Org-wide "contract retention due back" rollup (Programme C extension) — PURE.
 *
 * Answers the dashboard question a builder forgets to ask: across all my jobs,
 * how much held retention is due for release right now, and how much am I still
 * holding? Composed from the same per-job derivations used on the job page
 * (`computeRetentionPosition` → `computeRetentionSchedule`), so the portfolio
 * number and the per-job number always agree.
 *
 * Staff-internal; never exposed on the customer portal.
 */

export type RollupJob = {
  id: string;
  ratePercent: number | string | null;
  practicalCompletionDate: string | null;
  defectsLiabilityMonths: number | string | null;
  firstReleasePct: number | string | null;
};

export type RollupInvoice = { job_id: string | null; status: string; amount: number | string | null };
export type RollupRelease = { job_id: string | null; amount: number | string | null };

export type RetentionDueRollup = {
  /** Σ held retention across all jobs (£). */
  totalHeld: number;
  /** Σ retention past its release date, still unreleased (£). */
  dueNow: number;
  /** Number of jobs with retention due for release. */
  dueJobCount: number;
  /** Number of jobs holding retention. */
  heldJobCount: number;
};

export function computeRetentionDueRollup(input: {
  jobs: RollupJob[];
  invoices: RollupInvoice[];
  releases: RollupRelease[];
  now?: Date;
}): RetentionDueRollup {
  const now = input.now ?? new Date();

  const invByJob = new Map<string, RollupInvoice[]>();
  for (const inv of input.invoices) {
    if (!inv.job_id) continue;
    (invByJob.get(inv.job_id) ?? invByJob.set(inv.job_id, []).get(inv.job_id)!).push(inv);
  }
  const relByJob = new Map<string, RollupRelease[]>();
  for (const rel of input.releases) {
    if (!rel.job_id) continue;
    (relByJob.get(rel.job_id) ?? relByJob.set(rel.job_id, []).get(rel.job_id)!).push(rel);
  }

  let totalHeld = 0;
  let dueNow = 0;
  let dueJobCount = 0;
  let heldJobCount = 0;

  for (const job of input.jobs) {
    const rate = Number(job.ratePercent ?? 0);
    if (rate <= 0) continue;

    const position = computeRetentionPosition({
      ratePercent: rate,
      invoices: (invByJob.get(job.id) ?? []).map((i) => ({ status: i.status, amount: i.amount })),
      releases: (relByJob.get(job.id) ?? []).map((r) => ({ amount: r.amount })),
    });
    if (position.held > 0) heldJobCount += 1;
    totalHeld = round2(totalHeld + position.held);

    const schedule = computeRetentionSchedule({
      position,
      practicalCompletionDate: job.practicalCompletionDate,
      defectsLiabilityMonths: Number(job.defectsLiabilityMonths ?? 12),
      firstReleasePct: Number(job.firstReleasePct ?? 50),
      now,
    });
    if (schedule.dueNow > 0) {
      dueNow = round2(dueNow + schedule.dueNow);
      dueJobCount += 1;
    }
  }

  return { totalHeld, dueNow, dueJobCount, heldJobCount };
}
