import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DAILY BRIEFING — loud-or-whole read failures (launch blocker).
 *
 * THE BUG. `pagedRows` destructured only `{ data }` from `fetchAllRows` and
 * DISCARDED the error. `fetchAllRows` hands back the rows-so-far PLUS the error
 * on a MID-PAGE failure (and `[]` if the very first page fails). So a single
 * table hiccup — a statement timeout on the big invoices/quotes table, a
 * one-table RLS/permission blip — silently zeroed ONE signal (a false all-clear
 * on overdue invoices / stale quotes / cold leads / retention / upcoming
 * compliance-document expiry) while every OTHER signal rendered healthy. The
 * outer try/catch never caught it because `pagedRows` never threw. The
 * compliance-expiry read (the only expiry signal) had the same shape via
 * `complianceRes.data ?? []` with no error check.
 *
 * THE FIX. Every `.data` read in the loader now THROWS readFailure on error, so
 * ANY read failure degrades the WHOLE briefing to its honest empty state — never
 * a reduced/zeroed count that reads as an all-clear.
 *
 * These tests prove the CONTRAST: an identical seed renders a populated briefing
 * when reads succeed, and the EMPTY briefing (items: []) the instant one read
 * fails — not a briefing that is merely missing the failed signal.
 *
 * Hermetic: `@/lib/supabase/server` is mocked with a cap-emulating fake client
 * (no Supabase, no realtime under Node-20), mirroring the sibling
 * briefing-compliance-volume test. `errorOn` injects a read failure on a chosen
 * table/page range.
 */

const CLAMP = 1000; // supabase/config.toml max_rows
const PAGE = 500; // lib/supabase/paginate PAGE_SIZE
type Row = Record<string, unknown>;

const dbTables: Record<string, Row[]> = {};
/** Inject a read failure: true ⇒ the range/bare read for `table` errors. */
let errorOn: { table: string; when: (from: number, to: number) => boolean } | null = null;
const READ_ERROR = { message: "statement timeout", code: "57014" };

/** A chainable builder that MODELS the PostgREST max_rows clamp + the filters. */
function makeBuilder(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  const orderSpecs: Array<[string, boolean]> = [];
  let limitN: number | null = null;

  const compute = (): Row[] => {
    let rows = (dbTables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (orderSpecs.length) {
      rows = [...rows].sort((a, b) => {
        for (const [c, asc] of orderSpecs) {
          const av = a[c] as string | number | null;
          const bv = b[c] as string | number | null;
          if (av == null && bv == null) continue;
          if (av == null) return asc ? -1 : 1;
          if (bv == null) return asc ? 1 : -1;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
        }
        return 0;
      });
    }
    return rows;
  };

  // A bare (unpaged) read is clamped to 1000, exactly like PostgREST. An
  // injected error surfaces here (jobs-tomorrow / dismissals go through `then`).
  const resolveAll = () => {
    if (errorOn && errorOn.table === table && errorOn.when(0, CLAMP - 1)) {
      return { data: null, error: READ_ERROR, count: null };
    }
    const all = compute();
    const capped = limitN != null ? all.slice(0, Math.min(limitN, CLAMP)) : all.slice(0, CLAMP);
    return { data: capped, error: null, count: all.length };
  };

  const proxy: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        switch (prop) {
          case "eq":
            return (c: string, v: unknown) => (preds.push((r) => r[c] === v), proxy);
          case "neq":
            return (c: string, v: unknown) => (preds.push((r) => r[c] !== v), proxy);
          case "in":
            return (c: string, v: readonly unknown[]) => (preds.push((r) => v.includes(r[c])), proxy);
          case "is":
            return (c: string, v: unknown) =>
              (preds.push((r) => (v === null ? r[c] == null : r[c] === v)), proxy);
          case "not":
            return (c: string, op: string, v: unknown) => (
              preds.push((r) => (op === "is" && v === null ? r[c] != null : r[c] !== v)),
              proxy
            );
          case "gte":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) >= (v as string)), proxy);
          case "gt":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) > (v as string)), proxy);
          case "lte":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) <= (v as string)), proxy);
          case "lt":
            return (c: string, v: unknown) =>
              (preds.push((r) => r[c] != null && (r[c] as string) < (v as string)), proxy);
          case "order":
            return (c: string, o?: { ascending?: boolean }) => (
              orderSpecs.push([c, o?.ascending !== false]),
              proxy
            );
          case "limit":
            return (n: number) => ((limitN = n), proxy);
          case "range":
            return (from: number, to: number) => {
              // Model a MID-PAGE failure: fetchAllRows would have gathered the
              // first full page(s), then this page errors → partial set + error.
              if (errorOn && errorOn.table === table && errorOn.when(from, to)) {
                return Promise.resolve({ data: null, error: READ_ERROR });
              }
              return Promise.resolve({
                data: compute().slice(from, from + Math.min(to - from + 1, CLAMP)),
                error: null,
              });
            };
          case "maybeSingle":
            return () => Promise.resolve({ data: compute()[0] ?? null, error: null });
          case "single":
            return () => Promise.resolve({ data: compute()[0] ?? null, error: null });
          case "then":
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(resolveAll()).then(res, rej);
          // select() and any other chainable method → no-op returning the builder.
          default:
            return () => proxy;
        }
      },
    },
  );
  return proxy;
}

const fakeClient = { from: (t: string) => makeBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient }));

import { buildDailyBriefing } from "@/server/services/briefing";

const ORG = "org-A";
const USER = "user-1";
const NOW = new Date("2026-08-06T09:00:00Z");
const TODAY = "2026-08-06";

/** A seed that, when every read SUCCEEDS, produces at least the overdue-invoice
 *  and compliance-expiry lines — the control so "empty on error" is meaningful. */
function seedHealthy() {
  // 900 overdue invoices — spans two pages (>PAGE), so a page-2 error models a
  // genuine mid-page failure rather than a first-page one.
  dbTables.invoices = Array.from({ length: 900 }, (_, i) => ({
    id: `inv-${String(i).padStart(4, "0")}`,
    org_id: ORG,
    status: "sent",
    total: 100,
    amount: 100,
    due_date: "2026-07-01", // well past TODAY ⇒ overdue
    job_id: null,
  }));
  dbTables.compliance_documents = [
    { id: "up-1", org_id: ORG, expires_at: "2026-08-08" }, // +2 days ⇒ upcoming
  ];
}

beforeEach(() => {
  for (const k of Object.keys(dbTables)) delete dbTables[k];
  errorOn = null;
});
afterEach(() => vi.restoreAllMocks());

describe("Daily Briefing — a read failure degrades the WHOLE briefing, never one signal", () => {
  it("control: with every read healthy, the briefing is POPULATED", async () => {
    seedHealthy();
    const briefing = await buildDailyBriefing(ORG, USER, NOW);
    expect(briefing.items.length, "a healthy seed must produce signals").toBeGreaterThan(0);
    const overdue = briefing.items.find((i) => i.key === "overdue_invoices");
    expect(overdue, "the overdue-invoices line must be present").toBeTruthy();
    expect(overdue!.count).toBe(900);
    expect(briefing.items.find((i) => i.key === "compliance_expiring")).toBeTruthy();
    // sanity: the calendar floor is today.
    expect(TODAY).toBe("2026-08-06");
  });

  it("a MID-PAGE invoices error empties the WHOLE briefing (not a zeroed overdue count)", async () => {
    seedHealthy();
    // Page 1 (rows 0-499) succeeds; the second page (from >= PAGE) errors — the
    // exact partial-set-plus-error path pagedRows used to swallow.
    errorOn = { table: "invoices", when: (from) => from >= PAGE };

    const briefing = await buildDailyBriefing(ORG, USER, NOW);

    // The whole briefing degrades: NO items at all. Critically NOT a briefing
    // that merely dropped the overdue line while showing the rest as an all-clear.
    expect(briefing.items).toEqual([]);
    expect(briefing.items.find((i) => i.key === "overdue_invoices")).toBeUndefined();
    // Other signals are gone too — proof the whole section degraded, not one read.
    expect(briefing.items.find((i) => i.key === "compliance_expiring")).toBeUndefined();
  });

  it("a compliance-documents read error empties the WHOLE briefing (the only expiry signal)", async () => {
    seedHealthy();
    errorOn = { table: "compliance_documents", when: () => true };

    const briefing = await buildDailyBriefing(ORG, USER, NOW);

    // A false all-clear on an expiring certificate is the precise failure this
    // guards: the compliance line must NOT silently collapse to count=0 while the
    // healthy overdue-invoice line still renders.
    expect(briefing.items).toEqual([]);
    expect(briefing.items.find((i) => i.key === "compliance_expiring")).toBeUndefined();
    expect(briefing.items.find((i) => i.key === "overdue_invoices")).toBeUndefined();
  });
});
