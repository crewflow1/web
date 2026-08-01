import { ratio, type Ratio } from "@/lib/suppliers/performance";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * SNAG PATTERNS — defect counts and sign-off rates per job and per trade.
 * PURE.
 *
 * KIND: DERIVED. Everything here is a count of `snags` rows by their stored
 * status (open → in_progress → fixed → verified, wont_fix dismisses —
 * lib/snags/schema.ts mirrors the DB CHECK), plus one Ratio composed from the
 * house `ratio()` authority (lib/suppliers/performance), whose
 * MIN_RATED_SAMPLE floor stops a trade with two snags being branded "50 %
 * unverified".
 *
 * ── VERIFICATION RATE, PRECISELY ────────────────────────────────────────────
 * `verification = verified / (fixed + verified)` — of the snags whose FIX has
 * been claimed, how many have been signed off. A currently-'fixed' snag is
 * AWAITING verification, not failed verification; the ratio says how much
 * claimed-fixed work has been checked, which is the honest question a
 * snapshot can answer. 'wont_fix' is outside the denominator (nothing was
 * fixed to verify) and 'open'/'in_progress' have not claimed a fix yet.
 *
 * ── WHAT IS DELIBERATELY MISSING (two refusals, both structural) ────────────
 *
 * 1. SUPPLIER ATTRIBUTION IS UNREPRESENTABLE. `snags.trade` is FREE TEXT and
 *    there is no supplier FK, no purchase_order_id and no work-package entity
 *    to hang one on; `assigned_to` is an INTERNAL member (the fixer, usually
 *    our own labour). Matching free-text trade against free-text supplier
 *    category would attribute every "Electrical" snag to every electrical
 *    merchant at once — "defamation with a denominator", exactly as
 *    lib/suppliers/performance.ts's header ruled when it refused the same
 *    join. Per-TRADE counts are as far as the data goes, and a trade here
 *    means "the kind of work", never "a company".
 *
 * 2. REOPEN RATE IS UNREPRESENTABLE (tenant-side, today). A reopen is a
 *    TRANSITION (fixed/verified → open/in_progress), and no tenant-readable
 *    table records snag transitions: `snags` stores only the current status,
 *    `resolved_at` is CLEARED on reopen (20260919 — the trace erases itself),
 *    and the only place the transition lands is `admin_activity_log` — an
 *    HQ-side, service-role audit table that is not a tenant analytics source
 *    and must not become one by the back door. When a tenant-scoped snag
 *    history exists, the reopen rate belongs here; until then, publishing one
 *    would be publishing a guess.
 */

export type SnagRow = {
  id: string;
  job_id: string | null;
  trade: string | null;
  status: string;
  priority: string;
  due_date: string | null;
};

export type SnagGroupStats = {
  /** Job id, or the normalised trade key. */
  key: string;
  label: string;
  href: string | null;
  total: number;
  /** open + in_progress — still being worked. */
  open: number;
  /** Fix claimed, sign-off not yet done. */
  fixedAwaitingVerify: number;
  verified: number;
  wontFix: number;
  /** Non-terminal snags past their due date. */
  overdue: number;
  /** Open/in-progress snags at high priority. */
  highPriorityOpen: number;
  /** verified / (fixed + verified), floored by MIN_RATED_SAMPLE. */
  verification: Ratio;
};

export type SnagPatterns = {
  total: number;
  open: number;
  overdue: number;
  verification: Ratio;
  byJob: SnagGroupStats[];
  byTrade: SnagGroupStats[];
};

export const NO_TRADE_LABEL = "No trade recorded";
export const NO_JOB_LABEL = "Not linked to a job";

const OPEN_STATUSES = new Set(["open", "in_progress"]);
const TERMINAL = new Set(["verified", "wont_fix"]);

function isOverdue(s: SnagRow, todayIso: string): boolean {
  if (!s.due_date) return false;
  if (TERMINAL.has(s.status)) return false;
  // Same boundary as isInvoiceOverdue: not late on the day it falls due.
  return s.due_date < todayIso;
}

type Acc = {
  label: string;
  href: string | null;
  total: number;
  open: number;
  fixed: number;
  verified: number;
  wontFix: number;
  overdue: number;
  highPriorityOpen: number;
};

function emptyAcc(label: string, href: string | null): Acc {
  return {
    label,
    href,
    total: 0,
    open: 0,
    fixed: 0,
    verified: 0,
    wontFix: 0,
    overdue: 0,
    highPriorityOpen: 0,
  };
}

function fold(acc: Acc, s: SnagRow, todayIso: string): void {
  acc.total += 1;
  if (OPEN_STATUSES.has(s.status)) {
    acc.open += 1;
    if (s.priority === "high") acc.highPriorityOpen += 1;
  }
  if (s.status === "fixed") acc.fixed += 1;
  if (s.status === "verified") acc.verified += 1;
  if (s.status === "wont_fix") acc.wontFix += 1;
  if (isOverdue(s, todayIso)) acc.overdue += 1;
}

function toStats(key: string, acc: Acc): SnagGroupStats {
  return {
    key,
    label: acc.label,
    href: acc.href,
    total: acc.total,
    open: acc.open,
    fixedAwaitingVerify: acc.fixed,
    verified: acc.verified,
    wontFix: acc.wontFix,
    overdue: acc.overdue,
    highPriorityOpen: acc.highPriorityOpen,
    verification: ratio(acc.verified, acc.fixed + acc.verified),
  };
}

export function computeSnagPatterns(input: {
  snags: SnagRow[];
  /** job id → display label (site line). Jobs without labels degrade to id-less. */
  jobLabel: Map<string, string>;
  todayIso: string;
}): SnagPatterns {
  const byJob = new Map<string, Acc>();
  const byTrade = new Map<string, Acc>();
  const org = emptyAcc("", null);

  for (const s of input.snags) {
    fold(org, s, input.todayIso);

    const jobKey = s.job_id ?? "";
    const jobAcc =
      byJob.get(jobKey) ??
      emptyAcc(
        s.job_id ? input.jobLabel.get(s.job_id) ?? "Job" : NO_JOB_LABEL,
        s.job_id ? `/jobs/${s.job_id}` : "/snags",
      );
    fold(jobAcc, s, input.todayIso);
    byJob.set(jobKey, jobAcc);

    // Trade key: trimmed + lower-cased so "Plumbing" and "plumbing " merge;
    // the display label keeps the first-seen original casing.
    const rawTrade = s.trade?.trim() ?? "";
    const tradeKey = rawTrade === "" ? "" : rawTrade.toLowerCase();
    const tradeAcc =
      byTrade.get(tradeKey) ?? emptyAcc(rawTrade === "" ? NO_TRADE_LABEL : rawTrade, "/snags");
    fold(tradeAcc, s, input.todayIso);
    byTrade.set(tradeKey, tradeAcc);
  }

  const sortStats = (rows: SnagGroupStats[]) =>
    rows.sort(
      (a, b) =>
        b.open - a.open ||
        b.overdue - a.overdue ||
        b.total - a.total ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key),
    );

  return {
    total: org.total,
    open: org.open,
    overdue: org.overdue,
    verification: ratio(org.verified, org.fixed + org.verified),
    byJob: sortStats([...byJob.entries()].map(([k, a]) => toStats(k, a))),
    byTrade: sortStats([...byTrade.entries()].map(([k, a]) => toStats(k, a))),
  };
}

/** DERIVED — status counts and one floored ratio; the refusals are stated. */
export function snagPatternsMetric(p: SnagPatterns): LabelledMetric<SnagPatterns> {
  return labelled(p, {
    kind: "derived",
    basis:
      "Counts of snags by their current status, per job and per trade, plus a verification " +
      "rate: of snags whose fix has been claimed, how many have been signed off. Rates are " +
      "withheld below 5 comparable snags. Trades are free text and describe the kind of work " +
      "— no supplier is ever blamed (there is no supplier link on a snag). Reopen rates are " +
      "not shown because no tenant-visible record of snag reopenings exists.",
    computedFrom: [{ label: "Snags", href: "/snags" }],
    sampleFloorApplied: !p.verification.rated,
  });
}
