import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "My jobs" on My Day — regression pins for the Customer #1 rehearsal defect
 * (2026-08-29): the panel filtered rows on `assigned_to === user.id` but the
 * PostgREST select list did not include `assigned_to`, so every row came back
 * with `assigned_to: undefined` and the panel was PERMANENTLY EMPTY for every
 * worker with a legitimate assignment.
 *
 * Two layers:
 *  1. Source contract — the select list and the filter must agree: if the page
 *     filters on assigned_to, the jobs select MUST fetch assigned_to. This is
 *     the exact mismatch that shipped, and it is invisible to typecheck (the
 *     filter cast made the missing column an `undefined` at runtime, not a
 *     compile error).
 *  2. Pure filter semantics — given rows shaped like the (fixed) query result,
 *     the filter keeps exactly the caller's jobs: theirs in, other workers'
 *     out, unassigned out, and (per the query's status exclusion) the DB never
 *     hands it completed/cancelled rows in the first place.
 */

const PAGE = join(process.cwd(), "app/(app)/me/page.tsx");

describe("My Day → My jobs: select/filter contract", () => {
  const src = readFileSync(PAGE, "utf8");

  it("the jobs select fetches assigned_to (the filter's key column)", () => {
    // Find the jobs read: the select string that also carries the customers
    // embed used only by this panel.
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

  it("the panel still filters to the caller's own assignments", () => {
    expect(src).toMatch(/assigned_to\s*===\s*user\.id/);
  });

  it("the query still excludes completed and cancelled jobs at the DB", () => {
    expect(src).toMatch(/\.not\("status",\s*"in",\s*"\(completed,cancelled\)"\)/);
  });
});

describe("My Day → My jobs: filter semantics (pure)", () => {
  type Row = { id: string; assigned_to?: string | null };
  const ME = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const filterMine = (rows: Row[]) => rows.filter((j) => j.assigned_to === ME);

  it("keeps the caller's single assignment", () => {
    expect(filterMine([{ id: "a", assigned_to: ME }])).toHaveLength(1);
  });

  it("keeps multiple assignments, in order", () => {
    const out = filterMine([
      { id: "a", assigned_to: ME },
      { id: "b", assigned_to: OTHER },
      { id: "c", assigned_to: ME },
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("empty for a worker with no assignments (clean empty state)", () => {
    expect(filterMine([{ id: "a", assigned_to: OTHER }, { id: "b", assigned_to: null }])).toEqual(
      [],
    );
  });

  it("another worker's job never appears", () => {
    expect(filterMine([{ id: "x", assigned_to: OTHER }])).toEqual([]);
  });

  it("REGRESSION: rows missing assigned_to (the shipped bug) yield empty — the source contract above is what prevents this shape", () => {
    expect(filterMine([{ id: "a" }])).toEqual([]);
  });
});
