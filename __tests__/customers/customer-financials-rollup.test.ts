import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { loadCustomerFinancials } from "@/lib/customers/financials";

/**
 * REGRESSION — customer financial rollups must count QUOTE-LESS invoices.
 *
 * THE BUG. The customer detail page gathered a customer's invoices by walking
 * quote -> invoice (`.in("quote_id", quoteIds)`, gated on `quoteIds.length > 0`).
 * But the LIVE manager-gated stage/progress-billing path
 * (`generate_stage_invoice`, migration 20261039000000) inserts invoices with
 * `quote_id = NULL` and `customer_id` set from the job. Those invoices have no
 * quote to join through, so a customer on stage billing had EVERY stage invoice
 * silently omitted from Total invoiced / Paid / Outstanding / Lifetime revenue.
 *
 * THE FIX. `loadCustomerFinancials` anchors on the durable `invoices.customer_id`
 * (migration 20260915000000), so a quote-less invoice is counted.
 *
 * This suite proves BOTH halves against ONE fixture:
 *   - `legacyQuoteJoinRead` replicates the exact pre-fix read and shows the
 *     stage invoice is dropped and the money under-reported (RED behaviour).
 *   - `loadCustomerFinancials` (the real, shipped helper) counts it (GREEN).
 * Point the "counts the stage invoice" assertion at `legacyQuoteJoinRead` and it
 * FAILS; at `loadCustomerFinancials` it PASSES — the red->green the fix removes.
 */

const CUSTOMER_ID = "cust-1";

type Row = Record<string, unknown>;

/**
 * Faithful, minimal PostgREST query builder over one in-memory table.
 * Thenable so `await builder` resolves to `{ data, error }`. Honours
 * `.eq` / `.in` filters, stacked `.order`, and `.range(from,to)` windows —
 * enough to drive the real `fetchAllRows` the helper uses.
 */
class FakeQuery<T extends Row> implements PromiseLike<{ data: T[] | null; error: unknown }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private orders: Array<[string, boolean]> = [];
  private rangeWindow: [number, number] | null = null;

  constructor(private readonly rows: T[]) {}

  select(_cols: string): this {
    return this;
  }
  eq(key: string, value: unknown): this {
    this.eqs.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]): this {
    this.ins.push([key, values]);
    return this;
  }
  order(key: string, opts: { ascending: boolean }): this {
    this.orders.push([key, opts.ascending]);
    return this;
  }
  range(from: number, to: number): this {
    this.rangeWindow = [from, to];
    return this;
  }

  private resolveRows(): T[] {
    let out = this.rows.filter(
      (r) =>
        this.eqs.every(([k, v]) => r[k] === v) &&
        this.ins.every(([k, vs]) => vs.includes(r[k])),
    );
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const [k, asc] = this.orders[i]!;
      out = [...out].sort((a, b) => {
        const av = a[k] as number | string;
        const bv = b[k] as number | string;
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.rangeWindow) {
      const [from, to] = this.rangeWindow;
      return out.slice(from, to + 1);
    }
    return out;
  }

  then<TResult1 = { data: T[] | null; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: T[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.resolveRows(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

class FakeClient {
  constructor(private readonly tables: Record<string, Row[]>) {}
  from<T extends Row>(table: string): FakeQuery<T> {
    return new FakeQuery<T>((this.tables[table] ?? []) as T[]);
  }
}

/**
 * The customer's data: one quote-derived invoice AND one quote-less stage
 * invoice, each with a payment. The stage invoice is the one the pre-fix read
 * dropped.
 */
function buildFixture() {
  const quotes: Row[] = [
    { id: "q1", customer_id: CUSTOMER_ID, created_at: "2026-01-01" },
  ];
  const invoices: Row[] = [
    // Quote-derived invoice — the pre-fix read found this one.
    {
      id: "inv-quote",
      number: "INV-001",
      status: "paid",
      total: 1000,
      due_date: "2026-01-15",
      paid_at: "2026-01-10",
      created_at: "2026-01-02",
      quote_id: "q1",
      customer_id: CUSTOMER_ID,
    },
    // Stage / progress-billing invoice — quote_id NULL, customer_id set
    // (exactly what generate_stage_invoice inserts). Pre-fix read MISSED this.
    {
      id: "inv-stage",
      number: "INV-002",
      status: "paid",
      total: 500,
      due_date: "2026-02-15",
      paid_at: "2026-02-10",
      created_at: "2026-02-02",
      quote_id: null,
      customer_id: CUSTOMER_ID,
    },
  ];
  const invoice_payments: Row[] = [
    { id: "pay-quote", invoice_id: "inv-quote", amount: 1000, paid_at: "2026-01-10", reference: "BACS-1" },
    { id: "pay-stage", invoice_id: "inv-stage", amount: 300, paid_at: "2026-02-10", reference: "BACS-2" },
  ];
  return { quotes, invoices, invoice_payments };
}

/**
 * Faithful replica of the PRE-FIX read: quotes -> quoteIds -> invoices keyed
 * ONLY on `.in("quote_id", quoteIds)`, gated on quoteIds.length. Returns the
 * same totals the old page computed. This is the buggy path, kept to prove the
 * omission is real and to serve as the RED subject.
 */
async function legacyQuoteJoinRead(client: FakeClient, customerId: string) {
  const { data: quotes } = await client
    .from<Row>("quotes")
    .select("id")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(0, 499);
  const quoteIds = (quotes ?? []).map((q) => q.id as string);
  let invoiceRows: Row[] = [];
  let paymentRows: Row[] = [];
  if (quoteIds.length > 0) {
    const { data: invs } = await client
      .from<Row>("invoices")
      .select("id, number, status, total")
      .in("quote_id", quoteIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(0, 499);
    invoiceRows = invs ?? [];
    if (invoiceRows.length > 0) {
      const { data: pays } = await client
        .from<Row>("invoice_payments")
        .select("id, invoice_id, amount")
        .in(
          "invoice_id",
          invoiceRows.map((i) => i.id),
        )
        .order("id", { ascending: true })
        .range(0, 499);
      paymentRows = pays ?? [];
    }
  }
  const totalInvoiced = invoiceRows.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const totalPaid = paymentRows.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  return { invoiceRows, paymentRows, totalInvoiced, totalPaid };
}

describe("customer financial rollup — the pre-fix quote-join bug", () => {
  it("legacy quote-join read DROPS the quote-less stage invoice (under-reports)", async () => {
    const { quotes, invoices, invoice_payments } = buildFixture();
    const client = new FakeClient({ quotes, invoices, invoice_payments });

    const legacy = await legacyQuoteJoinRead(client, CUSTOMER_ID);

    // Only the quote-derived invoice + its payment are seen.
    expect(legacy.invoiceRows).toHaveLength(1);
    expect(legacy.invoiceRows[0]!.id).toBe("inv-quote");
    expect(legacy.totalInvoiced).toBe(1000); // stage £500 missing
    expect(legacy.totalPaid).toBe(1000); // stage £300 missing
    // The stage invoice is silently absent — the money bug.
    expect(legacy.invoiceRows.some((i) => i.id === "inv-stage")).toBe(false);
  });
});

describe("customer financial rollup — the fix (loadCustomerFinancials)", () => {
  it("COUNTS the quote-less stage invoice in every money tile", async () => {
    const { quotes, invoices, invoice_payments } = buildFixture();
    const client = new FakeClient({ quotes, invoices, invoice_payments });

    const f = await loadCustomerFinancials(
      client as unknown as SupabaseClient<Database>,
      CUSTOMER_ID,
    );

    // Both invoices are present — the stage invoice is no longer dropped.
    expect(f.invoiceRows).toHaveLength(2);
    expect(f.invoiceRows.some((i) => i.id === "inv-stage")).toBe(true);

    // Totals INCLUDE the stage invoice (would be 1000 / 1000 / 0 / 1000 pre-fix).
    expect(f.totalInvoiced).toBe(1500); // 1000 + 500
    expect(f.totalPaid).toBe(1300); // 1000 + 300
    expect(f.outstanding).toBe(200); // 1500 - 1300
    expect(f.lifetimeRevenue).toBe(1500); // both invoices are 'paid'
    expect(f.paymentRows).toHaveLength(2);
  });

  it("scopes strictly to the customer and excludes other customers' invoices", async () => {
    const { quotes, invoices, invoice_payments } = buildFixture();
    invoices.push({
      id: "inv-foreign",
      number: "INV-999",
      status: "paid",
      total: 99999,
      due_date: null,
      paid_at: "2026-03-01",
      created_at: "2026-03-01",
      quote_id: null,
      customer_id: "cust-OTHER",
    });
    const client = new FakeClient({ quotes, invoices, invoice_payments });

    const f = await loadCustomerFinancials(
      client as unknown as SupabaseClient<Database>,
      CUSTOMER_ID,
    );

    expect(f.invoiceRows.some((i) => i.id === "inv-foreign")).toBe(false);
    expect(f.totalInvoiced).toBe(1500); // foreign 99999 not leaked in
  });

  it("handles a customer with no invoices (no payment read, zero totals)", async () => {
    const client = new FakeClient({ quotes: [], invoices: [], invoice_payments: [] });
    const f = await loadCustomerFinancials(
      client as unknown as SupabaseClient<Database>,
      CUSTOMER_ID,
    );
    expect(f.invoiceRows).toHaveLength(0);
    expect(f.paymentRows).toHaveLength(0);
    expect(f.totalInvoiced).toBe(0);
    expect(f.totalPaid).toBe(0);
    expect(f.outstanding).toBe(0);
    expect(f.lifetimeRevenue).toBe(0);
  });
});
