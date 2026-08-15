/**
 * Site inductions — pure domain logic. Deterministic, no DB/IO, so the trust
 * boundary (what a valid induction is, when it still gates a worker on) is
 * unit-testable in isolation and shared by the action, the read layer and the
 * muster roll. Mirrors lib/health-safety/acknowledgements.ts.
 */

/** Bump this if the attestation wording changes so re-induction can be required. */
export const INDUCTION_STATEMENT_VERSION = "v1";

/**
 * The exact wording a worker attests to when inducted onto a site. Named by the
 * site so the evidence record is legible on its own.
 */
export function inductionStatement(siteName: string): string {
  const where = siteName.trim().length > 0 ? siteName.trim() : "this site";
  return (
    `I confirm I have received and understood the site induction for ${where}, ` +
    `including the site rules, emergency and fire arrangements, welfare and ` +
    `first-aid provision, and the hazards and controls briefed to me, and I will ` +
    `comply with them while on this site.`
  );
}

/** The minimum shape the gate + muster reason over. */
export type InductionRecord = {
  id: string;
  site_id: string;
  user_id: string | null;
  person_name: string | null;
  person_company: string | null;
  induction_version: string;
  inducted_at: string;
  valid_until: string | null;
  signed_name: string;
};

/**
 * Is this single induction still in force at `now`? A NULL valid_until means "no
 * expiry" (permanent until re-issued). Anything with a valid_until at or before
 * `now` has lapsed and no longer gates a worker onto the site.
 */
export function isInductionCurrent(rec: Pick<InductionRecord, "valid_until">, now: Date): boolean {
  if (rec.valid_until == null) return true;
  const until = new Date(rec.valid_until).getTime();
  if (Number.isNaN(until)) return true; // unparseable → treat as no expiry, never lock a worker out on a bad string
  return until > now.getTime();
}

/**
 * Is a specific INTERNAL worker currently inducted for a site? True iff at least
 * one of their inductions for that site is still current at `now`. (Callers pass
 * the inductions already scoped to the site; user match is checked here.)
 */
export function isWorkerInducted(
  inductions: InductionRecord[],
  args: { siteId: string; userId: string; now: Date },
): boolean {
  return inductions.some(
    (r) =>
      r.site_id === args.siteId &&
      r.user_id === args.userId &&
      isInductionCurrent(r, args.now),
  );
}

/**
 * Reduce a worker's (possibly many) inductions for a site to the ONE that
 * counts: the most recent by inducted_at. Used by the register so a worker
 * re-inducted onto a new version shows their latest state, not a stale row.
 */
export function latestInductionByWorker(
  inductions: InductionRecord[],
): Map<string, InductionRecord> {
  const byUser = new Map<string, InductionRecord>();
  for (const r of inductions) {
    if (r.user_id == null) continue;
    const prev = byUser.get(r.user_id);
    if (!prev || new Date(r.inducted_at).getTime() > new Date(prev.inducted_at).getTime()) {
      byUser.set(r.user_id, r);
    }
  }
  return byUser;
}
