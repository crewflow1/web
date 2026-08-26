import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchCalendarJobs,
  type CalendarDbJob,
  type CalendarSupabaseClient,
} from "@/lib/schedule/calendar-data";
import { expandRecurring, MAX_OCCURRENCES } from "@/lib/schedule/recurring";

/**
 * F-1 launch-blocker regression: /jobs/calendar loaded ALL org jobs with a
 * blind `.limit(1000)`, unordered and with no date filter, then expanded
 * recurring parents and filtered to the window in memory. Once an org crossed
 * the 1000-row PostgREST cap, jobs scheduled INSIDE the rendered week/month
 * silently vanished from the grid — and which ones was arbitrary (the read
 * was unordered).
 *
 * These pin the fix in fetchCalendarJobs:
 *   - non-recurring jobs are scoped to the [from,to] window and PAGED, so a
 *     job past the first 1000 (by id) inside the window still appears;
 *   - recurring parents are read UNBOUNDED (anchor may predate the window) and
 *     still expand into it;
 *   - org scoping + status/staff filters + the deterministic order hold.
 *
 * Hermetic: a chainable in-memory mock that caps every response at 1000 rows
 * exactly like PostgREST — no real Supabase client (Node-20 CI has no native
 * WebSocket for the realtime client).
 */

const RESPONSE_CAP = 1000;
const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";
const RANGE = { from: "2026-08-01", to: "2026-08-31" };

type Row = Record<string, unknown>;

/** A chainable jobs-table mock honouring the exact chain fetchCalendarJobs builds. */
function makeClient(rows: Row[]): CalendarSupabaseClient {
  function makeBuilder() {
    const eqs: Array<[string, unknown]> = [];
    const neqs: Array<[string, unknown]> = [];
    const isNulls: string[] = [];
    const notNulls: string[] = [];
    const gtes: Array<[string, string]> = [];
    const ltes: Array<[string, string]> = [];
    const orders: Array<[string, boolean]> = [];

    const settle = (from: number, to: number) => {
      let out = rows.filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        for (const col of isNulls) if (row[col] != null) return false;
        for (const col of notNulls) if (row[col] == null) return false;
        for (const [col, val] of gtes) {
          if (row[col] == null) return false;
          if (String(row[col]) < val) return false;
        }
        for (const [col, val] of ltes) {
          if (row[col] == null) return false;
          if (String(row[col]) > val) return false;
        }
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        out = [...out].sort((a, b) => {
          const av = a[col] as string;
          const bv = b[col] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      // PostgREST: inclusive [from,to], then HARD-capped at RESPONSE_CAP.
      const windowed = out.slice(from, to + 1).slice(0, RESPONSE_CAP);
      return Promise.resolve({ data: windowed as CalendarDbJob[], error: null });
    };

    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      // Default cancelled-exclusion (20261220): the grid calls
      // .neq("status","cancelled") when no explicit status filter is set. The
      // fixture rows never carry status "cancelled", so filtering here is a
      // faithful no-op that still exercises the real call chain.
      neq(col: string, val: unknown) {
        neqs.push([col, val]);
        return builder;
      },
      is(col: string, val: unknown) {
        if (val === null) isNulls.push(col);
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        if (val === null) notNulls.push(col);
        return builder;
      },
      gte(col: string, val: string) {
        gtes.push([col, val]);
        return builder;
      },
      lte(col: string, val: string) {
        ltes.push([col, val]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      range: (from: number, to: number) => settle(from, to),
    };
    return builder;
  }
  return { from: () => makeBuilder() } as unknown as CalendarSupabaseClient;
}

function nonRecurring(overrides: Row & { id: string }): Row {
  return {
    org_id: ORG,
    status: "new",
    scheduled_date: "2026-08-15",
    notes: null,
    assigned_to: null,
    customer_id: null,
    recurring: null,
    customer: null,
    assigned: null,
    ...overrides,
  };
}

describe("fetchCalendarJobs — window-scoped + paged past the 1000-row cap (F-1)", () => {
  it("returns EVERY in-window non-recurring job, including ids past the first 1000", async () => {
    const N = 1500; // well past the PostgREST cap the old .limit(1000) hit
    const rows: Row[] = Array.from({ length: N }, (_, i) =>
      nonRecurring({ id: `job-${String(i).padStart(6, "0")}` }),
    );
    const client = makeClient(rows);

    const { rows: got, error } = await fetchCalendarJobs({
      supabase: client,
      orgId: ORG,
      range: RANGE,
    });

    expect(error).toBeNull();
    expect(got).toHaveLength(N);
    // The row the old single-page read would have dropped is present.
    const ids = new Set(got.map((r) => r.id));
    expect(ids.has("job-001499")).toBe(true);
    expect(ids.has("job-001000")).toBe(true);
  });

  it("excludes non-recurring jobs OUTSIDE the window and OTHER orgs", async () => {
    const rows: Row[] = [
      nonRecurring({ id: "in-window", scheduled_date: "2026-08-10" }),
      nonRecurring({ id: "before-window", scheduled_date: "2026-07-31" }),
      nonRecurring({ id: "after-window", scheduled_date: "2026-09-01" }),
      nonRecurring({ id: "other-org", org_id: OTHER_ORG }),
    ];
    const { rows: got } = await fetchCalendarJobs({
      supabase: makeClient(rows),
      orgId: ORG,
      range: RANGE,
    });
    const ids = got.map((r) => r.id).sort();
    expect(ids).toEqual(["in-window"]);
  });

  it("includes recurring parents anchored BEFORE the window, and they still expand into it", async () => {
    const recurringRow: Row = nonRecurring({
      id: "rec-weekly",
      scheduled_date: "2026-07-06", // Monday, weeks before the window
      recurring: { pattern: "weekly" },
    });
    // Bury it behind 1200 in-window one-offs so it only survives if the
    // recurring read is a SEPARATE unbounded query, not a slice of one page.
    const rows: Row[] = [
      ...Array.from({ length: 1200 }, (_, i) =>
        nonRecurring({ id: `job-${String(i).padStart(6, "0")}` }),
      ),
      recurringRow,
    ];

    const { rows: got } = await fetchCalendarJobs({
      supabase: makeClient(rows),
      orgId: ORG,
      range: RANGE,
    });

    const rec = got.find((r) => r.id === "rec-weekly");
    expect(rec, "recurring parent must survive the paged read").toBeDefined();
    // Recurring expansion still works on the fetched anchor + payload.
    const occurrences = expandRecurring(
      rec!.scheduled_date!,
      rec!.recurring as { pattern: "weekly" },
      RANGE.from,
      RANGE.to,
    );
    expect(occurrences.length).toBeGreaterThan(0);
    for (const d of occurrences) {
      expect(d >= RANGE.from && d <= RANGE.to).toBe(true);
    }
  });

  it("applies the status + staff filters to both reads", async () => {
    const rows: Row[] = [
      nonRecurring({ id: "match", status: "blocked", assigned_to: "u1" }),
      nonRecurring({ id: "wrong-status", status: "new", assigned_to: "u1" }),
      nonRecurring({ id: "wrong-staff", status: "blocked", assigned_to: "u2" }),
      nonRecurring({
        id: "rec-match",
        status: "blocked",
        assigned_to: "u1",
        recurring: { pattern: "weekly" },
        scheduled_date: "2026-08-03",
      }),
      nonRecurring({
        id: "rec-wrong",
        status: "new",
        assigned_to: "u1",
        recurring: { pattern: "weekly" },
        scheduled_date: "2026-08-03",
      }),
    ];
    const { rows: got } = await fetchCalendarJobs({
      supabase: makeClient(rows),
      orgId: ORG,
      range: RANGE,
      statusFilter: "blocked",
      staffFilter: "u1",
    });
    expect(got.map((r) => r.id).sort()).toEqual(["match", "rec-match"]);
  });

  it("surfaces a read error loudly instead of returning a partial-but-clean set", async () => {
    const failing = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "is", "not", "gte", "lte", "order"]) {
          b[m] = () => b;
        }
        b.range = () => Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    };
    const { rows: got, error } = await fetchCalendarJobs({
      supabase: failing as unknown as CalendarSupabaseClient,
      orgId: ORG,
      range: RANGE,
    });
    expect(error).toEqual({ message: "boom" });
    expect(got).toEqual([]);
  });
});

describe("wiring — the query strategy stays window-scoped + paged", () => {
  const lib = readFileSync(
    resolve(__dirname, "../../lib/schedule/calendar-data.ts"),
    "utf8",
  );
  const page = readFileSync(
    resolve(__dirname, "../../app/(app)/jobs/calendar/page.tsx"),
    "utf8",
  );

  it("the page no longer uses a blind .limit(1000)", () => {
    expect(page).not.toContain(".limit(1000)");
    expect(page).toContain("fetchCalendarJobs(");
  });

  it("non-recurring reads are date-bounded to the window and recurring reads are not", () => {
    expect(lib).toMatch(/\.is\("recurring", null\)/);
    expect(lib).toMatch(/\.gte\("scheduled_date", range\.from\)/);
    expect(lib).toMatch(/\.lte\("scheduled_date", range\.to\)/);
    expect(lib).toMatch(/\.not\("recurring", "is", null\)/);
  });

  it("both reads page under the cap with a deterministic scheduled_date+id order", () => {
    expect(lib).toContain("fetchAllRows");
    expect(lib).toMatch(/\.order\("scheduled_date", \{ ascending: true \}\)/);
    expect(lib).toMatch(/\.order\("id", \{ ascending: true \}\)/);
    // org scoping + FK-hinted users embed preserved
    expect(lib).toMatch(/\.eq\("org_id", orgId\)/);
    expect(lib).toContain("users!jobs_assigned_to_fkey");
  });
});

/**
 * F-? launch-blocker regression: expandRecurring() consumed its 60-occurrence
 * budget WALKING from the parent anchor, not producing in-window occurrences.
 * A far-anchored open-ended recurring job (weekly anchor >60 weeks before the
 * window; biweekly >60 fortnights; monthly >60 months) exited the loop before
 * ever reaching rangeFrom and returned [] — silently vanishing from the month
 * view, week view AND the schedule API (all three call expandRecurring), while
 * calendar-data.ts deliberately reads recurring parents UNBOUNDED so the DB
 * still holds the row. The fix makes the cap WINDOW-relative via a fast-forward
 * that lands on exactly the dates the naive loop would have produced.
 *
 * The prior regression test (above) only anchored ~4 weeks before the window,
 * so it never exercised this far-anchor class — this block closes that gap.
 */
describe("expandRecurring — window-relative cap for far-anchored parents", () => {
  const from = RANGE.from; // 2026-08-01
  const to = RANGE.to; // 2026-08-31

  const inWindow = (d: string) => d >= from && d <= to;

  // Naive, uncapped, step-by-step reference expansion — the ground truth the
  // fast-forward must match exactly (just skipping the pre-window dates).
  function naiveExpand(
    anchor: string,
    pattern: "weekly" | "biweekly" | "monthly" | "quarterly",
    endDate?: string,
  ): string[] {
    const stepDays = pattern === "weekly" ? 7 : pattern === "biweekly" ? 14 : 0;
    const stepMonths = pattern === "monthly" ? 1 : pattern === "quarterly" ? 3 : 0;
    const stop = endDate ? new Date(`${endDate}T00:00:00Z`) : null;
    const toD = new Date(`${to}T00:00:00Z`);
    let c = new Date(`${anchor}T00:00:00Z`);
    const out: string[] = [];
    // Unbounded walk (test-only) so we can compare dates independent of the cap.
    for (let i = 0; i < 100_000; i++) {
      if (stop && c > stop) break;
      if (c > toD) break;
      const iso = c.toISOString().slice(0, 10);
      if (iso >= from) out.push(iso);
      if (stepDays) {
        c = new Date(c);
        c.setUTCDate(c.getUTCDate() + stepDays);
      } else {
        c = new Date(c);
        c.setUTCMonth(c.getUTCMonth() + stepMonths);
      }
    }
    return out;
  }

  it("weekly parent anchored WAY more than 60 weeks before the window still expands", () => {
    // 2024-01-01 is ~83 weeks before 2026-08-01 — old loop returned [].
    const anchor = "2024-01-01"; // Monday
    const occ = expandRecurring(anchor, { pattern: "weekly" }, from, to);

    expect(occ.length).toBeGreaterThan(0);
    for (const d of occ) expect(inWindow(d)).toBe(true);
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    // Date-identity: exactly the naive in-window dates, in order.
    expect(occ).toEqual(naiveExpand(anchor, "weekly"));
  });

  it("biweekly parent anchored WAY more than 60 fortnights before the window still expands", () => {
    // ~4.5 years back = >100 fortnights.
    const anchor = "2022-01-03"; // Monday
    const occ = expandRecurring(anchor, { pattern: "biweekly" }, from, to);

    expect(occ.length).toBeGreaterThan(0);
    for (const d of occ) expect(inWindow(d)).toBe(true);
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(occ).toEqual(naiveExpand(anchor, "biweekly"));
  });

  it("monthly parent anchored WAY more than 60 months before the window still expands (path-dependent day-of-month preserved)", () => {
    // 2019-01-31: >90 months back AND a 31st anchor, so the fast-forward must
    // reproduce the loop's day-of-month rollover exactly (Jan31→Mar3→Apr3…).
    const anchor = "2019-01-31";
    const occ = expandRecurring(anchor, { pattern: "monthly" }, from, to);

    expect(occ.length).toBeGreaterThan(0);
    for (const d of occ) expect(inWindow(d)).toBe(true);
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    // Byte-identical to the naive iterative walk (proves no single-jump drift).
    expect(occ).toEqual(naiveExpand(anchor, "monthly"));
  });

  it("quarterly far-anchored parent expands and matches the naive walk", () => {
    const anchor = "2010-08-15"; // 16 years back, >60 quarters
    const occ = expandRecurring(anchor, { pattern: "quarterly" }, from, to);
    expect(occ.length).toBeGreaterThan(0);
    for (const d of occ) expect(inWindow(d)).toBe(true);
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(occ).toEqual(naiveExpand(anchor, "quarterly"));
  });

  it("far-anchored parent with an end_date BEFORE the window still yields [] (end_date honoured)", () => {
    // Weekly anchored years back but ended before the window opens.
    expect(
      expandRecurring(
        "2024-01-01",
        { pattern: "weekly", end_date: "2026-07-15" },
        from,
        to,
      ),
    ).toEqual([]);
    // Monthly variant (exercises the month fast-forward's stop guard).
    expect(
      expandRecurring(
        "2019-01-31",
        { pattern: "monthly", end_date: "2026-07-31" },
        from,
        to,
      ),
    ).toEqual([]);
  });

  it("end_date INSIDE the window truncates a far-anchored parent to the honoured tail", () => {
    const anchor = "2024-01-01"; // weekly, far back
    const endDate = "2026-08-14";
    const occ = expandRecurring(anchor, { pattern: "weekly", end_date: endDate }, from, to);
    expect(occ.length).toBeGreaterThan(0);
    for (const d of occ) {
      expect(inWindow(d)).toBe(true);
      expect(d <= endDate).toBe(true);
    }
    expect(occ).toEqual(naiveExpand(anchor, "weekly", endDate));
  });

  it("the anti-blowup cap still holds: a daily-dense-ish far-anchored parent never exceeds MAX_OCCURRENCES", () => {
    // Weekly across a 1-year window from a far anchor → ~52 occurrences, but
    // assert the cap is the ceiling regardless.
    const occ = expandRecurring("2020-01-06", { pattern: "weekly" }, "2026-01-01", "2027-12-31");
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
  });

  it("near-anchor parents are unaffected (no fast-forward when anchor is inside/after the window)", () => {
    // Anchor inside the window: first occurrence is the anchor itself.
    const occ = expandRecurring("2026-08-03", { pattern: "weekly" }, from, to);
    expect(occ[0]).toBe("2026-08-03");
    expect(occ).toEqual(naiveExpand("2026-08-03", "weekly"));
    // Anchor after the window: nothing.
    expect(expandRecurring("2026-09-10", { pattern: "weekly" }, from, to)).toEqual([]);
  });
});
