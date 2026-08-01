import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { supplierFormSchema } from "@/lib/suppliers/schema";

/**
 * SUPPLIER PAYMENT TERMS — the write path and the DDL that make TRUE overdue
 * payables possible (migration 20261088).
 *
 * Three properties, each a failure mode this train must not open:
 *
 *  1. VALIDATED. `payment_terms_days` is bounded (0..365, whole days) and a blank
 *     input is NULL ("terms not recorded"), never a fabricated 30. The 30-day
 *     ageing assumption lives only in the read path, disclosed as an assumption.
 *  2. ORG-PINNED, NO MONEY WRITE. The supplier update carries its active-org
 *     predicate (the #456 defect class) and this train adds no write to any money
 *     or generated column — `finances`, `vat_total`, settlement figures are all
 *     untouched.
 *  3. ADDITIVE DDL. The migration adds one nullable column with a CHECK to a
 *     reference table, adds no stored `finances.due_date` (the due date is
 *     derived), touches no RLS, and writes no generated column.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. The schema bounds the value and keeps "unrecorded" distinct from net-0
// ---------------------------------------------------------------------------

describe("supplierFormSchema — payment_terms_days is bounded, whole-day, nullable-by-blank", () => {
  const base = { name: "Travis Perkins" };

  it("accepts a whole number of days and coerces the string", () => {
    const r = supplierFormSchema.safeParse({ ...base, payment_terms_days: "30" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payment_terms_days).toBe(30);
  });

  it("accepts net-0 (due on receipt) as a real, distinct term", () => {
    const r = supplierFormSchema.safeParse({ ...base, payment_terms_days: "0" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payment_terms_days).toBe(0);
  });

  it("treats a blank as UNDEFINED — the action writes NULL, not an assumed 30", () => {
    for (const blank of ["", "   "]) {
      const r = supplierFormSchema.safeParse({ ...base, payment_terms_days: blank });
      expect(r.success, `blank ${JSON.stringify(blank)}`).toBe(true);
      if (r.success) expect(r.data.payment_terms_days).toBeUndefined();
    }
    // Absent entirely is also undefined.
    const r = supplierFormSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payment_terms_days).toBeUndefined();
  });

  it("rejects out-of-range, fractional and non-numeric terms", () => {
    for (const bad of ["-1", "366", "1000", "15.5", "thirty"]) {
      expect(
        supplierFormSchema.safeParse({ ...base, payment_terms_days: bad }).success,
        `must reject ${bad}`,
      ).toBe(false);
    }
  });

  it("the schema's bounds mirror the DB CHECK exactly (0..365)", () => {
    expect(supplierFormSchema.safeParse({ ...base, payment_terms_days: "365" }).success).toBe(true);
    expect(supplierFormSchema.safeParse({ ...base, payment_terms_days: "0" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The write path — org-pinned, and no money/generated column is written
// ---------------------------------------------------------------------------

describe("the supplier write path stays org-pinned and money-safe", () => {
  const ACTIONS = codeOf(src("app/(app)/suppliers/actions.ts"));

  it("createSupplier stamps the active org and persists the term", () => {
    const F = ACTIONS.slice(ACTIONS.indexOf("export async function createSupplier"));
    expect(F).toMatch(/org_id: ctx\.org\.id/);
    expect(F).toMatch(/payment_terms_days: result\.data\.payment_terms_days \?\? null/);
  });

  it("updateSupplier scopes the UPDATE to the active org and persists the term", () => {
    const F = ACTIONS.slice(
      ACTIONS.indexOf("export async function updateSupplier"),
      ACTIONS.indexOf("export async function deleteSupplier"),
    );
    expect(F).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/payment_terms_days: result\.data\.payment_terms_days \?\? null/);
  });

  it("writes no money or generated column — this is address-book data, not the ledger", () => {
    for (const banned of ["vat_total", "vat_rate", "amount:", "cis_", "net_pay", "finances"]) {
      expect(ACTIONS, `supplier actions must not write ${banned}`).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The migration is additive and leaves the money tables alone
// ---------------------------------------------------------------------------

describe("migration 20261088 — additive column, derived due date, RLS untouched", () => {
  const MIG = src("supabase/migrations/20261088000000_supplier_payment_terms.sql");
  // Strip `--` line comments AND the `comment on column ...;` documentation
  // string, so these pins test EXECUTABLE DDL — the header and column comment
  // deliberately discuss "due_date" and "default" to explain why neither is used.
  const migCode = MIG.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/comment on column[\s\S]*?;/gi, "");
  // The single ALTER statement, isolated for column-shape assertions.
  const alterStmt = migCode.slice(
    migCode.indexOf("alter table public.suppliers"),
    migCode.indexOf(";", migCode.indexOf("alter table public.suppliers")) + 1,
  );

  it("adds ONE nullable column to suppliers, guarded by IF NOT EXISTS", () => {
    expect(alterStmt).toMatch(
      /alter table public\.suppliers\s+add column if not exists payment_terms_days integer/,
    );
  });

  it("bounds it with a CHECK of 0..365 that admits NULL", () => {
    expect(alterStmt).toMatch(/payment_terms_days is null/);
    expect(alterStmt).toMatch(/payment_terms_days >= 0 and payment_terms_days <= 365/);
  });

  it("has NO db default — 'not recorded' must be distinguishable from an agreed term", () => {
    expect(alterStmt).not.toMatch(/\bdefault\b/i);
  });

  it("adds NO stored due_date to finances — the due date is DERIVED at read time", () => {
    expect(migCode).not.toMatch(/alter table public\.finances/);
    expect(migCode).not.toMatch(/add column[^;]*due_date/);
  });

  it("touches no money arithmetic and no generated column", () => {
    expect(migCode).not.toMatch(/generated always as/);
    expect(migCode).not.toMatch(/vat_total|vat_rate|cis_/);
  });

  it("touches no RLS on suppliers — the existing policies already cover every column", () => {
    expect(migCode).not.toMatch(/create policy|drop policy|enable row level security|alter policy/);
  });
});

// ---------------------------------------------------------------------------
// 4. Overdue payables is a LENS on the position, not a new outflow (no double-count)
// ---------------------------------------------------------------------------

describe("overdue payables must not be added into the cash-out position", () => {
  it("cash-out does not import overdue-payables or learn about payment terms", () => {
    // Overdue payables is a SUBSET of unpaidBills, which is already fully inside
    // outflowDueNow. Wiring it into the position would double-count the same cash.
    const CASH_OUT = codeOf(src("lib/commercial/cash-out.ts"));
    expect(CASH_OUT).not.toMatch(/overdue-payables|composeOverduePayables|payment_terms_days/);
  });
});
