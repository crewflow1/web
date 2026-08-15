/**
 * Fire muster roll — pure, deterministic computation of "who is on a site right
 * now". No DB/IO here so the correctness of the roster (the single most
 * safety-critical fact in this feature) is unit-testable in isolation.
 *
 * WHAT "ON SITE" MEANS, and why it is built from time_entries + inductions
 * (exactly the two sources the brief names):
 *
 *   WORKERS. time_entries carries no site_id (only job_id) — a clock-in records
 *   that a worker is WORKING, not where. The site attribution comes from their
 *   INDUCTION: a worker who (a) is currently inducted for site X and (b) has an
 *   OPEN time entry (ended_at is null → on the clock) is counted present at X.
 *   This is deliberately CONSERVATIVE for a fire muster — a worker inducted for
 *   more than one site and on the clock is listed at each, because over-listing
 *   a name at an evacuation point is safe and under-listing is not. The
 *   limitation is documented rather than hidden.
 *
 *   VISITORS. site_visitors with signed_out_at IS NULL for site X — the people
 *   on site who are not our workforce.
 *
 * The roster is the union; the fire export lists everyone present.
 */

import type { InductionRecord } from "./inductions";
import { isInductionCurrent } from "./inductions";

/** A currently-open time entry (ended_at is null) for a worker. */
export type OpenTimeEntry = {
  user_id: string;
  started_at: string;
};

/** A signed-in-not-out visitor for the site. */
export type VisitorPresence = {
  id: string;
  visitor_name: string;
  company: string | null;
  purpose: string | null;
  host_name: string | null;
  signed_in_at: string;
};

/** Optional display info for an internal worker, resolved by the caller. */
export type WorkerDisplay = { name: string; company: string | null };

export type MusterWorker = {
  inductionId: string;
  userId: string;
  name: string;
  company: string | null;
  clockedInAt: string;
  inductionVersion: string;
};

export type MusterVisitor = {
  id: string;
  name: string;
  company: string | null;
  purpose: string | null;
  hostName: string | null;
  signedInAt: string;
};

export type MusterRoll = {
  siteId: string;
  generatedAt: string;
  workers: MusterWorker[];
  visitors: MusterVisitor[];
  /** Total heads on site = workers + visitors. */
  presentCount: number;
};

export type MusterInput = {
  siteId: string;
  /** All inductions for THIS site (any worker, any version). */
  inductions: InductionRecord[];
  /** Currently-open time entries (org-wide — a worker on the clock). */
  openEntries: OpenTimeEntry[];
  /** Signed-in-not-out visitors for THIS site. */
  visitors: VisitorPresence[];
  /** Optional per-user display overrides (full name / firm). */
  workerDisplay?: Record<string, WorkerDisplay>;
  now: Date;
};

/**
 * Compute the live muster roll. Deterministic: same inputs → same output, with
 * a STABLE ordering (arrival time ascending, then a unique id tiebreak) so the
 * PDF/CSV and the on-screen list never disagree and never reorder between reads.
 */
export function computeMuster(input: MusterInput): MusterRoll {
  const openByUser = new Map<string, OpenTimeEntry>();
  for (const e of input.openEntries) {
    // A worker has at most one open entry (DB unique), but be defensive: keep the
    // earliest start so "on since" is the true clock-in.
    const prev = openByUser.get(e.user_id);
    if (!prev || new Date(e.started_at).getTime() < new Date(prev.started_at).getTime()) {
      openByUser.set(e.user_id, e);
    }
  }

  // A worker present at this site = current induction here AND on the clock.
  // Dedupe by user_id, keeping the most recent current induction (its version is
  // what the roll reports).
  const workerByUser = new Map<string, MusterWorker>();
  for (const rec of input.inductions) {
    if (rec.site_id !== input.siteId) continue;
    if (rec.user_id == null) continue;
    if (!isInductionCurrent(rec, input.now)) continue;
    const open = openByUser.get(rec.user_id);
    if (!open) continue;

    const display = input.workerDisplay?.[rec.user_id];
    const candidate: MusterWorker = {
      inductionId: rec.id,
      userId: rec.user_id,
      name: display?.name ?? rec.signed_name,
      company: display?.company ?? null,
      clockedInAt: open.started_at,
      inductionVersion: rec.induction_version,
    };
    const existing = workerByUser.get(rec.user_id);
    if (
      !existing ||
      new Date(rec.inducted_at).getTime() >
        // compare against the induction that produced `existing`
        inductedAtOf(input.inductions, existing.inductionId)
    ) {
      workerByUser.set(rec.user_id, candidate);
    }
  }

  const workers = [...workerByUser.values()].sort(byTimeThenId(
    (w) => w.clockedInAt,
    (w) => w.userId,
  ));

  const visitors: MusterVisitor[] = input.visitors
    .map((v) => ({
      id: v.id,
      name: v.visitor_name,
      company: v.company,
      purpose: v.purpose,
      hostName: v.host_name,
      signedInAt: v.signed_in_at,
    }))
    .sort(byTimeThenId(
      (v) => v.signedInAt,
      (v) => v.id,
    ));

  return {
    siteId: input.siteId,
    generatedAt: input.now.toISOString(),
    workers,
    visitors,
    presentCount: workers.length + visitors.length,
  };
}

function inductedAtOf(inductions: InductionRecord[], inductionId: string): number {
  const r = inductions.find((x) => x.id === inductionId);
  return r ? new Date(r.inducted_at).getTime() : 0;
}

/** Stable "arrival time ascending, then unique id" comparator factory. */
function byTimeThenId<T>(time: (t: T) => string, id: (t: T) => string) {
  return (a: T, b: T): number => {
    const ta = new Date(time(a)).getTime();
    const tb = new Date(time(b)).getTime();
    if (ta !== tb) return ta - tb;
    return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
  };
}
