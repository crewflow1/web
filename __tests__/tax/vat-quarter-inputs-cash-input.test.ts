import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  computeVatNetTotals,
  type FinanceRow,
} from "@/lib/tax/compute";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";

/**
 * CF-1 WIRED PROOF — the fix must be active on the REAL gathered path, not just in
 * the pure function. This drives `gatherVatQuarterInputs` (the read layer every VAT
 * surface uses) against a seeded in-memory PostgREST double, then feeds the result
 * into `computeVatQuarter` / `computeVatNetTotals` EXACTLY as the tax page, the
 * quarterly PDF, /reports and the frozen HMRC 9-box return do — so it proves box 4
 * (and box 7) become payment-based end to end for a cash-scheme org.
 */

// A minimal in-memory PostgREST double honouring the exact predicates the read
// layer uses (eq/gte/lt/is/in/order/range/thenable), filtering + paging a seeded
// table set — the same shape as __tests__/tax/compute.test.ts.
function makeDb(tables: Record<string, Array<Record<string, unknown>>>): VatInputsDb {
  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const gtes: Array<[string, unknown]> = [];
    const lts: Array<[string, unknown]> = [];
    const iss: Array<[string, unknown]> = [];
    const ins: Array<[string, readonly unknown[]]> = [];
    const orders: Array<[string, boolean]> = [];

    const filteredOrdered = () => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [c, v] of eqs) if (row[c] !== v) return false;
        for (const [c, v] of gtes) {
          if (row[c] == null) return false;
          if (String(row[c]) < String(v)) return false;
        }
        for (const [c, v] of lts) {
          if (row[c] == null) return false;
          if (String(row[c]) >= String(v)) return false;
        }
        for (const [c, v] of iss) if ((row[c] ?? null) !== v) return false;
        for (const [c, list] of ins) if (!list.includes(row[c])) return false;
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [c, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[c] as string | number;
          const bv = b[c] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return rows;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => (eqs.push([c, v]), builder),
      gte: (c: string, v: unknown) => (gtes.push([c, v]), builder),
      lt: (c: string, v: unknown) => (lts.push([c, v]), builder),
      is: (c: string, v: unknown) => (iss.push([c, v]), builder),
      in: (c: string, list: readonly unknown[]) => (ins.push([c, list]), builder),
      order: (c: string, o?: { ascending?: boolean }) =>
        (orders.push([c, o?.ascending !== false]), builder),
      range: (from: number, to: number) =>
        Promise.resolve({ data: filteredOrdered().slice(from, to + 1), error: null }),
      then: (onF: (v: { data: unknown[]; error: null }) => unknown) =>
        onF({ data: filteredOrdered(), error: null }),
    };
    return builder;
  }
  return { from: (t: string) => makeBuilder(t) } as unknown as VatInputsDb;
}

const ORG = "org-1";
const Q_START = "2026-04-01";
const Q_END = "2026-07-01"; // exclusive
const IN_Q1 = "2026-05-10T09:00:00.000Z";

// A normal (non reverse-charge) purchase bill: net £100 + £20 VAT = £120 gross,
// logged (tax point) in Q1.
const bill = (id: string, created: string) => ({
  id,
  org_id: ORG,
  vat_total: 20,
  amount: 100,
  created_at: created,
});
const financeRowsFor = (tbls: Record<string, Array<Record<string, unknown>>>): FinanceRow[] =>
  (tbls.finances ?? []).map((f) => ({
    vat_total: f.vat_total as number,
    amount: f.amount as number,
    created_at: f.created_at as string,
  }));

/** Run the REAL wired path exactly as a cash-scheme caller does. */
async function wiredVat(
  tables: Record<string, Array<Record<string, unknown>>>,
  scheme: "cash" | "standard" = "cash",
) {
  const inputs = await gatherVatQuarterInputs(makeDb(tables), ORG, Q_START, Q_END, scheme);
  const finances = financeRowsFor(tables);
  const opts = {
    scheme,
    accrualInvoices: inputs.accrualInvoices,
    supplierPayments: inputs.supplierPayments,
    reverseChargeNet: inputs.reverseCharge.net,
  };
  const vat = computeVatQuarter(
    inputs.invoicePayments,
    finances,
    Q_START,
    Q_END,
    inputs.reverseCharge.vat,
    opts,
  );
  const net = computeVatNetTotals(inputs.invoicePayments, finances, Q_START, Q_END, opts);
  return { inputs, vat, net };
}

describe("CF-1 wired path — cash-scheme box 4 is gated on supplier PAYMENT", () => {
  it("UNPAID purchase bill in-window ⇒ box 4 = £0 through the REAL gathered path", async () => {
    // The bill is logged in Q1 but never paid (no supplier_payments row).
    const tables = { finances: [bill("fin-1", IN_Q1)] };
    const { inputs, vat } = await wiredVat(tables);
    // The gather returned an empty (not undefined) ledger for the cash scheme,
    // which switches box 4 to the cash basis.
    expect(inputs.supplierPayments).toEqual([]);
    expect(vat.input_vat).toBe(0); // CF-1: nothing paid ⇒ nothing reclaimed
    expect(vat.net_payable).toBe(0);

    // Counterfactual: the OLD accrual path (no ledger threaded) reclaimed £20 early.
    const accrual = computeVatQuarter([], financeRowsFor(tables), Q_START, Q_END, 0, {
      scheme: "cash",
    });
    expect(accrual.input_vat).toBe(20); // the CF-1 defect, made concrete
  });

  it("PAID purchase bill ⇒ box 4 = the apportioned input VAT (full settlement)", async () => {
    const tables = {
      finances: [bill("fin-1", IN_Q1)],
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-05-11" }],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 120, // full gross settlement
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
    };
    const { vat } = await wiredVat(tables);
    expect(vat.input_vat).toBe(20); // 120 × (20/120)
  });

  it("PARTIALLY-PAID purchase bill ⇒ box 4 apportioned to the cash paid", async () => {
    const tables = {
      finances: [bill("fin-1", IN_Q1)],
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-05-11" }],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 60, // half of the £120 bill
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
    };
    const { vat } = await wiredVat(tables);
    expect(vat.input_vat).toBe(10); // 60 × (20/120)
  });

  it("VOIDED payment ⇒ its allocation reclaims nothing (excluded from the ledger)", async () => {
    const tables = {
      finances: [bill("fin-1", IN_Q1)],
      supplier_payments: [
        { id: "sp-1", org_id: ORG, voided_at: "2026-05-12T00:00:00.000Z", paid_at: "2026-05-11" },
      ],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 120,
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
    };
    const { inputs, vat } = await wiredVat(tables);
    expect(inputs.supplierPayments).toEqual([]); // voided payment not in the window read
    expect(vat.input_vat).toBe(0);
  });

  it("PAYMENT in the NEXT quarter ⇒ box 4 = £0 this quarter (payment-window gated)", async () => {
    const tables = {
      finances: [bill("fin-1", IN_Q1)], // logged Q1
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-07-10" }], // paid Q2
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 120,
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
    };
    // Q1: not paid yet ⇒ £0.
    const { vat: q1 } = await wiredVat(tables);
    expect(q1.input_vat).toBe(0);
    // Q2: the payment lands ⇒ £20.
    const q2Inputs = await gatherVatQuarterInputs(makeDb(tables), ORG, "2026-07-01", "2026-10-01", "cash");
    const q2 = computeVatQuarter([], financeRowsFor({ finances: [] }), "2026-07-01", "2026-10-01", 0, {
      scheme: "cash",
      supplierPayments: q2Inputs.supplierPayments,
      reverseChargeNet: q2Inputs.reverseCharge.net,
    });
    expect(q2.input_vat).toBe(20);
  });
});

describe("CF-1 wired path — boxes 6 and 7 reconcile to the cash payment window", () => {
  it("box 4 + box 7 = the gross cash paid; box 7 net ties to box 4 VAT on ONE window", async () => {
    // A £1,200 sale fully paid (output VAT £200) and a £120 bill fully paid
    // (input VAT £20, net £100), both in-window.
    const tables = {
      invoices: [{ id: "inv-1", org_id: ORG, number: "INV-1", vat_total: 200, amount: 1000, total: 1200 }],
      invoice_payments: [{ id: "ip-1", org_id: ORG, invoice_id: "inv-1", amount: 1200, paid_at: "2026-05-09" }],
      finances: [bill("fin-1", IN_Q1)],
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-05-11" }],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 120,
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
    };
    const { vat, net } = await wiredVat(tables);
    expect(vat.output_vat).toBe(200); // box 1
    expect(vat.input_vat).toBe(20); // box 4
    expect(net.totalValueSalesExVAT).toBe(1000); // box 6 (cash net sales)
    expect(net.totalValuePurchasesExVAT).toBe(100); // box 7 (cash net purchases)
    // The reconciliation invariant: box 4 (VAT) + box 7 (net) = the gross cash paid.
    expect(vat.input_vat + net.totalValuePurchasesExVAT).toBe(120);
  });

  it("UNPAID purchase ⇒ box 7 net is £0 too (matches box 4 = £0), not the accrual net", async () => {
    const tables = { finances: [bill("fin-1", IN_Q1)] };
    const { vat, net } = await wiredVat(tables);
    expect(vat.input_vat).toBe(0);
    expect(net.totalValuePurchasesExVAT).toBe(0); // cash: nothing paid ⇒ nothing in box 7
  });
});

describe("CF-1 wired path — STANDARD scheme is UNCHANGED (accrual)", () => {
  it("standard: box 4/7 stay accrual and the supplier-payment ledger is not read", async () => {
    // Bill logged in-window but UNPAID. On accrual (standard) it is reclaimable at
    // the tax point regardless of payment ⇒ box 4 = £20, box 7 net = £100.
    const tables = {
      finances: [bill("fin-1", IN_Q1)],
      // A paid supplier payment exists, but standard must IGNORE it (no ledger read).
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-05-11" }],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-1",
          amount: 120,
          cis_reverse_charge_vat: 0,
          cis_vat_treatment: null,
        },
      ],
      invoices: [
        { id: "inv-1", org_id: ORG, status: "sent", created_at: IN_Q1, vat_total: 200, amount: 1000, total: 1200 },
      ],
    };
    const { inputs, vat, net } = await wiredVat(tables, "standard");
    expect(inputs.supplierPayments).toBeUndefined(); // ledger not gathered under standard
    expect(vat.input_vat).toBe(20); // accrual: logged cost, tax point in-window
    expect(net.totalValuePurchasesExVAT).toBe(100); // accrual net
    expect(vat.output_vat).toBe(200); // accrual output from the issued invoice
  });
});

describe("CF-1 wired path — REVERSE CHARGE stays on the tax-point basis (C73-A unchanged)", () => {
  it("RC bill logged Q1, PAID Q2: RC VAT (boxes 1/4) AND RC net (box 7) both land in Q1", async () => {
    // A CIS domestic reverse-charge bill: net £75, notional VAT £15, supplier
    // charges no VAT (vat_total 0). Logged Q1, the RC allocation's payment is in Q2.
    const tables = {
      finances: [{ id: "fin-rc", org_id: ORG, vat_total: 0, amount: 75, created_at: IN_Q1 }],
      supplier_payments: [{ id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-08-20" }], // Q2
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-rc",
          amount: 75,
          cis_reverse_charge_vat: 15,
          cis_vat_treatment: "reverse_charge",
        },
      ],
    };
    // Q1 (the bill's tax-point quarter): RC VAT in boxes 1/4, RC net in box 7 —
    // together, even though the cash left in Q2 (RC is outside cash accounting).
    const q1 = await wiredVat(tables);
    expect(q1.inputs.reverseCharge.vat).toBe(15);
    expect(q1.inputs.reverseCharge.net).toBe(75);
    expect(q1.inputs.supplierPayments).toEqual([]); // RC allocation excluded from the cash ledger
    expect(q1.vat.output_vat).toBe(15); // box 1 (notional RC)
    expect(q1.vat.input_vat).toBe(15); // box 4 (notional RC, net-neutral)
    expect(q1.vat.net_payable).toBe(0);
    expect(q1.net.totalValuePurchasesExVAT).toBe(75); // box 7 RC net, on the tax point

    // Q2 (the payment quarter): none of the RC boxes appear — no split.
    const q2Inputs = await gatherVatQuarterInputs(makeDb(tables), ORG, "2026-07-01", "2026-10-01", "cash");
    const q2Vat = computeVatQuarter([], [], "2026-07-01", "2026-10-01", q2Inputs.reverseCharge.vat, {
      scheme: "cash",
      supplierPayments: q2Inputs.supplierPayments,
      reverseChargeNet: q2Inputs.reverseCharge.net,
    });
    const q2Net = computeVatNetTotals([], [], "2026-07-01", "2026-10-01", {
      scheme: "cash",
      supplierPayments: q2Inputs.supplierPayments,
      reverseChargeNet: q2Inputs.reverseCharge.net,
    });
    expect(q2Vat.output_vat).toBe(0);
    expect(q2Vat.input_vat).toBe(0);
    expect(q2Net.totalValuePurchasesExVAT).toBe(0);
  });
});
