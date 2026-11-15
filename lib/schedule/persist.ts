/**
 * Rota persistence planner — PURE (no I/O, no model, no Next imports).
 *
 * The solver (lib/schedule/solver.ts) PROPOSES a whole rota; this module decides
 * what actually becomes `rota_entries` rows when an owner approves it. It answers
 * three questions for every proposed assignment, deterministically, from rows the
 * caller already read:
 *
 *   1. IDEMPOTENT — is an identical shift already saved? Re-approving the same
 *      proposal must not double-insert. An EXACT match (same person, same job,
 *      same start, same end) is reported as `alreadySaved` and never re-inserted.
 *
 *   2. NEVER OVERWRITE — does the proposal clash with a shift that is already on
 *      the rota (e.g. one a manager confirmed by hand between generating and
 *      approving)? Such an assignment is reported as a `conflict` with a plain
 *      reason and is LEFT OUT — this module only ever adds rows, it issues no
 *      UPDATE or DELETE, so a confirmed shift can never be silently overwritten.
 *
 *   3. SAFE TO ADD — everything else goes to `toInsert`, the set the action
 *      writes in one all-or-nothing statement.
 *
 * Why the dedup/overlap check lives here AND the solver already avoids overlaps:
 * the solver reasons over the rota as it was when the plan was generated. Between
 * that read and the approval a manager can add a shift by hand, so the approval
 * MUST re-check against the live rota (a classic time-of-check/time-of-use gap).
 * Re-checking here closes it without trusting anything the client submitted.
 *
 * Edge semantics match the conflict detector: a shift that ENDS exactly when
 * another BEGINS is a handover, not a clash (strict `<` overlap). Timestamps are
 * compared as instants (epoch ms) so `…Z` and `…+00:00` forms from Postgres
 * compare equal.
 */

export type PersistableAssignment = {
  userId: string;
  jobId: string | null;
  /** ISO-8601 instant. */
  startIso: string;
  /** ISO-8601 instant. */
  endIso: string;
  notes?: string | null;
};

/** The columns of an existing `rota_entries` row the planner needs. */
export type ExistingRotaEntry = {
  user_id: string;
  job_id: string | null;
  starts_at: string;
  ends_at: string;
};

export type RotaPersistConflict = {
  assignment: PersistableAssignment;
  /** A plain sentence a manager can read — why this one was left out. */
  reason: string;
};

export type RotaPersistencePlan = {
  /** New rows to write, in the order given. One atomic insert. */
  toInsert: PersistableAssignment[];
  /** Identical shifts that already exist — skipped so re-approve is a no-op. */
  alreadySaved: PersistableAssignment[];
  /** Proposals that clash with an existing/earlier-accepted shift — left out. */
  conflicts: RotaPersistConflict[];
};

function ms(iso: string): number {
  return Date.parse(iso);
}

/** Strict interval overlap — touching edges (handover) do NOT overlap. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function normJob(jobId: string | null | undefined): string {
  return jobId ?? "";
}

/**
 * Decide, purely, which proposed assignments to insert, which already exist, and
 * which clash with the live rota. See the module header for the three rules.
 */
export function planRotaPersistence(
  assignments: readonly PersistableAssignment[],
  existing: readonly ExistingRotaEntry[],
): RotaPersistencePlan {
  const toInsert: PersistableAssignment[] = [];
  const alreadySaved: PersistableAssignment[] = [];
  const conflicts: RotaPersistConflict[] = [];

  // Existing rota, normalised once to instants + grouped by person.
  type Window = { start: number; end: number; job: string };
  const existingByUser = new Map<string, Window[]>();
  for (const e of existing) {
    const w: Window = { start: ms(e.starts_at), end: ms(e.ends_at), job: normJob(e.job_id) };
    const arr = existingByUser.get(e.user_id) ?? [];
    arr.push(w);
    existingByUser.set(e.user_id, arr);
  }

  // Rows accepted so far THIS run — so a batch that somehow proposes two
  // overlapping shifts for one person can never insert both.
  const acceptedByUser = new Map<string, Window[]>();

  for (const a of assignments) {
    const start = ms(a.startIso);
    const end = ms(a.endIso);

    // A malformed or zero/negative-length interval would be rejected by the
    // `rota_entries_check` constraint and abort the whole atomic insert, taking
    // every good row down with it. Reject it here with a reason instead.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      conflicts.push({ assignment: a, reason: "Invalid shift time — left out so the rest can save." });
      continue;
    }

    const job = normJob(a.jobId);
    const priorExisting = existingByUser.get(a.userId) ?? [];
    const priorAccepted = acceptedByUser.get(a.userId) ?? [];

    // Rule 1 — IDEMPOTENT: an identical shift already saved (or already queued
    // this run) is skipped, never duplicated.
    const exact = (w: Window) => w.start === start && w.end === end && w.job === job;
    if (priorExisting.some(exact) || priorAccepted.some(exact)) {
      alreadySaved.push(a);
      continue;
    }

    // Rule 2 — NEVER OVERWRITE: a clash with a shift already on the rota.
    if (priorExisting.some((w) => overlaps(start, end, w.start, w.end))) {
      conflicts.push({
        assignment: a,
        reason: "Clashes with a shift already on the rota — left untouched.",
      });
      continue;
    }
    // …or with one this very batch already accepted.
    if (priorAccepted.some((w) => overlaps(start, end, w.start, w.end))) {
      conflicts.push({
        assignment: a,
        reason: "Clashes with another assignment in this plan — left out.",
      });
      continue;
    }

    // Rule 3 — SAFE TO ADD.
    toInsert.push(a);
    priorAccepted.push({ start, end, job });
    acceptedByUser.set(a.userId, priorAccepted);
  }

  return { toInsert, alreadySaved, conflicts };
}
