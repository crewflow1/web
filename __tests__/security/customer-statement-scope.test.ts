import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { loadCustomerStatement } from "@/server/services/customer-statement";

/**
 * CUSTOMER STATEMENT — active-org + customer scoping, and read-only.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * RLS is not scoping: `current_org_ids()` admits every org the viewer belongs
 * to, so a by-id customer read must pin the ACTIVE org in-statement. A statement
 * exposes a customer's whole financial history + PII, so an unpinned read would
 * let a dual-org member statement another of their orgs' customers.
 *
 * Two proofs: a SOURCE pin (the tripwire) AND a BEHAVIOURAL run against a mock
 * that honours `.eq(...)`, seeded with a foreign-org customer that must never
 * resolve, and a foreign-customer invoice that must never appear in the ledger.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// A chainable Supabase mock that filters as Postgres would.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class Query implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private rangeWindow: [number, number] | null = null;
  constructor(
    private readonly rows: Row[],
    private readonly reads: Array<{ table: string; eqs: Array<[string, unknown]> }>,
    private readonly table: string,
  ) {}
  select() {
    return this;
  }
  eq(k: string, v: unknown) {
    this.eqs.push([k, v]);
    return this;
  }
  in(k: string, v: unknown[]) {
    this.ins.push([k, v]);
    return this;
  }
  order() {
    return this;
  }
  private resolve(): Row[] {
    let out = this.rows.filter(
      (r) =>
        this.eqs.every(([k, v]) => r[k] === v) &&
        this.ins.every(([k, vs]) => vs.includes(r[k])),
    );
    if (this.rangeWindow) out = out.slice(this.rangeWindow[0], this.rangeWindow[1] + 1);
    return out;
  }
  // The method fetchAllRows calls; returns a settled page result.
  range(from: number, to: number) {
    this.rangeWindow = [from, to];
    this.reads.push({ table: this.table, eqs: this.eqs });
    return Promise.resolve({ data: this.resolve(), error: null });
  }
  async maybeSingle() {
    this.reads.push({ table: this.table, eqs: this.eqs });
    const rows = this.resolve();
    return { data: rows[0] ?? null, error: null };
  }
  then<T1 = { data: Row[] | null; error: unknown }, T2 = never>(
    onf?: ((v: { data: Row[] | null; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    this.reads.push({ table: this.table, eqs: this.eqs });
    return Promise.resolve({ data: this.resolve(), error: null }).then(onf, onr);
  }
}

function makeClient(tables: Record<string, Row[]>) {
  const reads: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      return new Query(tables[table] ?? [], reads, table);
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, reads };
}

const ORG_A = "org-A";
const ORG_B = "org-B";

function seed(): Record<string, Row[]> {
  return {
    customers: [
      { id: "cust-A", org_id: ORG_A, name: "Acme (A)", email: "a@a.example" },
      { id: "cust-B", org_id: ORG_B, name: "Beta (B)", email: "b@b.example" },
    ],
    organizations: [
      { id: ORG_A, name: "Org A Ltd", phone: null, vat_number: null, logo_path: null, logo_url: null, address: null },
      { id: ORG_B, name: "Org B Ltd", phone: null, vat_number: null, logo_path: null, logo_url: null, address: null },
    ],
    invoices: [
      { id: "inv-A", number: "A-1", status: "sent", total: 1000, due_date: null, paid_at: null, created_at: "2026-01-01T00:00:00Z", customer_id: "cust-A" },
      // Foreign customer's invoice — must never appear in cust-A's ledger.
      { id: "inv-B", number: "B-1", status: "sent", total: 9999, due_date: null, paid_at: null, created_at: "2026-01-01T00:00:00Z", customer_id: "cust-B" },
    ],
    invoice_payments: [
      { id: "pay-A", invoice_id: "inv-A", amount: 300, paid_at: "2026-01-10T00:00:00Z", reference: "BACS-A" },
      { id: "pay-B", invoice_id: "inv-B", amount: 5000, paid_at: "2026-01-10T00:00:00Z", reference: "BACS-B" },
    ],
  };
}

describe("customer statement — active-org + customer scope (behavioural)", () => {
  it("returns null for a customer that belongs to another org", async () => {
    const { client } = makeClient(seed());
    const view = await loadCustomerStatement(client, ORG_A, "cust-B");
    expect(view).toBeNull();
  });

  it("statements the right customer and never leaks a foreign customer's ledger", async () => {
    const { client } = makeClient(seed());
    const view = await loadCustomerStatement(client, ORG_A, "cust-A");
    expect(view).not.toBeNull();
    expect(view!.customer.name).toBe("Acme (A)");
    // Only cust-A's invoice + payment: 1000 charged, 300 credited, 700 owed.
    expect(view!.statement.totalCharged).toBe(1000);
    expect(view!.statement.totalCredited).toBe(300);
    expect(view!.statement.closingBalance).toBe(700);
    // The £9999 foreign invoice + £5000 foreign payment are absent.
    expect(view!.pdfInput.org_name).toBe("Org A Ltd");
  });

  it("pins the customer read to BOTH id and org_id", async () => {
    const { client, reads } = makeClient(seed());
    await loadCustomerStatement(client, ORG_A, "cust-A");
    const custRead = reads.find((r) => r.table === "customers");
    expect(custRead).toBeDefined();
    const keys = custRead!.eqs.map(([k]) => k);
    expect(keys).toContain("id");
    expect(keys).toContain("org_id");
    // org read is pinned to the active org too.
    const orgRead = reads.find((r) => r.table === "organizations");
    expect(orgRead!.eqs).toContainEqual(["id", ORG_A]);
  });
});

describe("customer statement — source tripwires", () => {
  const service = src("server/services/customer-statement.ts");

  it("pins the customer + org reads to the active org", () => {
    expect(service).toMatch(/\.eq\("id",\s*customerId\)/);
    expect(service).toMatch(/\.eq\("org_id",\s*orgId\)/);
    expect(service).toMatch(/\.eq\("id",\s*orgId\)/);
  });

  it("is read-only — no write verbs", () => {
    expect(service).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });
});
