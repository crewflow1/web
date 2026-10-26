import { describe, it, expect, vi, beforeEach } from "vitest";
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
      // Single-row terminator — used by readOrgSettings (org_settings). An unseeded
      // org_settings table yields null ⇒ the reader returns the cash-basis defaults,
      // so the VAT-trend assertions here stay on the pre-scheme behaviour.
      maybeSingle() {
        const rows = filteredOrdered().slice(0, cap.rows);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
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

// jobsPerWeek + revenuePerMonth moved their aggregation DB-side (A6): they now
// delegate to the org-guarded SECDEF RPCs reports_jobs_per_week /
// reports_revenue_per_month. The behaviours this file formerly proved against the
// chainable table mock — F-1 all-rows paging, C48 window never overflowing on a
// 29/30/31, empty buckets, ex-VAT `amount`, UTC tz-edge bucketing — are now SQL,
// so they are re-proven against real Postgres in
// __tests__/integration/rls/reports-windowed-aggregates-rpc.test.ts. Only the
// still-TypeScript aggregates (vatPerQuarter, topCustomersByRevenue) are exercised
// here.
const { vatPerQuarter, topCustomersByRevenue } = await import(
  "@/lib/reports/aggregates"
);

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

beforeEach(() => {
  h.reset();
});

describe("aggregates page past the 1000-row PostgREST cap (F-1)", () => {
  it("vatPerQuarter sums CASH-BASIS output VAT (invoice_payments ledger) + input VAT (supplier-payment ledger) across full paged reads", async () => {
    // OUTPUT VAT is cash-basis from the invoice_payments LEDGER via the single VAT
    // authority, NOT `invoices.status='paid'`. Seed N payments, EACH £100 against
    // its own £100-total invoice carrying £5 VAT → each apportions 100×(5/100)=£5.
    // INPUT VAT (box 4) is cash-basis too (CF-1) from the supplier_payment
    // allocations LEDGER: seed N supplier payments, each fully settling its own
    // £23-gross bill (net £20 + £3 VAT) → each apportions 23×(3/23)=£3. Distinct
    // parents force BOTH the window reads (>1000) AND the id-keyed `.in(...)`
    // chunking (invoices, bills) to page — if any read truncated, a total falls short.
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
    // The bills (finances rows) — each net £20 + £3 VAT = £23 gross.
    h.tables.finances = Array.from({ length: N }, (_, i) => ({
      id: `fin-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      vat_total: 3,
      amount: 20,
      created_at: daysAgoIso((i % 180) + 1),
    }));
    // The supplier payments that SETTLE those bills (the cash-basis box-4 source).
    h.tables.supplier_payments = Array.from({ length: N }, (_, i) => ({
      id: `sp-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      voided_at: null,
      paid_at: daysAgoIso((i % 180) + 1),
    }));
    h.tables.supplier_payment_allocations = Array.from({ length: N }, (_, i) => ({
      id: `spa-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      payment_id: `sp-${String(i).padStart(6, "0")}`,
      finance_id: `fin-${String(i).padStart(6, "0")}`,
      amount: 23, // full gross settlement → VAT share 23×(3/23)=3
      cis_reverse_charge_vat: 0,
      cis_vat_treatment: null,
    }));
    // A supplier payment in ANOTHER org must never leak into this org's input VAT.
    h.tables.supplier_payments.push({
      id: "sp-other",
      org_id: OTHER_ORG,
      voided_at: null,
      paid_at: daysAgoIso(3),
    });
    h.tables.supplier_payment_allocations.push({
      id: "spa-other",
      org_id: OTHER_ORG,
      payment_id: "sp-other",
      finance_id: "fin-other",
      amount: 999999,
      cis_reverse_charge_vat: 0,
      cis_vat_treatment: null,
    });
    h.tables.finances.push({
      id: "fin-other",
      org_id: OTHER_ORG,
      vat_total: 999999,
      amount: 999999,
      created_at: daysAgoIso(3),
    });

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
    //
    // C73-A fixture basis: the RC notional VAT is now windowed on the BILL's
    // finances.created_at (the same column as boxes 4/7), NOT the payment's
    // paid_at. So the allocation must name its reverse-charge BILL (finance_id →
    // a finances row, vat_total 0, created_at in-window), exactly as production
    // stores it. The old fixture omitted the bill and keyed only off paid_at —
    // that encoded the buggy basis this fix removes.
    h.tables.finances = [
      { id: "fin-rc", org_id: ORG, vat_total: 0, amount: 75, created_at: daysAgoIso(2) },
    ];
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
        finance_id: "fin-rc",
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
  // ── topCustomersByRevenue (R2) ──────────────────────────────────────────────
  // The aggregation moved into the SECURITY DEFINER RPC
  // reports_top_customers_by_revenue: the former all-time whole-invoices +
  // whole-customers fetch + TypeScript group/sum/slice is gone, so the F-1
  // 1000-row cap no longer applies to this function and there is nothing to page
  // here. The resolution rule (customer_id → quote fallback → Unattributed), the
  // ex-VAT sum and the Σ(revenue)=paid-total reconciliation are now proven
  // against REAL Postgres in
  // __tests__/integration/rls/reports-top-customers-rpc.test.ts (the correct
  // tier for SQL). These unit cases pin the thin TS wrapper: it must call the RPC
  // with the active org + limit and map every returned row — including the null →
  // Unattributed bucket — faithfully, and fail loud on error.
  function rpcStub(rows: Array<Record<string, unknown>> | null, error: unknown = null) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db = {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return Promise.resolve({ data: rows, error });
      },
    } as unknown as Parameters<typeof topCustomersByRevenue>[2];
    return { db, calls };
  }

  it("topCustomersByRevenue delegates to the org-guarded RPC with the org + limit", async () => {
    const { db, calls } = rpcStub([]);
    const out = await topCustomersByRevenue(ORG, 7, db);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("reports_top_customers_by_revenue");
    expect(calls[0]!.args).toEqual({ p_org_id: ORG, p_limit: 7 });
  });

  it("topCustomersByRevenue maps RPC rows to the TopCustomer shape (Number-coerced)", async () => {
    // PostgREST can hand back a bigint count / numeric revenue as a string; the
    // wrapper must coerce so the renderer always sees numbers.
    const { db } = rpcStub([
      { customer_id: "cust-A", name: "Alpha", revenue: 150, invoice_count: 2 },
      { customer_id: "cust-B", name: "Beta", revenue: "30", invoice_count: "1" },
    ]);
    const rows = await topCustomersByRevenue(ORG, 10, db);
    expect(rows).toEqual([
      { id: "cust-A", name: "Alpha", revenue: 150, invoice_count: 2 },
      { id: "cust-B", name: "Beta", revenue: 30, invoice_count: 1 },
    ]);
  });

  it("topCustomersByRevenue maps a null customer_id to the Unattributed sentinel + label", async () => {
    // The RPC returns the Unattributed bucket as customer_id = null; the wrapper
    // owns the sentinel id + the human label (unchanged from before the move).
    const { db } = rpcStub([
      { customer_id: null, name: "—", revenue: 10, invoice_count: 2 },
    ]);
    const [row] = await topCustomersByRevenue(ORG, 10, db);
    expect(row).toEqual({
      id: "__unattributed__",
      name: "Unattributed",
      revenue: 10,
      invoice_count: 2,
    });
  });

  it("topCustomersByRevenue fails LOUD when the RPC errors — never a silent empty ranking", async () => {
    const { db } = rpcStub(null, { message: "boom" });
    await expect(topCustomersByRevenue(ORG, 10, db)).rejects.toThrow();
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
describe("reports revenue is EX-VAT (amount), not gross (total)", () => {
  // revenuePerMonth's EX-VAT behaviour + window-overflow (C48) + F-1 all-rows
  // guarantees moved DB-side in A6; they are re-proven against real Postgres in
  // __tests__/integration/rls/reports-windowed-aggregates-rpc.test.ts. The
  // topCustomersByRevenue path remains TypeScript and is pinned here.
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

  it("SOURCE GUARD: topCustomersByRevenue sums `amount` and never gross `total`", () => {
    // revenuePerMonth's ex-VAT rule moved into SQL (A6) — it is pinned by the
    // migration + integration test (the RPC sums invoices.amount, not total). The
    // still-TypeScript topCustomersByRevenue path keeps a static source guard.
    const src = readFileSync(
      resolve(process.cwd(), "lib/reports/aggregates.ts"),
      "utf8",
    );

    // Isolate topCustomersByRevenue() to end-of-file.
    const tcStart = src.indexOf("export async function topCustomersByRevenue");
    expect(tcStart).toBeGreaterThan(-1);
    const tc = src.slice(tcStart);
    expect(tc).toMatch(/\.rpc\(\s*["']reports_top_customers_by_revenue["']/);
    expect(tc).not.toMatch(/Number\(\s*inv\.total\b/);
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
      // C73-A: the reverse-charge BILL is itself a finances row (vat_total 0), and
      // its created_at is the tax point the RC notional VAT is now windowed on —
      // the same column as boxes 4/7. The allocation names it via finance_id.
      {
        id: "fin-rc",
        org_id: ORG,
        vat_total: 0,
        amount: 75,
        created_at: daysAgoIso(2),
      },
    ];
    h.tables.supplier_payments = [
      { id: "sp-1", org_id: ORG, voided_at: null, paid_at: daysAgoIso(2) },
      // CF-1: fin-1 (a normal purchase) is actually PAID this quarter, so under the
      // cash scheme its £4 input VAT is reclaimable — 24 gross × (4/24) = £4.
      { id: "sp-2", org_id: ORG, voided_at: null, paid_at: daysAgoIso(2) },
    ];
    h.tables.supplier_payment_allocations = [
      {
        id: "spa-1",
        org_id: ORG,
        payment_id: "sp-1",
        finance_id: "fin-rc",
        amount: 75,
        cis_reverse_charge_vat: 6,
        cis_vat_treatment: "reverse_charge",
      },
      {
        id: "spa-2",
        org_id: ORG,
        payment_id: "sp-2",
        finance_id: "fin-1",
        amount: 24, // full gross settlement of fin-1 (net 20 + VAT 4)
        cis_reverse_charge_vat: 0,
        cis_vat_treatment: null,
      },
    ];

    // Independently recompute the current quarter via the AUTHORITY, over the
    // same bounded window /reports uses for that slot — using the SAME cash-basis
    // inputs vatPerQuarter feeds it (CF-1: supplier-payment ledger + RC net), so any
    // re-divergence between /reports and the authority fails CI.
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
      {
        supplierPayments: inputs.supplierPayments,
        reverseChargeNet: inputs.reverseCharge.net,
      },
    );

    const rows = await vatPerQuarter(ORG, 4);
    const slot = rows.find((r) => r.quarter === qStart);
    expect(slot, `no /reports bucket for current quarter ${qStart}`).toBeDefined();

    // Exact reconciliation across all three VAT boxes the trend exposes.
    expect(slot!.output_vat).toBe(expected.output_vat);
    expect(slot!.input_vat).toBe(expected.input_vat);
    expect(slot!.net_vat).toBe(expected.net_payable);

    // And the concrete figures, so the pin also documents the contract:
    //   output = 10 (partial apportion) + 6 (reverse charge)     = 16
    //   input  = 4 (fin-1 cash-paid, box 4) + 6 (reverse charge) = 10
    //   net    = 16 − 10                                         = 6
    expect(slot!.output_vat).toBeCloseTo(16, 5);
    expect(slot!.input_vat).toBeCloseTo(10, 5);
    expect(slot!.net_vat).toBeCloseTo(6, 5);
  });
});
