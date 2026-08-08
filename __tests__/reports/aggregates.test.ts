import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * REPORTS AGGREGATES — no silent 1000-row truncation (F-1).
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * Supabase/PostgREST caps every response at the project "Max rows" setting
 * (1000). A bare `.select()` with no `.range()` is therefore SILENTLY TRUNCATED
 * the moment an org crosses that many matching rows — so revenue/VAT/job/customer
 * figures aggregate over only the first page and UNDER-REPORT with no error.
 * `lib/reports/aggregates.ts` was the sole reporting holdout; the fix routes
 * every read through `fetchAllRows`, which pages under the cap.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL, NOT A SOURCE GREP ──────────────────────────
 * The four aggregates are EXECUTED against a chainable Supabase mock that honours
 * `.range(from, to)` exactly the way PostgREST does — an inclusive window that is
 * itself capped at 1000 rows per response. Each entity is seeded with MORE than
 * 1000 rows. If any read dropped its `.range()` (or fetched a single page), the
 * mock would clip the response at 1000 and the asserted totals/counts would come
 * up short. Because the mock caps like the real cap, only a correctly paged read
 * can see every row.
 *
 * ── HERMETIC ─────────────────────────────────────────────────────────────────
 * No real Supabase client is ever constructed (Node-20 CI has no native
 * WebSocket, so a real realtime client would throw). `createClient` is mocked to
 * return a pure in-memory fake.
 */

// The real PostgREST max-rows cap the mock emulates: a single response can never
// return more than this many rows, no matter how wide the requested range.
const RESPONSE_CAP = 1000;

const h = vi.hoisted(() => {
  // Table name → the full row set (as Postgres would hold it). The mock filters
  // + paginates over this, capping each response at RESPONSE_CAP.
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  // How large a single response may be — set by the test to emulate the cap.
  const cap = { rows: 1000 };

  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const gtes: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];

    const settle = (from: number, to: number) => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        for (const [col, val] of gtes) {
          if (row[col] == null) return false;
          if (String(row[col]) < String(val)) return false;
        }
        return true;
      });
      // Apply every ordering key in sequence (stable), last-specified last so
      // the id tiebreak decides ties — exactly what a total order must do.
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      // PostgREST semantics: inclusive [from, to], then the response is HARD
      // capped at RESPONSE_CAP no matter how wide the range asked for.
      const windowed = rows.slice(from, to + 1).slice(0, cap.rows);
      return Promise.resolve({ data: windowed, error: null });
    };

    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      gte(col: string, val: unknown) {
        gtes.push([col, val]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        return settle(from, to);
      },
    };
    return builder;
  }

  return {
    tables,
    cap,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      cap.rows = RESPONSE_CAP;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

// server-only is a no-op guard we don't want to hit under vitest.
vi.mock("server-only", () => ({}));

const { jobsPerWeek, revenuePerMonth, vatPerQuarter, topCustomersByRevenue } =
  await import("@/lib/reports/aggregates");

const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";

/** An ISO datetime N days before now (safely inside a lookback window). */
function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function daysAgoDate(n: number): string {
  return daysAgoIso(n).slice(0, 10);
}

beforeEach(() => {
  h.reset();
});

describe("aggregates page past the 1000-row PostgREST cap (F-1)", () => {
  it("revenuePerMonth sums EVERY paid invoice, not just the first 1000", async () => {
    const N = 2500;
    // Spread across the last ~6 months so all land inside the 12-month window.
    // Revenue is EX-VAT: each invoice nets £10 (`amount`) with a GROSS `total` of
    // £12 (amount + vat_total). A correct total is N*£10; if the code regressed to
    // summing gross `total` it would come up N*£12 and fail.
    h.tables.invoices = Array.from({ length: N }, (_, i) => ({
      id: `inv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      status: "paid",
      amount: 10,
      total: 12,
      vat_total: 2,
      paid_at: daysAgoIso((i % 150) + 1),
    }));
    // A same-org UNPAID invoice and a paid invoice in ANOTHER org — neither may
    // be counted; both sit inside the row set the mock would otherwise return.
    h.tables.invoices.push(
      { id: "inv-unpaid", org_id: ORG, status: "draft", amount: 999999, total: 999999, vat_total: 0, paid_at: daysAgoIso(3) },
      { id: "inv-other", org_id: OTHER_ORG, status: "paid", amount: 999999, total: 999999, vat_total: 0, paid_at: daysAgoIso(3) },
    );

    const rows = await revenuePerMonth(ORG, 12);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    expect(total).toBe(N * 10);
  });

  it("vatPerQuarter sums output AND input VAT across full paged reads (two reads)", async () => {
    const N = 1600;
    h.tables.invoices = Array.from({ length: N }, (_, i) => ({
      id: `inv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      status: "paid",
      total: 100,
      vat_total: 5,
      paid_at: daysAgoIso((i % 180) + 1),
    }));
    h.tables.finances = Array.from({ length: N }, (_, i) => ({
      id: `fin-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      vat_total: 3,
      created_at: daysAgoIso((i % 180) + 1),
    }));

    const rows = await vatPerQuarter(ORG, 4);
    const output = rows.reduce((s, r) => s + r.output_vat, 0);
    const input = rows.reduce((s, r) => s + r.input_vat, 0);
    // If either read were truncated at 1000, these would fall short.
    expect(output).toBe(N * 5);
    expect(input).toBe(N * 3);
    const net = rows.reduce((s, r) => s + r.net_vat, 0);
    expect(net).toBeCloseTo(N * 5 - N * 3, 5);
  });

  it("topCustomersByRevenue attributes revenue from every invoice past the cap", async () => {
    // 1500 paid invoices split across two customers; the SECOND customer's
    // invoices are sorted LAST by id, so a single-page read would miss them
    // entirely and drop the customer from the ranking.
    const N = 1500;
    // Revenue is EX-VAT: `amount` is the net contribution; `total` is gross and
    // must NOT be summed. Setting total ≠ amount catches a regression to gross.
    h.tables.invoices = Array.from({ length: N }, (_, i) => {
      const second = i >= N / 2;
      return {
        id: `inv-${String(i).padStart(6, "0")}`,
        org_id: ORG,
        status: "paid",
        amount: second ? 20 : 10,
        total: second ? 24 : 12,
        quote: {
          customer: { id: second ? "cust-B" : "cust-A", name: second ? "Beta" : "Alpha" },
        },
      };
    });

    const rows = await topCustomersByRevenue(ORG, 10);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // Both customers present; each got all 750 of its invoices.
    expect(byId["cust-A"]?.invoice_count).toBe(N / 2);
    expect(byId["cust-B"]?.invoice_count).toBe(N / 2);
    expect(byId["cust-A"]?.revenue).toBe((N / 2) * 10);
    expect(byId["cust-B"]?.revenue).toBe((N / 2) * 20);
  });

  it("topCustomersByRevenue resolves via customer_id when the quote is gone, and never drops paid revenue", async () => {
    // The C35 gap: `invoices_quote_id_fkey` is ON DELETE SET NULL, so deleting a
    // quote nulls quote/quote.customer while the denormalised `customer_id`
    // survives. Resolving via the embed ALONE silently dropped that invoice's
    // paid revenue. Three populations, all paid:
    //   A — customer_id set, quote DELETED (quote is null): must attribute to A.
    //   B — legacy row: no customer_id, resolves via the quote embed (unchanged).
    //   ∅ — neither customer_id nor quote.customer: must land in Unattributed,
    //       NOT be dropped, so the ranking's total reconciles with paid revenue.
    h.tables.customers = [
      { id: "cust-A", org_id: ORG, name: "Alpha" },
      { id: "cust-B", org_id: ORG, name: "Beta" },
      // A customer that belongs to ANOTHER org must never leak in as a name.
      { id: "cust-X", org_id: OTHER_ORG, name: "Xenon" },
    ];
    // Revenue is EX-VAT: `amount` is what the ranking sums; `total` (gross) is set
    // higher so a regression to summing `total` would break the reconciliation.
    h.tables.invoices = [
      // A: customer_id set, quote deleted (SET NULL) → still counts for Alpha.
      { id: "inv-a1", org_id: ORG, status: "paid", amount: 100, total: 120, customer_id: "cust-A", quote: null },
      { id: "inv-a2", org_id: ORG, status: "paid", amount: 50, total: 60, customer_id: "cust-A", quote: null },
      // B: legacy row, no customer_id → resolves via the quote embed fallback.
      {
        id: "inv-b1",
        org_id: ORG,
        status: "paid",
        amount: 30,
        total: 36,
        customer_id: null,
        quote: { customer: { id: "cust-B", name: "Beta" } },
      },
      // ∅: neither resolvable → Unattributed bucket, not dropped.
      { id: "inv-z1", org_id: ORG, status: "paid", amount: 7, total: 8.4, customer_id: null, quote: null },
      {
        id: "inv-z2",
        org_id: ORG,
        status: "paid",
        amount: 3,
        total: 3.6,
        customer_id: null,
        quote: { customer: null },
      },
    ];

    const rows = await topCustomersByRevenue(ORG, 10);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // (a) customer_id wins even with the quote gone.
    expect(byId["cust-A"]?.name).toBe("Alpha");
    expect(byId["cust-A"]?.revenue).toBe(150);
    expect(byId["cust-A"]?.invoice_count).toBe(2);

    // (c) the quote.customer fallback path still works.
    expect(byId["cust-B"]?.name).toBe("Beta");
    expect(byId["cust-B"]?.revenue).toBe(30);
    expect(byId["cust-B"]?.invoice_count).toBe(1);

    // (b) unresolvable revenue is bucketed, not dropped.
    const unattributed = rows.find((r) => r.name === "Unattributed");
    expect(unattributed?.revenue).toBe(10);
    expect(unattributed?.invoice_count).toBe(2);

    // Reconciliation: the ranking's total equals ALL paid revenue.
    const rankedTotal = rows.reduce((s, r) => s + r.revenue, 0);
    expect(rankedTotal).toBe(150 + 30 + 10);
  });

  it("jobsPerWeek counts every job in the window, not a truncated first page", async () => {
    const N = 2000;
    // All within the last 28 days — comfortably inside the 8 pre-filled weekly
    // buckets regardless of today's weekday. Half completed.
    h.tables.jobs = Array.from({ length: N }, (_, i) => ({
      id: `job-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      status: i % 2 === 0 ? "completed" : "scheduled",
      scheduled_date: daysAgoDate((i % 28) + 1),
    }));

    const rows = await jobsPerWeek(ORG, 8);
    const total = rows.reduce((s, r) => s + r.total, 0);
    const completed = rows.reduce((s, r) => s + r.completed, 0);
    expect(total).toBe(N);
    expect(completed).toBe(N / 2);
  });

  it("would UNDER-count if a read stopped at one page — the cap is real", async () => {
    // Guard on the harness itself: with paging DISABLED (cap forces one short
    // page) the same dataset visibly under-reports, proving the assertions above
    // are only satisfiable by a genuine multi-page walk.
    const N = 2500;
    h.tables.invoices = Array.from({ length: N }, (_, i) => ({
      id: `inv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      status: "paid",
      amount: 10,
      total: 12,
      vat_total: 2,
      paid_at: daysAgoIso((i % 150) + 1),
    }));
    // Emulate a world where each response is capped AND the reader only ever
    // takes the first page: force the cap to 1000 and confirm a naive first-page
    // sum (what the OLD code did) is strictly less than the true total. Sum the
    // EX-VAT `amount` the fixed reader uses so the guard tracks the real code.
    const firstPageOnly = h.tables.invoices.slice(0, 1000);
    const naive = firstPageOnly.reduce((s, r) => s + (r.amount as number), 0);
    const rows = await revenuePerMonth(ORG, 12);
    const paged = rows.reduce((s, r) => s + r.revenue, 0);
    expect(naive).toBeLessThan(paged);
    expect(paged).toBe(N * 10);
  });
});

/**
 * REPORTS REVENUE IS EX-VAT — never the gross generated `total`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `invoices.total` is a STORED GENERATED column (= amount + vat_total), so it is
 * GROSS — it includes the VAT the business collects on HMRC's behalf, which is
 * never turnover. revenuePerMonth() and topCustomersByRevenue() summed `total`,
 * overstating /reports revenue (and the CSV export that reuses them) by the VAT
 * rate (~20%) and disagreeing with /insights + /dashboard, which report the
 * ex-VAT `amount` (lib/intelligence/concentration.ts documents the rule). The fix
 * selects and sums `amount`.
 *
 * A behavioural assertion (a VAT-bearing invoice contributes its NET) plus a
 * static source assertion (the reads select `amount`, not `total`) so a future
 * regression to gross fails CI on both axes.
 */
/**
 * MONTH-WINDOW CONSTRUCTION MUST NOT OVERFLOW ON A 29/30/31 `now` (C48).
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * revenuePerMonth built its window by mutating a live Date:
 *   since.setUTCMonth(getUTCMonth() - months + 1); since.setUTCDate(1)
 * and each bucket key the same way. setUTCMonth runs WHILE the Date still holds
 * day 29/30/31, so for a shorter target month it OVERFLOWS into the following
 * month (the day-1 floor happens too late). On a 31st the 12-month loop produced
 * only 7 DISTINCT buckets (duplicated/skipped months); the invoice-key path uses
 * the day-safe startOfMonth(), so an invoice whose real month had no bucket hit
 * `if (!slot) continue;` and its revenue was SILENTLY DROPPED — a live financial
 * miscompute on /reports and the CSV export. The fix builds every window month
 * from a day-1-normalised Date.UTC() base, which can never overflow.
 *
 * These tests FREEZE `now` to month-ends (a 31st, a 30th, and the Feb-28/29
 * boundary) and assert the window is always 12 DISTINCT months with every seeded
 * invoice in its correct bucket. Pre-fix, the 31st case yields 7 distinct months
 * and drops revenue → these assertions fail; post-fix they pass.
 */
describe("revenuePerMonth window never overflows on a 29/30/31 now (C48)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Freeze to `frozenIso`, seed exactly one paid invoice per trailing 12 months
   * (each a distinct amount, placed mid-month), and assert 12 distinct buckets
   * with every invoice attributed to its own month — no drops, no duplicates.
   */
  async function assertTwelveDistinctMonths(frozenIso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(frozenIso));

    const now = new Date(frozenIso);
    // Expected bucket key for each of the 12 trailing months (first-of-month ISO).
    const expected = new Map<string, number>();
    const invoices: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) {
      const first = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const key = first.toISOString().slice(0, 10);
      const amount = (i + 1) * 100; // distinct per month → catches mis-bucketing
      expected.set(key, amount);
      // Place the invoice mid-month (day 15) so it can't slip a month boundary.
      const midMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15, 12),
      );
      invoices.push({
        id: `inv-${String(i).padStart(2, "0")}`,
        org_id: ORG,
        status: "paid",
        amount,
        total: amount * 1.2,
        vat_total: amount * 0.2,
        paid_at: midMonth.toISOString(),
      });
    }
    h.tables.invoices = invoices;

    const rows = await revenuePerMonth(ORG, 12);

    // Exactly 12 buckets, all distinct.
    expect(rows).toHaveLength(12);
    const months = rows.map((r) => r.month);
    expect(new Set(months).size).toBe(12);
    // Every expected month present, each carrying exactly its own invoice — the
    // fingerprint of correct bucketing (no drop, no duplicate collapse).
    for (const [key, amount] of expected) {
      const slot = rows.find((r) => r.month === key);
      expect(slot, `missing bucket ${key}`).toBeDefined();
      expect(slot!.revenue).toBe(amount);
    }
    // Nothing dropped: the sum of all buckets equals the sum of all invoices.
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    const seeded = [...expected.values()].reduce((s, a) => s + a, 0);
    expect(total).toBe(seeded);
  }

  it("31st: now=2026-08-31 yields 12 distinct months, no dropped revenue", async () => {
    await assertTwelveDistinctMonths("2026-08-31T00:00:00.000Z");
  });

  it("30th: now=2026-07-30 yields 12 distinct months, no dropped revenue", async () => {
    await assertTwelveDistinctMonths("2026-07-30T00:00:00.000Z");
  });

  it("Feb 28 boundary: now=2026-02-28 yields 12 distinct months", async () => {
    await assertTwelveDistinctMonths("2026-02-28T00:00:00.000Z");
  });

  it("Feb 29 leap boundary: now=2028-02-29 yields 12 distinct months", async () => {
    await assertTwelveDistinctMonths("2028-02-29T00:00:00.000Z");
  });
});

describe("reports revenue is EX-VAT (amount), not gross (total)", () => {
  it("a VAT-bearing paid invoice contributes its NET amount to revenuePerMonth", async () => {
    // amount=10, vat_total=2, total=12. Turnover is 10, not 12.
    h.tables.invoices = [
      {
        id: "inv-vat",
        org_id: ORG,
        status: "paid",
        amount: 10,
        vat_total: 2,
        total: 12,
        paid_at: daysAgoIso(5),
      },
    ];

    const rows = await revenuePerMonth(ORG, 12);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    expect(total).toBe(10); // ex-VAT — NOT 12
  });

  it("a VAT-bearing paid invoice contributes its NET amount to topCustomersByRevenue", async () => {
    h.tables.customers = [{ id: "cust-A", org_id: ORG, name: "Alpha" }];
    h.tables.invoices = [
      {
        id: "inv-vat",
        org_id: ORG,
        status: "paid",
        amount: 10,
        vat_total: 2,
        total: 12,
        customer_id: "cust-A",
        quote: null,
      },
    ];

    const rows = await topCustomersByRevenue(ORG, 10);
    const alpha = rows.find((r) => r.id === "cust-A");
    expect(alpha?.revenue).toBe(10); // ex-VAT — NOT 12
    expect(alpha?.invoice_count).toBe(1);
  });

  it("SOURCE GUARD: both reads select `amount` and never sum gross `total`", () => {
    const src = readFileSync(
      resolve(process.cwd(), "lib/reports/aggregates.ts"),
      "utf8",
    );

    // Isolate revenuePerMonth() … its terminating brace before vatPerQuarter().
    const rpmStart = src.indexOf("export async function revenuePerMonth");
    const rpmEnd = src.indexOf("export async function vatPerQuarter");
    expect(rpmStart).toBeGreaterThan(-1);
    expect(rpmEnd).toBeGreaterThan(rpmStart);
    const rpm = src.slice(rpmStart, rpmEnd);
    // Selects the ex-VAT column and accumulates it; never accumulates `total`.
    expect(rpm).toMatch(/select\([^)]*\bamount\b/);
    expect(rpm).toMatch(/\.revenue\s*\+=\s*Number\(\s*inv\.amount\b/);
    expect(rpm).not.toMatch(/\.revenue\s*\+=\s*Number\(\s*inv\.total\b/);

    // Isolate topCustomersByRevenue() to end-of-file.
    const tcStart = src.indexOf("export async function topCustomersByRevenue");
    expect(tcStart).toBeGreaterThan(-1);
    const tc = src.slice(tcStart);
    expect(tc).toMatch(/\bamount\b/);
    expect(tc).toMatch(/\.revenue\s*\+=\s*Number\(\s*inv\.amount\b/);
    expect(tc).not.toMatch(/\.revenue\s*\+=\s*Number\(\s*inv\.total\b/);
  });
});
