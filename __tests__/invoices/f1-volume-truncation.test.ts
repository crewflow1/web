import { describe, it, expect } from "vitest";
import { fetchAllRows, PAGE_SIZE } from "@/lib/supabase/paginate";

/**
 * F-1 VOLUME TRAP — hermetic proof that the converted customer / portal /
 * invoice-detail / email reads survive past the 1000-row PostgREST cap.
 *
 * THE BUG. PostgREST clamps EVERY response to the project `max_rows` (1000). A
 * bare `.select()` with no `.range()` is therefore silently truncated the moment
 * a set crosses 1000 rows — an invoice's line items (billed on the PDF/email), a
 * customer's payments (summed into "paid to date"), a portal customer's invoices.
 * No error is raised; the tail simply vanishes.
 *
 * This test stands up a FAITHFUL cap-emulating PostgREST fake (clamps to 1000 on
 * an un-ranged read, honours `.range(from,to)` windows, and enforces the
 * `.eq()`/`.in()` filters + ordering) and drives the REAL `fetchAllRows` helper
 * that every conversion in this fix uses. It first demonstrates the truncation on
 * a bare read (the bug), then proves the paged read is complete (the fix) for the
 * two shapes the fix touches: invoice line items and customer payments. It uses
 * no network, no Supabase client, and no realtime — Node-20 safe.
 */

/** The PostgREST project cap — supabase/config.toml `max_rows`. */
const CLAMP = 1000;

type Row = Record<string, unknown>;

/**
 * A minimal, faithful stand-in for a PostgREST query builder over one in-memory
 * table. Thenable, so `await builder` resolves to `{ data, error }`.
 *
 * Fidelity that matters here:
 *   - `.eq(k,v)` / `.in(k,vs)` filter the row set (proves scoping is preserved);
 *   - `.order(k,{ascending})` sorts, stacking multiple keys (the sort_order + id
 *     tiebreak the fix adds);
 *   - `.range(from,to)` returns just that window;
 *   - a read WITHOUT `.range()` is CLAMPED to the first `CLAMP` rows — exactly
 *     the silent truncation the fix exists to defeat.
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
      // A range window is honoured verbatim (each is < CLAMP by construction).
      return out.slice(from, to + 1);
    }
    // No range → the PostgREST cap bites: the tail past CLAMP silently vanishes.
    return out.slice(0, CLAMP);
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

describe("F-1 fetchAllRows pages past the PostgREST cap", () => {
  it("PAGE_SIZE is strictly below the 1000-row clamp (no page is ever truncated)", () => {
    expect(PAGE_SIZE).toBeGreaterThan(0);
    expect(PAGE_SIZE).toBeLessThan(CLAMP);
  });

  it("a BARE (un-ranged) read is silently clamped to 1000 — the bug the fix removes", async () => {
    const lineItems: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      id: `li-${String(i).padStart(5, "0")}`,
      invoice_id: "inv-1",
      line_total: 10,
      sort_order: i,
    }));
    const supabase = new FakeClient({ invoice_line_items: lineItems });

    // What the pre-fix code did: bare select, no .range().
    const { data } = await supabase
      .from("invoice_line_items")
      .select("id, line_total")
      .eq("invoice_id", "inv-1");
    expect(data).toHaveLength(CLAMP); // rows 1001..2500 vanished, no error
  });
});

describe("invoice line items (PDF / email / bulk / detail) render EVERY row", () => {
  it("reads all 2500 line items of one invoice and totals them completely", async () => {
    const N = 2500;
    const lineItems: Row[] = Array.from({ length: N }, (_, i) => ({
      id: `li-${String(i).padStart(5, "0")}`,
      invoice_id: "inv-1",
      // Interleave sort_order collisions so the id tiebreak is load-bearing.
      sort_order: Math.floor(i / 2),
      line_total: 2,
    }));
    // A decoy invoice's lines must never leak in (scoping preserved).
    lineItems.push({ id: "other-1", invoice_id: "inv-2", sort_order: 0, line_total: 999 });
    const supabase = new FakeClient({ invoice_line_items: lineItems });

    const { data: lines, error } = await fetchAllRows<Row>(
      (from, to) =>
        supabase
          .from("invoice_line_items")
          .select("id, description, qty, unit_price, vat_rate, line_total, sort_order")
          .eq("invoice_id", "inv-1")
          .order("sort_order", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
    );

    expect(error).toBeNull();
    expect(lines).toHaveLength(N); // all of them — not clamped to 1000
    expect(lines.every((l) => l.invoice_id === "inv-1")).toBe(true); // scoped
    const billed = lines.reduce((s, l) => s + Number(l.line_total ?? 0), 0);
    expect(billed).toBe(N * 2); // the tail past 1000 is billed, not dropped

    // Deterministic order: sort_order asc, id asc as tiebreak — strictly
    // non-decreasing, so no page dropped or repeated a row.
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]!;
      const cur = lines[i]!;
      const po = Number(prev.sort_order);
      const co = Number(cur.sort_order);
      expect(po <= co).toBe(true);
      if (po === co) expect(String(prev.id) < String(cur.id)).toBe(true);
    }
  });
});

describe("customer payments sum completely across a >1000-row set", () => {
  it("sums 1600 payments spread over the customer's invoices with no truncation", async () => {
    const invoiceIds = ["inv-a", "inv-b", "inv-c"];
    const payments: Row[] = Array.from({ length: 1600 }, (_, i) => ({
      id: `pay-${String(i).padStart(5, "0")}`,
      invoice_id: invoiceIds[i % invoiceIds.length],
      amount: 5,
    }));
    // A payment on some other customer's invoice must be excluded by the .in().
    payments.push({ id: "pay-foreign", invoice_id: "inv-z", amount: 100000 });
    const supabase = new FakeClient({ invoice_payments: payments });

    const { data: rows, error } = await fetchAllRows<Row>(
      (from, to) =>
        supabase
          .from("invoice_payments")
          .select("id, invoice_id, amount")
          .in("invoice_id", invoiceIds)
          .order("id", { ascending: true })
          .range(from, to),
    );

    expect(error).toBeNull();
    expect(rows).toHaveLength(1600); // every payment, not the first 1000
    const paidToDate = rows.reduce((s, p) => s + Number(p.amount ?? 0), 0);
    expect(paidToDate).toBe(1600 * 5); // complete total; the foreign row excluded
    expect(rows.some((p) => p.invoice_id === "inv-z")).toBe(false);
  });
});
