import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * H2-CIS service reads — no silent 1000-row truncation (F-1).
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * Supabase/PostgREST caps every response at the project "Max rows" setting
 * (1000). A bare `.select()` with no `.range()` is SILENTLY TRUNCATED the moment
 * an org crosses that many matching rows. In the CIS domain that is a tax bug:
 *   - `listMonthSnapshots` feeds every statement + monthly-return TOTAL, so a
 *     truncated read under-reports a busy contractor's gross/deduction.
 *   - its `supplier_payments` void-join, once the snapshot read is paged, must
 *     itself see every payment or a voided payment sneaks back into the return.
 *   - `listStatements` / `listReturnLines` are the statement set and the return
 *     BODY; a truncated read files/exports an incomplete return.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL, NOT A SOURCE GREP ──────────────────────────
 * The reads run against a chainable Supabase mock that honours `.range(from, to)`
 * exactly the way PostgREST does — an inclusive window itself capped at 1000 rows
 * per response. Each entity is seeded with MORE than 1000 rows. If any read
 * dropped its `.range()` (or fetched a single page), the mock would clip at 1000
 * and the asserted totals/counts would come up short. Only a correctly paged read
 * can see every row.
 *
 * ── HERMETIC ─────────────────────────────────────────────────────────────────
 * No real Supabase client is constructed (Node-20 CI has no native WebSocket, so
 * a realtime client would throw). `createClient` is mocked to a pure in-memory
 * fake, and `server-only` is stubbed.
 */

// The real PostgREST max-rows cap the mock emulates.
const RESPONSE_CAP = 1000;

const h = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const cap = { rows: 1000 };
  // Table names whose reads should return a hard error (loud-read tests).
  const failTables = new Set<string>();

  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, Set<unknown>]> = [];
    const orders: Array<[string, boolean]> = [];

    const settle = (from: number, to: number) => {
      if (failTables.has(table)) {
        return Promise.resolve({ data: null, error: { message: `boom:${table}` } });
      }
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [col, val] of eqs) if (row[col] !== val) return false;
        for (const [col, set] of ins) if (!set.has(row[col])) return false;
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      // PostgREST semantics: inclusive [from, to], HARD capped at RESPONSE_CAP.
      const windowed = rows.slice(from, to + 1).slice(0, cap.rows);
      return Promise.resolve({ data: windowed, error: null });
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        ins.push([col, new Set(vals)]);
        return builder;
      },
      is(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push([col, opts?.ascending !== false]);
        return builder;
      },
      limit() {
        return builder;
      },
      range(from: number, to: number) {
        return settle(from, to);
      },
      // Terminal await for a chain that ends without `.range()` — the
      // supplier_payments void-join is `select().eq().in()` then awaited.
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return settle(0, cap.rows - 1).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    tables,
    cap,
    failTables,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      cap.rows = RESPONSE_CAP;
      failTables.clear();
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));
vi.mock("server-only", () => ({}));

const { liveReturnDataset, listMonthSnapshots, listStatements, listReturnLines } =
  await import("@/server/services/cis-statements");

const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";
const TAX_MONTH_END = "2026-08-05"; // 6 Jul – 5 Aug 2026
const TAX_MONTH_START = "2026-07-06";

function snapshotRow(i: number, over: Record<string, unknown> = {}) {
  const pid = `p-${String(i).padStart(6, "0")}`;
  return {
    org_id: ORG,
    payment_id: pid,
    supplier_id: `sup-${String(i).padStart(6, "0")}`,
    cis_status: "standard_20",
    deduction_rate: 20,
    verification_reference: null,
    legal_name: `Groundworks ${i} Ltd`,
    utr_masked: "••••••7890",
    cis_gross_payment: 10,
    materials_total: 1,
    citb_total: 0,
    cis_basis: 9,
    cis_deduction: 2,
    tax_month_start: TAX_MONTH_START,
    tax_month_end: TAX_MONTH_END,
    ...over,
  };
}

function paymentRow(i: number, voided = false) {
  const pid = `p-${String(i).padStart(6, "0")}`;
  return {
    org_id: ORG,
    id: pid,
    paid_at: "2026-07-10",
    voided_at: voided ? "2026-07-25T00:00:00Z" : null,
  };
}

beforeEach(() => {
  h.reset();
});

// ---------------------------------------------------------------------------
// listMonthSnapshots + liveReturnDataset
// ---------------------------------------------------------------------------

describe("listMonthSnapshots / liveReturnDataset page past the 1000-row cap (F-1)", () => {
  it("aggregates EVERY snapshot in a >1000-payment month, not just the first 1000", async () => {
    const N = 1200;
    h.tables.cis_payment_snapshots = Array.from({ length: N }, (_, i) => snapshotRow(i));
    h.tables.supplier_payments = Array.from({ length: N }, (_, i) => paymentRow(i));

    // Rows the read must NOT include: another org, and a different tax month.
    h.tables.cis_payment_snapshots.push(
      snapshotRow(9001, { org_id: OTHER_ORG, cis_gross_payment: 999999 }),
      snapshotRow(9002, { tax_month_end: "2026-07-05", tax_month_start: "2026-06-06", cis_gross_payment: 999999 }),
    );
    h.tables.supplier_payments.push(paymentRow(9001), paymentRow(9002));

    const ds = await liveReturnDataset(ORG, TAX_MONTH_END);
    // 1000-row truncation would show 1000 payments / £10,000; full paging is 1200.
    expect(ds.paymentCount).toBe(N);
    expect(ds.subcontractorCount).toBe(N);
    expect(ds.totalGross).toBe(N * 10);
    expect(ds.totalDeduction).toBe(N * 2);
    expect(ds.isNil).toBe(false);
  });

  it("keeps the void-join complete so a voided payment past row 1000 stays excluded", async () => {
    const N = 1200;
    // Void the LAST 200 payments (payment_id order): an un-chunked `.in(1200 ids)`
    // capped at 1000 would miss these payment rows, default their voided_at to
    // null and WRONGLY re-include them. Chunked, they are found and excluded.
    h.tables.cis_payment_snapshots = Array.from({ length: N }, (_, i) => snapshotRow(i));
    h.tables.supplier_payments = Array.from({ length: N }, (_, i) => paymentRow(i, i >= 1000));

    const ds = await liveReturnDataset(ORG, TAX_MONTH_END);
    expect(ds.paymentCount).toBe(1000);
    expect(ds.totalGross).toBe(1000 * 10);
  });

  it("pins to the active org — another org's snapshots never leak in", async () => {
    h.tables.cis_payment_snapshots = [
      snapshotRow(1),
      snapshotRow(2, { org_id: OTHER_ORG }),
    ];
    h.tables.supplier_payments = [paymentRow(1), paymentRow(2)];

    const rows = await listMonthSnapshots(ORG, TAX_MONTH_END);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payment_id).toBe("p-000001");
  });

  it("is LOUD — a failed snapshot read throws, never a silent NIL return", async () => {
    h.failTables.add("cis_payment_snapshots");
    await expect(liveReturnDataset(ORG, TAX_MONTH_END)).rejects.toThrow(/month payment snapshots/i);
  });

  it("is LOUD — a failed void-join throws rather than including voided payments", async () => {
    h.tables.cis_payment_snapshots = [snapshotRow(1)];
    h.failTables.add("supplier_payments");
    await expect(listMonthSnapshots(ORG, TAX_MONTH_END)).rejects.toThrow(/snapshot payments join/i);
  });
});

// ---------------------------------------------------------------------------
// listStatements
// ---------------------------------------------------------------------------

describe("listStatements pages past the 1000-row cap (F-1)", () => {
  it("returns EVERY statement for the org, not just the first 1000", async () => {
    const N = 1200;
    h.tables.cis_statements = Array.from({ length: N }, (_, i) => ({
      id: `st-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      supplier_id: `sup-${i}`,
      statement_number: `SN-${String(i).padStart(6, "0")}`,
      tax_month_end: TAX_MONTH_END,
    }));
    // Another org's statements must never be blended in.
    h.tables.cis_statements.push({
      id: "st-other",
      org_id: OTHER_ORG,
      supplier_id: "sup-x",
      statement_number: "SN-999999",
      tax_month_end: TAX_MONTH_END,
    });

    const rows = await listStatements(ORG);
    expect(rows).toHaveLength(N);
    expect(rows.every((r) => r.org_id === ORG)).toBe(true);
  });

  it("is LOUD — a failed read throws rather than returning a short list", async () => {
    h.failTables.add("cis_statements");
    await expect(listStatements(ORG)).rejects.toThrow(/statements list/i);
  });
});

// ---------------------------------------------------------------------------
// listReturnLines
// ---------------------------------------------------------------------------

describe("listReturnLines pages past the 1000-row cap (F-1)", () => {
  it("returns EVERY line of a >1000-subcontractor return", async () => {
    const N = 1200;
    const RETURN_ID = "ret-1";
    h.tables.cis_monthly_return_lines = Array.from({ length: N }, (_, i) => ({
      id: `ln-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      return_id: RETURN_ID,
      supplier_id: `sup-${String(i).padStart(6, "0")}`,
      subcontractor_name: `Sub ${i}`,
      gross_amount: 10,
      deduction_amount: 2,
      payment_count: 1,
    }));
    // Lines of a DIFFERENT return for the same org must be excluded.
    h.tables.cis_monthly_return_lines.push({
      id: "ln-other",
      org_id: ORG,
      return_id: "ret-2",
      supplier_id: "sup-x",
      subcontractor_name: "Elsewhere",
      gross_amount: 999999,
      deduction_amount: 0,
      payment_count: 1,
    });

    const rows = await listReturnLines(ORG, RETURN_ID);
    expect(rows).toHaveLength(N);
  });

  it("is LOUD — a failed read throws rather than an incomplete return body", async () => {
    h.failTables.add("cis_monthly_return_lines");
    await expect(listReturnLines(ORG, "ret-1")).rejects.toThrow(/return lines/i);
  });
});
