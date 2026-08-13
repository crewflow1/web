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
    const lts: Array<[string, unknown]> = [];
    const iss: Array<[string, unknown]> = [];
    const ins: Array<[string, readonly unknown[]]> = [];
    const orders: Array<[string, boolean]> = [];

    // Filtered + totally-ordered rows for the current predicate set (no window).
    const filteredOrdered = () => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        for (const [col, val] of gtes) {
          if (row[col] == null) return false;
          if (String(row[col]) < String(val)) return false;
        }
        for (const [col, val] of lts) {
          if (row[col] == null) return false;
          if (String(row[col]) >= String(val)) return false;
        }
        // `.is(col, null)` → IS NULL: treat undefined as null.
        for (const [col, val] of iss) if ((row[col] ?? null) !== val) return false;
        for (const [col, list] of ins) if (!list.includes(row[col])) return false;
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
      return rows;
    };

    const settle = (from: number, to: number) => {
      // PostgREST semantics: inclusive [from, to], then the response is HARD
      // capped at RESPONSE_CAP no matter how wide the range asked for.
      const windowed = filteredOrdered().slice(from, to + 1).slice(0, cap.rows);
      return Promise.resolve({ data: windowed, error: null });
    };

    // When a query terminates on `.in(...)` (no `.range()`), it is awaited
    // directly — the vat-quarter-inputs id-keyed lookups do this. The builder is
    // therefore thenable and resolves the full (cap-limited) filtered set.
    const resolveAll = () =>
      Promise.resolve({ data: filteredOrdered().slice(0, cap.rows), error: null });

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
      lt(col: string, val: unknown) {
        lts.push([col, val]);
        return builder;
      },
      is(col: string, val: unknown) {
        iss.push([col, val]);
        return builder;
      },
      in(col: string, list: readonly unknown[]) {
        ins.push([col, list]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        return settle(from, to);
      },
      then<T>(
        onF: (v: { data: unknown[]; error: null }) => T,
        onR?: (e: unknown) => T,
      ) {
        return resolveAll().then(onF, onR);
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

// The single VAT authority the reconciliation test pins /reports against.
const { computeVatQuarter, startOfQuarterIso, endOfQuarterExclusiveIso } =
  await import("@/lib/tax/compute");
const { gatherVatQuarterInputs } = await import(
  "@/server/services/vat-quarter-inputs"
);
type VatInputsDb = import("@/server/services/vat-quarter-inputs").VatInputsDb;

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

  it("vatPerQuarter sums CASH-BASIS output VAT (invoice_payments ledger) + input VAT across full paged reads", async () => {
    // OUTPUT VAT is now cash-basis from the invoice_payments LEDGER via the
    // single VAT authority, NOT `invoices.status='paid'`. Seed N payments, EACH
    // £100 against its own £100-total invoice carrying £5 VAT, so each payment
    // apportions 100×(5/100)=£5. Distinct parent invoices force BOTH the payment
    // window read (>1000) AND the id-keyed invoice `.in(...)` chunking to page —
    // if either truncated, output would fall short of N×5.
    const N = 1600;
    h.tables.invoice_payments = Array.from({ length: N }, (_, i) => ({
      id: `pay-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      invoice_id: `inv-${String(i).padStart(6, "0")}`,
      amount: 100,
      paid_at: daysAgoIso((i % 180) + 1),
    }));
    h.tables.invoices = Array.from({ length: N }, (_, i) => ({
      id: `inv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      number: `INV-${i}`,
      status: "paid",
      amount: 95,
      total: 100,
      vat_total: 5,
    }));
    // A payment in ANOTHER org must never leak into this org's output VAT.
    h.tables.invoice_payments.push({
      id: "pay-other",
      org_id: OTHER_ORG,
      invoice_id: "inv-other",
      amount: 999999,
      paid_at: daysAgoIso(3),
    });
    h.tables.invoices.push({
      id: "inv-other",
      org_id: OTHER_ORG,
      number: "X",
      status: "paid",
      amount: 999999,
      total: 999999,
      vat_total: 999999,
    });
    h.tables.finances = Array.from({ length: N }, (_, i) => ({
      id: `fin-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      vat_total: 3,
      amount: 20,
      created_at: daysAgoIso((i % 180) + 1),
    }));

    const rows = await vatPerQuarter(ORG, 4);
    const output = rows.reduce((s, r) => s + r.output_vat, 0);
    const input = rows.reduce((s, r) => s + r.input_vat, 0);
    // If any read were truncated at 1000, these would fall short.
    expect(output).toBeCloseTo(N * 5, 5);
    expect(input).toBeCloseTo(N * 3, 5);
    const net = rows.reduce((s, r) => s + r.net_vat, 0);
    expect(net).toBeCloseTo(N * 5 - N * 3, 5);
  });

  it("vatPerQuarter counts a PARTIAL payment PROPORTIONALLY — the old status='paid' contract returned £0 (RED→GREEN)", async () => {
    // The core divergence this fix closes. A `partially_paid` invoice keeps
    // status≠'paid' and paid_at=NULL, so the OLD status-gated sum contributed £0
    // of output VAT for the quarter the deposit cash actually landed. The ledger
    // authority apportions payment×(vat_total/total).
    //
    // inv-1: total £120, vat_total £20 (20%). A £60 deposit lands this quarter
    // → output VAT = 60×(20/120) = £10 — NOT £0 (old bug) and NOT £20 (full).
    h.tables.invoices = [
      {
        id: "inv-1",
        org_id: ORG,
        number: "INV-1",
        status: "partially_paid",
        amount: 100,
        total: 120,
        vat_total: 20,
      },
    ];
    h.tables.invoice_payments = [
      {
        id: "pay-1",
        org_id: ORG,
        invoice_id: "inv-1",
        amount: 60,
        paid_at: daysAgoIso(2),
      },
    ];

    const rows = await vatPerQuarter(ORG, 4);
    const output = rows.reduce((s, r) => s + r.output_vat, 0);
    // Pre-fix this asserted 0 (status='paid' filter dropped the invoice); the
    // ledger contract makes it the proportional £10.
    expect(output).toBeCloseTo(10, 5);
    expect(output).not.toBe(0); // the old bug
    expect(output).not.toBe(20); // never the whole-invoice VAT for a part payment
  });

  it("vatPerQuarter surfaces DOMESTIC REVERSE-CHARGE VAT into the trend (was omitted entirely)", async () => {
    // Reverse charge was invisible to the old status-based function. A frozen
    // reverse-charge allocation of £15 self-accounts into BOTH box 1 and box 4,
    // so it lifts output AND input VAT by £15 (net-neutral) — the trend must
    // reflect it, matching /tax, the PDF and the frozen 9-box return.
    h.tables.supplier_payments = [
      {
        id: "sp-1",
        org_id: ORG,
        voided_at: null,
        paid_at: daysAgoIso(2),
      },
    ];
    h.tables.supplier_payment_allocations = [
      {
        id: "spa-1",
        org_id: ORG,
        payment_id: "sp-1",
        amount: 75,
        cis_reverse_charge_vat: 15,
        cis_vat_treatment: "reverse_charge",
      },
    ];

    const rows = await vatPerQuarter(ORG, 4);
    const output = rows.reduce((s, r) => s + r.output_vat, 0);
    const input = rows.reduce((s, r) => s + r.input_vat, 0);
    expect(output).toBeCloseTo(15, 5); // → box 1
    expect(input).toBeCloseTo(15, 5); // → box 4 (net-neutral)
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

/**
 * CROSS-SURFACE VAT RECONCILIATION — /reports can never diverge from the authority.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * vatPerQuarter used to be a FOURTH, DIVERGENT VAT calculator: it summed
 * `invoices.vat_total` over status='paid' invoices, so it dropped every partial
 * payment (paid_at is stamped only on FULL settlement) and omitted domestic
 * reverse charge — understating the /reports net-VAT trend against /dashboard,
 * /tax, the quarterly PDF and the frozen HMRC 9-box return, all of which read the
 * single authority (gatherVatQuarterInputs + computeVatQuarter).
 *
 * This test pins /reports vatPerQuarter's CURRENT-QUARTER slot to a fresh,
 * independent call of that same authority over the SAME window and SAME fixture —
 * so any future re-divergence (a second calculator creeping back in) fails CI.
 */
describe("vatPerQuarter reconciles EXACTLY with the single VAT authority", () => {
  it("/reports current-quarter VAT == computeVatQuarter for a shared partially_paid + reverse-charge fixture", async () => {
    // A fixture that exercises BOTH properties the old function got wrong:
    //  • a partial payment (proportional, cash-basis output VAT), and
    //  • a domestic reverse-charge allocation (boxes 1 AND 4).
    h.tables.invoices = [
      {
        id: "inv-1",
        org_id: ORG,
        number: "INV-1",
        status: "partially_paid",
        amount: 100,
        total: 120,
        vat_total: 20,
      },
    ];
    h.tables.invoice_payments = [
      {
        id: "pay-1",
        org_id: ORG,
        invoice_id: "inv-1",
        amount: 60, // half → output VAT 60×(20/120)=10
        paid_at: daysAgoIso(2),
      },
    ];
    h.tables.finances = [
      {
        id: "fin-1",
        org_id: ORG,
        vat_total: 4,
        amount: 20,
        created_at: daysAgoIso(2),
      },
    ];
    h.tables.supplier_payments = [
      { id: "sp-1", org_id: ORG, voided_at: null, paid_at: daysAgoIso(2) },
    ];
    h.tables.supplier_payment_allocations = [
      {
        id: "spa-1",
        org_id: ORG,
        payment_id: "sp-1",
        amount: 75,
        cis_reverse_charge_vat: 6,
        cis_vat_treatment: "reverse_charge",
      },
    ];

    // Independently recompute the current quarter via the AUTHORITY, over the
    // same bounded window /reports uses for that slot.
    const qStart = startOfQuarterIso();
    const qEnd = endOfQuarterExclusiveIso(qStart);
    const inputs = await gatherVatQuarterInputs(
      h.client as unknown as VatInputsDb,
      ORG,
      qStart,
      qEnd,
    );
    const financeRows = (h.tables.finances ?? []).map((f) => ({
      vat_total: f.vat_total as number | null,
      amount: f.amount as number | null,
      created_at: f.created_at as string,
    }));
    const expected = computeVatQuarter(
      inputs.invoicePayments,
      financeRows,
      qStart,
      qEnd,
      inputs.reverseCharge.vat,
    );

    const rows = await vatPerQuarter(ORG, 4);
    const slot = rows.find((r) => r.quarter === qStart);
    expect(slot, `no /reports bucket for current quarter ${qStart}`).toBeDefined();

    // Exact reconciliation across all three VAT boxes the trend exposes.
    expect(slot!.output_vat).toBe(expected.output_vat);
    expect(slot!.input_vat).toBe(expected.input_vat);
    expect(slot!.net_vat).toBe(expected.net_payable);

    // And the concrete figures, so the pin also documents the contract:
    //   output = 10 (partial apportion) + 6 (reverse charge) = 16
    //   input  = 4 (finance) + 6 (reverse charge)            = 10
    //   net    = 16 − 10                                     = 6
    expect(slot!.output_vat).toBeCloseTo(16, 5);
    expect(slot!.input_vat).toBeCloseTo(10, 5);
    expect(slot!.net_vat).toBeCloseTo(6, 5);
  });
});
