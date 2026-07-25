/**
 * Health & Safety dashboard action-signals — pure domain logic (no DB/IO). The
 * snapshot is gathered by server/services/health-safety-snapshot.ts in a small
 * fixed set of bounded RLS-scoped queries; this turns it into deterministic,
 * ranked "things that need attention" cards. Mirrors lib/retention/signals.ts.
 * No LLM, no notifications engine — just facts.
 */

export type HsSnapshot = {
  ramsDraft: number; // draft RAMS awaiting issue
  ramsReviewOverdue: number; // issued RAMS past their review_date
  permitsExpiringSoon: number; // live permits whose window closes within 24h
  permitsExpiredLive: number; // live permits already past valid_until (need closeout)
  activeJobsNoCurrentRams: number; // in-progress jobs with no issued RAMS
  highResidualRams: number; // issued RAMS carrying a Critical (16–25) residual hazard
};

export type HsSignalTone = "danger" | "warn" | "info";

export type HsSignal = {
  id: string;
  title: string;
  body: string;
  href: string;
  tone: HsSignalTone;
  count: number;
};

const TONE_RANK: Record<HsSignalTone, number> = { danger: 0, warn: 1, info: 2 };

/**
 * Build the ordered signal list (most urgent first). Each signal only appears
 * when its count is non-zero, so an all-clear org sees nothing.
 */
export function buildHealthSafetySignals(s: HsSnapshot): HsSignal[] {
  const out: HsSignal[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  if (s.permitsExpiredLive > 0) {
    out.push({
      id: "permits-expired",
      tone: "danger",
      count: s.permitsExpiredLive,
      title: `${s.permitsExpiredLive} permit${plural(s.permitsExpiredLive, "", "s")} expired but still open`,
      body: "A permit past its validity window is no longer valid. Close it out or reissue.",
      href: "/health-safety/permits?filter=expired",
    });
  }
  if (s.activeJobsNoCurrentRams > 0) {
    out.push({
      id: "jobs-no-rams",
      tone: "danger",
      count: s.activeJobsNoCurrentRams,
      title: `${s.activeJobsNoCurrentRams} active job${plural(s.activeJobsNoCurrentRams, "", "s")} with no current RAMS`,
      body: "Work in progress should have an issued risk assessment. Create or issue one.",
      href: "/health-safety",
    });
  }
  if (s.permitsExpiringSoon > 0) {
    out.push({
      id: "permits-expiring",
      tone: "warn",
      count: s.permitsExpiringSoon,
      title: `${s.permitsExpiringSoon} permit${plural(s.permitsExpiringSoon, "", "s")} expiring within 24h`,
      body: "Reissue or close before the validity window ends.",
      href: "/health-safety/permits?filter=expiring",
    });
  }
  if (s.ramsReviewOverdue > 0) {
    out.push({
      id: "rams-review-overdue",
      tone: "warn",
      count: s.ramsReviewOverdue,
      title: `${s.ramsReviewOverdue} RAMS past ${plural(s.ramsReviewOverdue, "its", "their")} review date`,
      body: "Review the assessment and raise a revision if anything has changed.",
      href: "/health-safety",
    });
  }
  if (s.highResidualRams > 0) {
    out.push({
      id: "rams-high-residual",
      tone: "warn",
      count: s.highResidualRams,
      title: `${s.highResidualRams} issued RAMS with a critical residual risk`,
      body: "A hazard still scores 16–25 after controls. Check the controls are adequate.",
      href: "/health-safety",
    });
  }
  if (s.ramsDraft > 0) {
    out.push({
      id: "rams-draft",
      tone: "info",
      count: s.ramsDraft,
      title: `${s.ramsDraft} draft RAMS awaiting issue`,
      body: "Finish and issue so the site has a current version to work to.",
      href: "/health-safety",
    });
  }

  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.count - a.count);
}
