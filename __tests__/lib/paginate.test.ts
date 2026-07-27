import { describe, it, expect, vi } from "vitest";
import { fetchAllRows, PAGE_SIZE } from "@/lib/supabase/paginate";

/**
 * Unit tests for fetchAllRows — the volume-safe paginated read that fixes
 * F-1 (dashboard KPI undercount once an org crosses the PostgREST max-rows
 * cap). The whole point is that aggregation sees EVERY row, never a silently
 * truncated first page, so these tests pin the paging boundaries exactly.
 */

/**
 * Build a fake page-fetcher over an in-memory array that honours the
 * inclusive `[from, to]` range PostgREST uses, and records the ranges it was
 * asked for so we can assert the paging walk.
 */
function makeSource<T>(rows: T[], pageSize: number) {
  const calls: Array<[number, number]> = [];
  const buildPage = (from: number, to: number) => {
    calls.push([from, to]);
    // PostgREST range is inclusive on both ends.
    const slice = rows.slice(from, to + 1);
    return Promise.resolve({ data: slice, error: null });
  };
  return { buildPage, calls, pageSize };
}

describe("fetchAllRows", () => {
  it("returns a single short page without asking for a second", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: i }));
    const { buildPage, calls } = makeSource(rows, 500);

    const { data, error } = await fetchAllRows(buildPage, 500);

    expect(error).toBeNull();
    expect(data).toHaveLength(7);
    expect(data.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // One page only — a short page ends the walk.
    expect(calls).toEqual([[0, 499]]);
  });

  it("accumulates across multiple full pages in order", async () => {
    const rows = Array.from({ length: 1250 }, (_, i) => ({ id: i }));
    const { buildPage, calls } = makeSource(rows, 500);

    const { data } = await fetchAllRows(buildPage, 500);

    expect(data).toHaveLength(1250);
    // Order preserved end to end.
    expect(data[0]!.id).toBe(0);
    expect(data[1249]!.id).toBe(1249);
    // 500 + 500 + 250(short) → three pages, last one ends it.
    expect(calls).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });

  it("fetches one extra (empty) page when the total is an exact multiple of pageSize", async () => {
    // The danger case: 1000 rows with a 1000 cap looks identical to "there
    // might be more". A full final page MUST trigger one more read so we
    // never stop one page short of a silent truncation.
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const { buildPage, calls } = makeSource(rows, 500);

    const { data } = await fetchAllRows(buildPage, 500);

    expect(data).toHaveLength(1000);
    expect(calls).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499], // empty page → terminates
    ]);
  });

  it("returns the partial set plus the error when a page fails mid-walk", async () => {
    const err = { message: "statement timeout" };
    let n = 0;
    const buildPage = (from: number, to: number) => {
      n++;
      if (n === 2) return Promise.resolve({ data: null, error: err });
      const rows = Array.from({ length: 500 }, (_, i) => ({ id: from + i }));
      return Promise.resolve({ data: rows.slice(0, to - from + 1), error: null });
    };

    const { data, error } = await fetchAllRows(buildPage, 500);

    expect(error).toBe(err);
    // First page survived; we hand back what we read rather than crashing.
    expect(data).toHaveLength(500);
    expect(data[0]!.id).toBe(0);
  });

  it("treats a null data page as empty and stops", async () => {
    const buildPage = vi.fn(async () => ({ data: null, error: null }));
    const { data, error } = await fetchAllRows(buildPage, 500);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(buildPage).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive / non-integer pageSize", async () => {
    const noop = async () => ({ data: [], error: null });
    await expect(fetchAllRows(noop, 0)).rejects.toThrow(/positive integer/);
    await expect(fetchAllRows(noop, -10)).rejects.toThrow(/positive integer/);
    await expect(fetchAllRows(noop, 1.5)).rejects.toThrow(/positive integer/);
  });

  it("defaults to a PAGE_SIZE that stays below the 1000-row PostgREST cap", () => {
    expect(PAGE_SIZE).toBeLessThan(1000);
    expect(PAGE_SIZE).toBeGreaterThan(0);
  });
});
