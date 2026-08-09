import { describe, it, expect } from "vitest";

/**
 * REGRESSION — the /invoices?customer=<id> list (and its exact count) must
 * include QUOTE-LESS stage/progress-billing invoices.
 *
 * THE BUG (C52, sibling of the C51 rollup fix). The main-app invoices list
 * (app/(app)/invoices/page.tsx) built the customer-filtered query with
 * `quote:quotes!inner ( customer_id )` and filtered `.eq("quote.customer_id", id)`.
 * PostgREST's `!inner` join requires a matching `quotes` row, so ANY invoice with
 * quote_id = NULL is EXCLUDED from both the row list AND the `count: 'exact'`
 * headline. But the LIVE manager-gated stage/progress-billing path
 * (`generate_stage_invoice`, migration 20261039000000) inserts invoices with
 * quote_id = NULL and customer_id set from the job. So a customer on stage
 * billing had EVERY stage invoice silently missing from the filtered list and
 * undercounted in the "N invoices" headline — while the customer-detail card
 * (anchored on invoices.customer_id) DID count them. The "View all" link from
 * the detail card landed here and disagreed with the card it came from.
 *
 * THE FIX. Filter directly on the durable `invoices.customer_id`
 * (migration 20260915000000, composite FK (customer_id, org_id) -> customers),
 * exactly as lib/customers/financials.ts and the customer portal list do.
 *
 * This suite drives ONE fixture through a faithful mini-PostgREST that honours
 * `!inner` embed drop semantics and `count: 'exact'`:
 *   - `preFixCustomerList` replicates the shipped-buggy read (quotes!inner +
 *     quote.customer_id) and shows the stage invoice dropped + undercounted (RED).
 *   - `fixedCustomerList` filters on invoices.customer_id and counts it (GREEN).
 */

const CUSTOMER_ID = "cust-1";

type Invoice = {
  id: string;
  number: string;
  status: string;
  total: number;
  quote_id: string | null;
  customer_id: string | null;
  org_id: string;
  created_at: string;
};
type Quote = { id: string; customer_id: string | null; org_id: string };

const ORG = "org-1";

/**
 * The customer's invoices: one quote-derived AND one quote-less stage invoice
 * (quote_id NULL, customer_id set — exactly what generate_stage_invoice writes).
 */
function buildFixture() {
  const quotes: Quote[] = [
    { id: "q1", customer_id: CUSTOMER_ID, org_id: ORG },
  ];
  const invoices: Invoice[] = [
    {
      id: "inv-quote",
      number: "INV-001",
      status: "paid",
      total: 1000,
      quote_id: "q1",
      customer_id: CUSTOMER_ID,
      org_id: ORG,
      created_at: "2026-01-02",
    },
    {
      // Stage / progress-billing invoice — the one the pre-fix read dropped.
      id: "inv-stage",
      number: "INV-002",
      status: "sent",
      total: 500,
      quote_id: null,
      customer_id: CUSTOMER_ID,
      org_id: ORG,
      created_at: "2026-02-02",
    },
  ];
  return { quotes, invoices };
}

type Result = { rows: Invoice[]; count: number };

/**
 * Faithful mini-PostgREST for the two query shapes this page uses.
 * `join` = "quotes!inner" reproduces the drop: an invoice with no matching
 * quotes row is removed BEFORE filtering/counting, matching PostgREST. `count`
 * is 'exact' over the filtered set (what drives the "N invoices" headline and
 * pagination). `.range(from,to)` windows the returned rows but NOT the count.
 */
function runQuery(
  db: { invoices: Invoice[]; quotes: Quote[] },
  opts: {
    join: "quotes!inner" | null;
    orgId: string;
    filter:
      | { on: "quote.customer_id"; value: string }
      | { on: "customer_id"; value: string };
    range?: [number, number];
  },
): Result {
  let rows = db.invoices.filter((i) => i.org_id === opts.orgId);

  // !inner embed: drop invoices with no matching quotes row.
  if (opts.join === "quotes!inner") {
    rows = rows.filter((i) => db.quotes.some((q) => q.id === i.quote_id));
  }

  rows = rows.filter((i) => {
    if (opts.filter.on === "customer_id") {
      return i.customer_id === opts.filter.value;
    }
    // quote.customer_id: resolve through the embedded quote.
    const q = db.quotes.find((qq) => qq.id === i.quote_id) ?? null;
    return q?.customer_id === opts.filter.value;
  });

  rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const count = rows.length; // count: 'exact' over the filtered set
  const windowed = opts.range
    ? rows.slice(opts.range[0], opts.range[1] + 1)
    : rows;
  return { rows: windowed, count };
}

/** Shipped-buggy read: quotes!inner join + quote.customer_id filter. */
function preFixCustomerList(
  db: { invoices: Invoice[]; quotes: Quote[] },
  customerId: string,
): Result {
  return runQuery(db, {
    join: "quotes!inner",
    orgId: ORG,
    filter: { on: "quote.customer_id", value: customerId },
    range: [0, 49],
  });
}

/** Fixed read: filter directly on the durable invoices.customer_id. */
function fixedCustomerList(
  db: { invoices: Invoice[]; quotes: Quote[] },
  customerId: string,
): Result {
  return runQuery(db, {
    join: null,
    orgId: ORG,
    filter: { on: "customer_id", value: customerId },
    range: [0, 49],
  });
}

describe("/invoices?customer= — the pre-fix quotes!inner bug (RED)", () => {
  it("DROPS the quote-less stage invoice from the list AND the exact count", () => {
    const db = buildFixture();

    const res = preFixCustomerList(db, CUSTOMER_ID);

    // Only the quote-derived invoice survives the !inner join.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.id).toBe("inv-quote");
    // The stage invoice is silently absent from the list...
    expect(res.rows.some((i) => i.id === "inv-stage")).toBe(false);
    // ...and from the "N invoices" headline count. The money is under-reported.
    expect(res.count).toBe(1);
  });
});

describe("/invoices?customer= — the fix (invoices.customer_id) (GREEN)", () => {
  it("INCLUDES the quote-less stage invoice in the list AND the exact count", () => {
    const db = buildFixture();

    const res = fixedCustomerList(db, CUSTOMER_ID);

    // Both invoices appear — the stage invoice is no longer dropped.
    expect(res.rows).toHaveLength(2);
    expect(res.rows.some((i) => i.id === "inv-stage")).toBe(true);
    expect(res.rows.some((i) => i.id === "inv-quote")).toBe(true);
    // And the headline count agrees with the list (and with the detail card).
    expect(res.count).toBe(2);
  });

  it("stays strictly scoped to the customer (no cross-customer leak)", () => {
    const db = buildFixture();
    db.invoices.push({
      id: "inv-foreign",
      number: "INV-999",
      status: "paid",
      total: 99999,
      quote_id: null,
      customer_id: "cust-OTHER",
      org_id: ORG,
      created_at: "2026-03-01",
    });

    const res = fixedCustomerList(db, CUSTOMER_ID);

    expect(res.rows.some((i) => i.id === "inv-foreign")).toBe(false);
    expect(res.count).toBe(2);
  });
});
