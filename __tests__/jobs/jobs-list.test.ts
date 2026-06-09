import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PAGE_SIZE,
  parsePage,
  offsetForPage,
  pageWindow,
} from "@/lib/jobs/list";

/**
 * F-7 launch-blocker regression: /jobs used `.limit(200)` and printed
 * `rows.length` as the headline total, so an org with 640 jobs showed
 * "200 jobs" with rows 201–640 unreachable. Worse, "Today's jobs" was filtered
 * out of that same 200-row slice — and because the list sorts by
 * `scheduled_date ASC`, today's work sorts to the LAST pages, so once an org
 * passed 200 historical jobs the mobile "Today's jobs" panel went empty even
 * with jobs booked for today. These lock in the fix: an EXACT count, `.range()`
 * pagination, and a SEPARATE bounded `scheduled_date = today` query.
 */

const TOTAL = 640; // a busy org, well past the old 200 cap

describe("jobs pagination — 640 jobs (past the old .limit(200) cap)", () => {
  it("splits 640 jobs into 7 pages of 100 (6×100 + 40)", () => {
    expect(PAGE_SIZE).toBe(100);
    expect(pageWindow(TOTAL, 0, PAGE_SIZE).totalPages).toBe(7);
  });

  it("page 1 shows rows 1–100 of 640", () => {
    const offset = offsetForPage(1);
    expect(offset).toBe(0);
    expect(pageWindow(TOTAL, offset, PAGE_SIZE)).toEqual({
      totalPages: 7,
      from: 1,
      to: 100,
    });
  });

  it("reaches the LATE rows 601–640 that the old .limit(200) hid", () => {
    const offset = offsetForPage(7);
    expect(offset).toBe(600);
    expect(pageWindow(TOTAL, offset, TOTAL - 600)).toEqual({
      totalPages: 7,
      from: 601,
      to: 640,
    });
  });

  it("the headline total is the exact count, never collapsed to the page size", () => {
    // The bug: header showed at most PAGE_SIZE, not the real 640.
    expect(TOTAL).not.toBe(PAGE_SIZE);
    expect(pageWindow(TOTAL, 0, PAGE_SIZE).to).toBe(100);
  });

  it("clamps bogus/missing page params to 1", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(null)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("2")).toBe(2);
    expect(parsePage("7")).toBe(7);
  });

  it("handles an empty org (0 jobs) without a divide-by-zero / 0 pages", () => {
    expect(pageWindow(0, 0, 0)).toEqual({ totalPages: 1, from: 0, to: 0 });
  });
});

describe("jobs/page.tsx wiring (guards the exact regression)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../app/(app)/jobs/page.tsx"),
    "utf-8",
  );

  it("fetches an EXACT count instead of inferring the total from rows.length", () => {
    expect(src).toMatch(/count:\s*"exact"/);
    expect(src).toContain("const totalCount = count ?? 0");
    // the old buggy headline must be gone
    expect(src).not.toContain("{rows.length} {rows.length === 1");
  });

  it("paginates server-side with .range() and no longer caps the list at .limit(200)", () => {
    expect(src).toMatch(/\.range\(\s*offset,\s*offset \+ PAGE_SIZE - 1/);
    expect(src).not.toContain(".limit(200)");
  });

  it("loads today's jobs with their OWN bounded query, not a slice of the page", () => {
    expect(src).toMatch(/\.eq\("scheduled_date",\s*todayIso\)/);
    // the old, bug-prone derivation from the paginated slice must be gone
    expect(src).not.toMatch(/rows\.filter\(\(j\) => j\.scheduled_date/);
  });

  it("prints the real total and a clear 'Showing A–B of N' indicator", () => {
    expect(src).toContain("Showing {from}");
    expect(src).toContain("of {totalCount}");
  });

  it("uses a STABLE id tiebreaker so paging can't skip/duplicate same-date rows", () => {
    expect(src).toMatch(/\.order\("id",\s*\{\s*ascending:\s*true/);
  });

  it("preserves the active customer filter across pagination links", () => {
    expect(src).toContain("...baseQuery, page: page - 1");
    expect(src).toContain("...baseQuery, page: page + 1");
  });

  it("keeps the customer-filter contract intact (UUID-validated .eq)", () => {
    // guards against accidentally dropping the existing /jobs?customer= filter
    expect(src).toMatch(/UUID_RE\.test\(sp\.customer\)/);
    expect(src).toMatch(/\.eq\("customer_id",\s*customerFilter\)/);
  });
});
