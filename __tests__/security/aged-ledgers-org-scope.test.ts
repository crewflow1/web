import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AGED LEDGERS — active-org scoping, the payables role gate, and read-only.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * RLS is not scoping. `current_org_ids()` returns EVERY org the viewer belongs
 * to, so an unpinned read on a dual-org account returns both companies' rows and
 * the aged listing merges them. On this report the damage is specific and
 * invisible: a customer (or a supplier) trading with BOTH of the operator's
 * companies becomes ONE row with the two companies' debts added together. The
 * operator then chases — or pays — a figure that belongs to no set of books. This
 * is the exact class the repo spent six read-side slices closing.
 *
 * ── WHY THE BEHAVIOURAL HALF IS THE REAL PROOF ───────────────────────────────
 * A source grep for `.eq("org_id", ...)` can be satisfied by a filter on the
 * wrong table, or on one read out of eight. So the service is EXECUTED against a
 * chainable Supabase mock that HONOURS the filters it is given and is seeded with
 * two orgs whose books deliberately share a customer and a supplier. If the pin
 * were dropped from any read, the org-B rows would appear in the org-A ledger and
 * these assertions fail. The source pins below are the tripwire on top of that.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// The chainable mock
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const reads: Array<{ table: string; eqs: Array<[string, unknown]>; nots: Array<[string, string, unknown]> }> = [];
  /** Table → every row across BOTH orgs. The mock filters, as Postgres would. */
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const failing = new Set<string>();

  function makeBuilder(table: string) {
    const rec = { table, eqs: [] as Array<[string, unknown]>, nots: [] as Array<[string, string, unknown]> };
    reads.push(rec);

    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        rec.eqs.push([col, val]);
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        rec.nots.push([col, op, val]);
        return builder;
      },
      order: () => builder,
      range: () => {
        if (failing.has(table)) {
          return Promise.resolve({ data: null, error: { message: `${table} exploded` } });
        }
        const rows = (tables[table] ?? []).filter((row) => {
          for (const [col, val] of rec.eqs) if (row[col] !== val) return false;
          for (const [col, op] of rec.nots) {
            if (op === "is" && row[col] == null) return false;
          }
          return true;
        });
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  return {
    reads,
    tables,
    failing,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      reads.length = 0;
      for (const k of Object.keys(tables)) delete tables[k];
      failing.clear();
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
}));

const { buildAgedLedgers, canReadPayables } = await import("@/server/services/aged-ledgers");

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";
const NOW = new Date("2026-07-30T09:00:00Z");

/**
 * Two companies whose books deliberately OVERLAP: `Shared Developments` is a
 * customer of both, and `Shared Merchants` a supplier to both. That overlap is
 * the whole test — without it, a missing org filter would still produce
 * separate-looking rows and pass.
 */
function seedTwoOrgs() {
  h.tables.invoices = [
    // Org A — £1,000 owed by the shared customer, 200 days late.
    { id: "inv-a1", org_id: ORG_A, number: "A-1", status: "sent", total: 1000, due_date: "2026-01-11", customer_id: "cust-shared", job_id: null },
    // Org B — £9,000 owed by the SAME customer id.
    { id: "inv-b1", org_id: ORG_B, number: "B-1", status: "sent", total: 9000, due_date: "2026-01-11", customer_id: "cust-shared", job_id: null },
  ];
  h.tables.invoice_payments = [
    { org_id: ORG_A, invoice_id: "inv-a1", amount: 250 },
    // A payment in org B that must NEVER reduce org A's invoice.
    { org_id: ORG_B, invoice_id: "inv-b1", amount: 4000 },
  ];
  h.tables.customers = [
    { id: "cust-shared", org_id: ORG_A, name: "Shared Developments (A)" },
    { id: "cust-shared", org_id: ORG_B, name: "Shared Developments (B)" },
  ];
  h.tables.jobs = [
    { id: "job-a", org_id: ORG_A, customer_id: "cust-shared" },
    { id: "job-b", org_id: ORG_B, customer_id: "cust-shared" },
  ];
  h.tables.finances = [
    { id: "bill-a1", org_id: ORG_A, amount: 500, vat_total: 100, reference: "A-BILL", bill_date: "2026-07-01", created_at: "2026-07-01T00:00:00Z", supplier_id: "sup-shared" },
    { id: "bill-b1", org_id: ORG_B, amount: 5000, vat_total: 1000, reference: "B-BILL", bill_date: "2026-07-01", created_at: "2026-07-01T00:00:00Z", supplier_id: "sup-shared" },
    // A plain cost with no supplier — cannot be aged against an account.
    { id: "cost-a1", org_id: ORG_A, amount: 90, vat_total: 18, reference: null, bill_date: "2026-07-01", created_at: "2026-07-01T00:00:00Z", supplier_id: null },
  ];
  h.tables.supplier_payments = [
    { id: "pay-a1", org_id: ORG_A, voided_at: null },
    { id: "pay-b1", org_id: ORG_B, voided_at: null },
  ];
  h.tables.supplier_payment_allocations = [
    { org_id: ORG_A, payment_id: "pay-a1", finance_id: "bill-a1", amount: 100 },
    // Org B settling its own bill must not settle org A's.
    { org_id: ORG_B, payment_id: "pay-b1", finance_id: "bill-b1", amount: 6000 },
  ];
  h.tables.suppliers = [
    { id: "sup-shared", org_id: ORG_A, name: "Shared Merchants (A)" },
    { id: "sup-shared", org_id: ORG_B, name: "Shared Merchants (B)" },
  ];
}

beforeEach(() => {
  h.reset();
  seedTwoOrgs();
});

// ---------------------------------------------------------------------------
// 1. behavioural — the dual-org proof
// ---------------------------------------------------------------------------

describe("dual-org: a party trading with both companies ages only in the active org", () => {
  it("aged debtors show ONLY the active org's invoice and its own payments", async () => {
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(false);
    // £1,000 billed less the £250 paid IN ORG A. Org B's £9,000 and its £4,000
    // payment are both absent — either leaking would change this number.
    expect(view.debtors.totals.total).toBe(750);
    expect(view.debtors.rows).toHaveLength(1);
    expect(view.debtors.rows[0]!.partyName).toBe("Shared Developments (A)");
    expect(view.debtors.rows[0]!.items.map((i) => i.id)).toEqual(["inv-a1"]);
  });

  it("the other org sees its own figure, from the same seeded data", async () => {
    const view = await buildAgedLedgers(ORG_B, "owner", NOW);
    expect(view.debtors.totals.total).toBe(5000);
    expect(view.debtors.rows[0]!.partyName).toBe("Shared Developments (B)");
  });

  it("aged creditors show ONLY the active org's bills and allocations", async () => {
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    // £600 gross less the £100 allocated in org A. Org B's £6,000 allocation
    // must not settle org A's bill.
    expect(view.creditors.totals.total).toBe(500);
    expect(view.creditors.rows).toHaveLength(1);
    expect(view.creditors.rows[0]!.partyName).toBe("Shared Merchants (A)");
  });

  it("a bill with no supplier is excluded from creditors, not silently attributed", async () => {
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    const ids = view.creditors.rows.flatMap((r) => r.items.map((i) => i.id));
    expect(ids).not.toContain("cost-a1");
  });

  it("EVERY read carries an org_id filter equal to the active org", async () => {
    await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(h.reads.length).toBeGreaterThanOrEqual(8);
    for (const r of h.reads) {
      const orgEq = r.eqs.find(([c]) => c === "org_id");
      expect(orgEq, `${r.table} read is not org-pinned`).toBeDefined();
      expect(orgEq?.[1], `${r.table} read is pinned to the wrong org`).toBe(ORG_A);
    }
  });

  it("reads exactly the eight tables the two ledgers need, and no others", async () => {
    await buildAgedLedgers(ORG_A, "owner", NOW);
    expect([...new Set(h.reads.map((r) => r.table))].sort()).toEqual([
      "customers",
      "finances",
      "invoice_payments",
      "invoices",
      "jobs",
      "supplier_payment_allocations",
      "supplier_payments",
      "suppliers",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. behavioural — the payables role gate
// ---------------------------------------------------------------------------

describe("the payables gate — a wrong number is worse than a withheld one", () => {
  it("owners and admins can read payables; nobody else can", () => {
    expect(canReadPayables("owner")).toBe(true);
    expect(canReadPayables("admin")).toBe(true);
    expect(canReadPayables("member")).toBe(false);
    expect(canReadPayables("staff")).toBe(false);
    expect(canReadPayables("")).toBe(false);
  });

  it("a non-admin gets creditorsVisible: false and an EMPTY ledger", async () => {
    // The money-out ledger is admin-only at the RLS layer and returns empty
    // WITHOUT an error, so composing it for a member would show every bill as
    // entirely unpaid — overstating payables by everything already paid.
    const view = await buildAgedLedgers(ORG_A, "member", NOW);
    expect(view.creditorsVisible).toBe(false);
    expect(view.creditors.totals.total).toBe(0);
    expect(view.creditors.rows).toHaveLength(0);
  });

  it("a non-admin does not even ISSUE the money-out reads", async () => {
    await buildAgedLedgers(ORG_A, "member", NOW);
    const tables = new Set(h.reads.map((r) => r.table));
    expect(tables.has("supplier_payments")).toBe(false);
    expect(tables.has("supplier_payment_allocations")).toBe(false);
    expect(tables.has("finances")).toBe(false);
  });

  it("a non-admin still gets the full aged DEBTORS ledger", async () => {
    const view = await buildAgedLedgers(ORG_A, "member", NOW);
    expect(view.debtors.totals.total).toBe(750);
  });
});

// ---------------------------------------------------------------------------
// 3. behavioural — loud reads
// ---------------------------------------------------------------------------

describe("loud reads — a failed query must never render as a settled ledger", () => {
  it("a failed invoices read sets loadError", async () => {
    h.failing.add("invoices");
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(true);
  });

  it("a failed PAYMENTS read sets loadError even though invoices succeeded", async () => {
    // This is the dangerous one: without the payment rows every invoice looks
    // unpaid, so the total goes UP and nothing looks broken.
    h.failing.add("invoice_payments");
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(true);
  });

  it("a failed supplier-allocations read sets loadError", async () => {
    h.failing.add("supplier_payment_allocations");
    const view = await buildAgedLedgers(ORG_A, "owner", NOW);
    expect(view.loadError).toBe(true);
  });

  it("a thrown client returns loadError, never a reassuring empty ledger", async () => {
    const boom = vi.spyOn(h.client, "from").mockImplementation(() => {
      throw new Error("connection reset");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = await buildAgedLedgers(ORG_A, "owner", NOW);
      expect(view.loadError).toBe(true);
      expect(view.debtors.totals.total).toBe(0);
      // An as-at date is still returned so the page can render its banner.
      expect(view.asAtIso).toBe("2026-07-30");
    } finally {
      boom.mockRestore();
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. source pins
// ---------------------------------------------------------------------------

const SERVICE = src("server/services/aged-ledgers.ts");
const PAGE = src("app/(app)/reports/ageing/page.tsx");

describe("source pins — the report is READ-ONLY", () => {
  it("the service never mutates anything", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(SERVICE, `aged-ledgers must not ${op}`).not.toContain(op);
    }
  });

  it("the page never mutates anything and declares no server action", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(PAGE, `the ageing page must not ${op}`).not.toContain(op);
    }
    expect(PAGE).not.toMatch(/"use server"/);
  });

  it("reads the money-out ledger MINIMALLY — no CIS or cash columns", () => {
    // This is the promise on which __tests__/security/supplier-payments.test.ts
    // admits this file to the ledger-table allowlist: `id, voided_at` is all the
    // settlement authority needs, and an aged listing has no business carrying
    // withholding figures it never displays.
    expect(SERVICE).toMatch(/paged\(db, "supplier_payments", "id, voided_at", "id", orgId\)/);
    // Check the SELECTED COLUMNS, not the whole file: the row shape the
    // settlement authority requires is built with `net_paid: null` placeholders,
    // which are not reads.
    const selected = [...SERVICE.matchAll(/paged\(\s*\n?\s*db,\s*\n?\s*"[a-z_]+",\s*\n?\s*((?:"[^"]*"(?:\s*\+\s*)?)+)/g)]
      .map((m) => m[1]!.replace(/"|\s|\+/g, ""))
      .join(",");
    expect(selected.length, "sanity: column lists were found to check").toBeGreaterThan(50);
    for (const col of ["gross_amount", "cis_withheld", "net_paid", "cis_deduction"]) {
      expect(selected, `must not SELECT ${col}`).not.toContain(col);
    }
  });

  it("reporting on money never POSTS money — no finances write path exists", () => {
    // `finances` is READ for aged creditors; it must never be written here.
    expect(SERVICE).toMatch(/paged\(\s*\n?\s*db,\s*\n?\s*"finances"/);
    expect(SERVICE).not.toMatch(/from\("finances"\)[\s\S]{0,80}(insert|update|delete)/);
  });
});

describe("source pins — org pinning cannot be dropped silently", () => {
  it("every `paged(` call passes orgId and the helper applies it", () => {
    expect(SERVICE).toMatch(/\.eq\("org_id", orgId\)/);
    const pagedCalls = (SERVICE.match(/\bpaged\(/g) ?? []).length;
    // 8 call sites + the helper's own definition + one internal reference.
    expect(pagedCalls).toBeGreaterThanOrEqual(9);
  });

  it("the page passes the ACTIVE org and role, never a raw membership list", () => {
    expect(PAGE).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(PAGE).toMatch(/buildAgedLedgers\(\s*\n?\s*ctx\.org\.id,\s*\n?\s*ctx\.membership\.role,?\s*\n?\s*\)/);
  });

  it("staff are redirected off the whole debtor and creditor book", () => {
    expect(PAGE).toMatch(/ctx\.membership\.role === "staff"\) redirect\("\/me"\)/);
  });
});

describe("source pins — paged reads keep a unique total order", () => {
  it("a non-`id` ordering always appends `id` as the tiebreaker", () => {
    // Without it, rows sharing the sort key can be dropped or duplicated at a
    // 500-row page boundary — the F-1 silent-truncation class, which on this
    // report would UNDERSTATE what the business is owed.
    expect(SERVICE).toMatch(
      /orderKey === "id" \? base : base\.order\("id", \{ ascending: true \}\)/,
    );
  });

  it("reads go through fetchAllRows, never a bare select", () => {
    expect(SERVICE).toMatch(/fetchAllRows<Row>/);
  });
});
