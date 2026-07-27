import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F-7 regression: the /finances monthly-summary query used `.limit(5000)`,
 * which EXCEEDS the PostgREST max-rows cap (1000). PostgREST silently returns
 * only the first 1000 rows, so a busy org's monthly chart quietly dropped
 * everything past the most recent 1000 finance entries and the per-month
 * net/VAT totals undercounted. The fix bounds the query to the rendered
 * 6-month window and pages through it in chunks BELOW the cap so nothing is
 * truncated. The list query itself was already paginated correctly
 * (count:"exact" + .range, PAGE_SIZE 50) and is left untouched.
 */

const src = readFileSync(
  resolve(__dirname, "../../app/(app)/finances/page.tsx"),
  "utf-8",
);

describe("finances monthly summary — no silent cap truncation", () => {
  it("drops the buggy `.limit(5000)` that exceeded the 1000-row cap", () => {
    expect(src).not.toContain(".limit(5000)");
  });

  it("bounds the summary to the rendered recent window (a created_at floor)", () => {
    expect(src).toContain("summaryFloor");
    expect(src).toMatch(/\.gte\("created_at",\s*summaryFloor\)/);
  });

  it("pages the window with .range() in chunks STRICTLY below the 1000 cap", () => {
    expect(src).toMatch(/\.range\(\s*start,\s*start \+ SUMMARY_PAGE - 1/);
    const m = src.match(/const SUMMARY_PAGE = (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(1000);
  });

  it("uses a STABLE id tiebreaker so paging can't skip/duplicate same-date rows", () => {
    expect(src).toMatch(/\.order\("id",\s*\{\s*ascending:\s*false/);
  });

  it("stops as soon as a short page is returned (no fixed huge fetch)", () => {
    expect(src).toMatch(/batch\.length < SUMMARY_PAGE/);
  });

  it("has a bounded page loop (cannot spin forever)", () => {
    expect(src).toContain("MAX_SUMMARY_PAGES");
  });

  it("leaves the already-correct list pagination in place", () => {
    // the list query keeps its exact count + range window
    expect(src).toMatch(/count:\s*"exact"/);
    expect(src).toMatch(/\.range\(offset,\s*offset \+ PAGE_SIZE - 1\)/);
  });
});
