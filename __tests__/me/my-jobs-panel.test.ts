import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "My jobs" on My Day — regression pins.
 *
 * Original defect (Customer #1 rehearsal, 2026-08-29): the panel filtered rows on
 * `assigned_to === user.id` but the PostgREST select list did not include
 * `assigned_to`, so every row came back `assigned_to: undefined` and the panel was
 * PERMANENTLY EMPTY for every worker with a legitimate assignment.
 *
 * D-17 (first-customer journey, 2026-11-05): the panel + the clock-in job picker
 * read ONLY the legacy `jobs.assigned_to` single-assignee column, so a worker
 * assigned through the job page's "Assigned team" crew panel (which writes the
 * service-role-only job_assignments table) saw "No jobs assigned to you" and could
 * only clock in against "general work". The read now scopes to
 * my_assigned_job_ids() — the SAME SECURITY DEFINER the jobs RLS uses, which
 * UNIONs job_assignments with jobs.assigned_to — so BOTH assignment stores drive
 * the worker's day-view.
 *
 * Two layers:
 *  1. Source contract — the jobs read is scoped to my_assigned_job_ids() and the
 *     pure filter re-asserts "mine", so a crew-assigned job appears and a job that
 *     is not mine never does. This is invisible to typecheck.
 *  2. Pure filter semantics — given rows shaped like the query result, the filter
 *     keeps exactly the jobs whose id is in the caller's assigned-id set.
 */

const PAGE = join(process.cwd(), "app/(app)/me/page.tsx");

describe("My Day → My jobs: select/filter contract", () => {
  const src = readFileSync(PAGE, "utf8");

  it("the jobs select fetches assigned_to (kept for the panel's own display)", () => {
    const selects = [...src.matchAll(/\.select\(\s*"([^"]*customer:customers[^"]*)"\s*\)/g)].map(
      (m) => m[1],
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) {
      expect(sel, `jobs select must include assigned_to — got: "${sel}"`).toMatch(
        /\bassigned_to\b/,
      );
    }
  });

  it("D-17: the jobs read is scoped by my_assigned_job_ids() (crew + legacy union), not raw assigned_to", () => {
    // The RPC is the single source of truth for "jobs that are mine".
    expect(src).toMatch(/\.rpc\(\s*["']my_assigned_job_ids["']\s*\)/);
    // The jobs query filters on the resolved id set…
    expect(src).toMatch(/\.in\("id",\s*assignedJobIdFilter\)/);
    // …and must NOT have reverted to the legacy single-assignee filter.
    expect(src).not.toMatch(/\.eq\("assigned_to",\s*user\.id\)/);
  });

  it("the panel still filters to the caller's own assignments (by assigned-id set)", () => {
    expect(src).toMatch(/assignedJobIdSet\.has\(/);
  });

  it("the query still excludes completed and cancelled jobs at the DB", () => {
    expect(src).toMatch(/\.not\("status",\s*"in",\s*"\(completed,cancelled\)"\)/);
  });

  it("never carries an unassigned/null-assignee branch (limit-crowding regression)", () => {
    // my_assigned_job_ids() already filters to auth.uid(), so the read is the
    // worker's OWN jobs only and the 20-row cap can never be crowded by
    // unassigned work — but assert no is.null branch ever creeps back in.
    expect(src).not.toMatch(/assigned_to\.is\.null/);
  });

  it("a failed assigned-ids read fails loud, never masquerading as the empty state", () => {
    expect(src).toMatch(/throw readFailure\("me: my assigned job ids"/);
  });

  it("a failed jobs read fails loud, never masquerading as the empty state", () => {
    expect(src).toMatch(/if \(jobsRes\.error\) throw readFailure\("me: my jobs"/);
  });
});

describe("My Day → My jobs: filter semantics (pure)", () => {
  // The page builds a Set of the caller's assigned job ids (from
  // my_assigned_job_ids(), which unions crew + legacy) and keeps rows whose id is
  // in that set. This mirrors that logic.
  type Row = { id: string };
  const CREW = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // assigned via job_assignments
  const LEGACY = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // assigned via jobs.assigned_to
  const NOT_MINE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const assignedSet = new Set([CREW, LEGACY]);
  const filterMine = (rows: Row[]) => rows.filter((j) => assignedSet.has(j.id));

  it("keeps a job assigned via the crew panel (job_assignments)", () => {
    expect(filterMine([{ id: CREW }]).map((r) => r.id)).toEqual([CREW]);
  });

  it("keeps a job assigned via the legacy single-assignee column", () => {
    expect(filterMine([{ id: LEGACY }]).map((r) => r.id)).toEqual([LEGACY]);
  });

  it("keeps multiple assignments, in order", () => {
    const out = filterMine([{ id: CREW }, { id: NOT_MINE }, { id: LEGACY }]);
    expect(out.map((r) => r.id)).toEqual([CREW, LEGACY]);
  });

  it("a job that is not mine never appears", () => {
    expect(filterMine([{ id: NOT_MINE }])).toEqual([]);
  });

  it("empty for a worker with no assignments (clean empty state)", () => {
    expect(new Set<string>().size).toBe(0);
    const none = (rows: Row[]) => rows.filter((j) => new Set<string>().has(j.id));
    expect(none([{ id: CREW }, { id: NOT_MINE }])).toEqual([]);
  });
});
