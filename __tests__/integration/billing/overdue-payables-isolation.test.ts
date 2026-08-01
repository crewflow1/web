import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { composeOverduePayables } from "@/lib/commercial/overdue-payables";
import { type CreditorBill } from "@/lib/commercial/aged-creditors";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";

/**
 * OVERDUE PAYABLES — dual-org isolation + the terms CHECK, against REAL Postgres.
 *
 * The mirror of __tests__/integration/billing/org-cash-out-isolation.test.ts for
 * the aged-payables surface. Two proofs the unit tier cannot give:
 *
 *  1. DUAL-ORG. `suppliers`, `finances`, `supplier_payments` and
 *     `supplier_payment_allocations` are all admitted by RLS for EVERY org the
 *     viewer belongs to (current_org_ids / is_org_admin are many-to-many over
 *     memberships). So an owner of two companies whose books share a supplier
 *     name would, on an RLS-only read, see ONE blended aged-payables row with both
 *     companies' bills — and chase or pay a figure that belongs to neither. The
 *     `org_id` pin on every read is what prevents it; this file drives the pinned
 *     read with a real dual-org JWT and composes the ledger from what comes back.
 *
 *  2. THE TERMS CHECK IS REAL. `payment_terms_days` is bounded 0..365 at the DB
 *     (migration 20261088), and drives the DERIVED due date. This proves the
 *     column resolves against the live schema and rejects a nonsense term even for
 *     service_role.
 *
 * Residue-independent: fixtures are namespaced by a per-run token; every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(column: string, value: unknown): PromiseLike<Res<null>>;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const T = `it-overdue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// A fixed as-at day keeps the band assertions stable regardless of when the suite runs.
const AS_AT = "2026-07-30";
/** Both suppliers share a trading name — the blend probe. Only org_id differs. */
const SHARED_NAME = `${T} Groundworks Ltd`;

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${T}-${suffix}@example.test`;
  const password = `Pw-${T}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

/**
 * Read one org's aged-payables inputs the way server/services/aged-ledgers does —
 * every read pinned to `orgId` — and compose the overdue ledger. This is the
 * production read shape; if a pin were dropped the org-B rows would appear.
 */
async function readOverduePayables(client: unknown, orgId: string) {
  const d = db(client);
  const pin = (t: string, cols: string) => d.from(t).select(cols).eq("org_id", orgId);

  const [bills, sups, pays, allocs] = await Promise.all([
    pin("finances", "id, amount, vat_total, reference, bill_date, created_at, supplier_id"),
    pin("suppliers", "id, name, payment_terms_days"),
    pin("supplier_payments", "id, voided_at"),
    pin("supplier_payment_allocations", "payment_id, finance_id, amount"),
  ]);

  const billRows: CreditorBill[] = (bills.data ?? [])
    .filter((b) => b.supplier_id != null)
    .map((b) => ({
      id: String(b.id),
      amount: b.amount as number | string | null,
      vat_total: b.vat_total as number | string | null,
      reference: (b.reference as string | null) ?? null,
      bill_date: (b.bill_date as string | null) ?? null,
      created_at: (b.created_at as string | null) ?? null,
      supplier_id: (b.supplier_id as string | null) ?? null,
    }));
  const payments: SupplierPaymentRow[] = (pays.data ?? []).map((p) => ({
    id: String(p.id),
    paid_at: "",
    method: "",
    reference: null,
    gross_amount: null,
    cis_withheld: null,
    net_paid: null,
    voided_at: (p.voided_at as string | null) ?? null,
  }));
  const allocations: SupplierAllocationRow[] = (allocs.data ?? []).map((a) => ({
    payment_id: String(a.payment_id),
    finance_id: String(a.finance_id),
    amount: a.amount as number | string | null,
  }));

  return composeOverduePayables(
    {
      bills: billRows,
      payments,
      allocations,
      supplierName: new Map((sups.data ?? []).map((s) => [String(s.id), String(s.name ?? "")])),
      termsBySupplier: new Map(
        (sups.data ?? []).map((s) => {
          const raw = s.payment_terms_days;
          return [String(s.id), raw == null ? null : Number(raw)] as [string, number | null];
        }),
      ),
    },
    AS_AT,
  );
}

describeIntegration("overdue payables · dual-org isolation + terms CHECK (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  let dual = { id: "", token: "" };
  let outsider = { id: "", token: "" };
  let supA = "";
  let supB = "";

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Overdue A", slug: `${T}-a` });
    orgB = await insId(svc, "organizations", { name: "Overdue B", slug: `${T}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    // Org A supplier on net-60; org B supplier with UNRECORDED terms (→ default 30).
    supA = await insId(svc, "suppliers", { org_id: orgA, name: SHARED_NAME, payment_terms_days: 60 });
    supB = await insId(svc, "suppliers", { org_id: orgB, name: SHARED_NAME });

    // A bill dated 15 June in each org: £1,000 net + 20% VAT = £1,200 gross.
    // Under net-60 (org A) it is due 14 Aug → still WITHIN terms at 30 Jul → current.
    // Under the assumed net-30 (org B) it is due 15 Jul → 15 days late.
    await insId(svc, "finances", { org_id: orgA, supplier_id: supA, amount: 1000, vat_rate: 20, bill_date: "2026-06-15" });
    await insId(svc, "finances", { org_id: orgB, supplier_id: supB, amount: 1000, vat_rate: 20, bill_date: "2026-06-15" });
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    for (const u of [dual, outsider]) if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
  });

  it("aged payables show ONLY the active org's supplier and bill", async () => {
    const client = userClient(dual.token);
    const a = await readOverduePayables(client, orgA);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.partyId).toBe(supA);
    expect(a.totals.total).toBe(1200);
    // org A is on net-60 → the 15 June bill is not yet due at 30 July.
    expect(a.totals.buckets.current).toBe(1200);
    expect(a.totals.pastDue).toBe(0);
    // org B's near-identical supplier/bill must be absent.
    const ids = a.rows.flatMap((r) => r.items.map((i) => i.id));
    expect(a.rows.some((r) => r.partyId === supB)).toBe(false);
    expect(ids).toHaveLength(1);
  });

  it("the SAME bill ages differently in org B, where terms are unrecorded (assumed 30)", async () => {
    const client = userClient(dual.token);
    const b = await readOverduePayables(client, orgB);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]!.partyId).toBe(supB);
    expect(b.totals.total).toBe(1200);
    // Assumed net-30 → due 15 July → 15 days late.
    expect(b.totals.buckets.d1_30).toBe(1200);
    expect(b.totals.pastDue).toBe(1200);
  });

  it("the DB CHECK enforces the 0..365 bound even for service_role", async () => {
    for (const bad of [400, -1]) {
      const r = await svc
        .from("suppliers")
        .insert({ org_id: orgA, name: `${T} bad-${bad}`, payment_terms_days: bad });
      expect(r.error, `terms ${bad} must be refused`).not.toBeNull();
    }
    // The bounds and NULL are accepted.
    for (const ok of [0, 365, null]) {
      const id = await insId(svc, "suppliers", { org_id: orgA, name: `${T} ok-${ok}`, payment_terms_days: ok });
      expect(id).toBeTruthy();
    }
  });

  it("RLS is untouched: an org-B-only member sees nothing of org A's payables", async () => {
    const a = await readOverduePayables(userClient(outsider.token), orgA);
    expect(a.rows).toEqual([]);
    expect(a.totals.total).toBe(0);
  });

  it("RLS is untouched: anon sees nothing", async () => {
    const a = await readOverduePayables(anonClient(), orgA);
    expect(a.totals.total).toBe(0);
  });
});
