import { formatGbp, round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Construction retention position (Programme C) — the owner's answer to
 * "how much is being held back, and how much have we got back?".
 *
 * PURE derivation over data already owned by jobs (the contract rate),
 * invoices (the certified base) and the retention_releases ledger — no stored
 * "held" figure to drift (same derive-don't-duplicate rule as the job
 * commercial position). Mirrors the DB guard exactly so the UI and the
 * database agree on what "over-release" means:
 *
 *   accrued  = rate% × non-draft invoiced NET (ex-VAT) value    [UK convention]
 *   released = Σ retention_releases.amount
 *   held     = max(0, accrued − released)
 *
 * VAT is never retained; retention accrues on the works value (ex-VAT `amount`).
 */

export type RetentionInvoice = {
  /** invoice status — draft invoices are not yet certified, so excluded. */
  status: string;
  /** ex-VAT subtotal (`invoices.amount`) — the retention base. */
  amount: number | string | null;
};

export type RetentionRelease = { amount: number | string | null };

export type RetentionPosition = {
  /** the contract retention rate, clamped to [0,100]. */
  ratePercent: number;
  /** non-draft invoiced NET value the rate applies to. */
  invoicedBase: number;
  /** rate% × invoicedBase — total retention withheld to date. */
  accrued: number;
  /** Σ released back so far. */
  released: number;
  /** accrued − released, never negative — what the customer still holds. */
  held: number;
  /** does this contract carry retention at all? */
  isActive: boolean;
  /** accrued > 0 and everything accrued has been released. */
  isFullyReleased: boolean;
};

/** Invoice statuses that do NOT count toward the retention base.
 *  `void` (20261219): a retracted invoice must not inflate accrued/held
 *  retention nor the release cap. */
const UNCERTIFIED = new Set(["draft", "void"]);

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export function computeRetentionPosition(input: {
  ratePercent: number | string | null;
  invoices: RetentionInvoice[];
  releases: RetentionRelease[];
}): RetentionPosition {
  const ratePercent = clampPct(toPounds(input.ratePercent));
  const invoicedBase = sumMoney(
    input.invoices.filter((i) => !UNCERTIFIED.has(i.status)).map((i) => i.amount),
  );
  const accrued = round2((ratePercent / 100) * invoicedBase);
  const released = sumMoney(input.releases.map((r) => r.amount));
  const held = round2(Math.max(0, accrued - released));
  return {
    ratePercent,
    invoicedBase,
    accrued,
    released,
    held,
    isActive: ratePercent > 0,
    // 0.005 tolerance mirrors the DB guard's rounding boundary.
    isFullyReleased: accrued > 0 && released >= accrued - 0.005,
  };
}

/**
 * The maximum a NEW release can be without breaching accrued retention —
 * the app-layer mirror of the DB `tg_retention_release_guard` over-release
 * check, so the UI can refuse (with a friendly message) before the DB does.
 */
export function maxReleasable(position: RetentionPosition): number {
  return round2(Math.max(0, position.accrued - position.released));
}

export { formatGbp };
