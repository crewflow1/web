import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  listSuppliersForOrg,
  loadSupplierForOrg,
  type SuppliersClient,
} from "@/server/services/suppliers";

/**
 * Suppliers — active-org pinning against REAL Postgres.
 *
 * The final deferred slice of the active-org defect class (#456 jobs, #459
 * finance/commercial writes, #461 rota). `current_org_ids()` returns EVERY org
 * the viewer belongs to — correct for RLS, which enforces the OUTER boundary —
 * so a supplier read or write identified by primary key alone was NOT
 * constrained to the ACTIVE org. A user working in org A could:
 *
 *   1. see org B's suppliers listed in org A's address book;
 *   2. open org B's supplier at /suppliers/[id] inside org A's shell;
 *   3. UPDATE or DELETE org B's supplier from that page.
 *
 * (3) is the serious one: `suppliers_update` is `org_id in current_org_ids()`
 * and `suppliers_delete` is `is_org_admin(org_id)` — an owner of two orgs
 * satisfies both for BOTH orgs, so RLS admits the write.
 *
 * This is NOT a cross-tenant breach — the viewer is a legitimate member of both
 * orgs. It is a correctness / data-integrity defect.
 *
 * The page, the pickers and the actions call these exact functions, so deleting
 * a pin in server/services/suppliers.ts goes red HERE, not just in review.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-sup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The two suppliers are deliberately NEAR-IDENTICAL — only org_id differs. */
const SUPPLIER_NAME = `${TOKEN} Groundworks Ltd`;
const CATEGORY = "Groundworks";

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  // No auth.users → public.users trigger in this schema, so mirror the row
  // ourselves (memberships.user_id FKs public.users).
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient())
      .from("memberships")
      .insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ??
    "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

describeIntegration("suppliers · active-org pinning (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Member (owner) of BOTH orgs, "working in" org A — the blend probe. */
  let dual = { id: "", token: "" };
  /** Member of org B ONLY — the RLS control. */
  let outsider = { id: "", token: "" };

  let supplierA = "";
  let supplierB = "";
  /** A throwaway org-A supplier the delete test may consume. */
  let disposableA = "";

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Suppliers A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Suppliers B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    supplierA = await insId(svc, "suppliers", {
      org_id: orgA,
      name: SUPPLIER_NAME,
      category: CATEGORY,
      notes: "supplier in org A",
    });
    supplierB = await insId(svc, "suppliers", {
      org_id: orgB,
      name: SUPPLIER_NAME,
      category: CATEGORY,
      notes: "supplier in org B",
    });
    disposableA = await insId(svc, "suppliers", {
      org_id: orgA,
      name: `${TOKEN} Disposable`,
      category: CATEGORY,
    });
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [dual, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // ---------------------------------------------------------------- premise

  it("documents the defect: the UNSCOPED read really does return org B's supplier", async () => {
    // The exact shape the pages used before the fix. RLS admits it because the
    // viewer is a genuine member of org B.
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .select("id, org_id")
      .eq("id", supplierB)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    expect(
      r.data?.id,
      "RLS is deliberately permissive across memberships — if this ever returns " +
        "null, current_org_ids() changed and server/services/suppliers should be revisited",
    ).toBe(supplierB);
  });

  // ---------------------------------------------------------------- scoping

  it("org B's supplier is NOT FOUND while org A is the active org", async () => {
    const client = userClient(dual.token) as unknown as SuppliersClient;
    const row = await loadSupplierForOrg(client, orgA, supplierB);
    expect(
      row,
      "a supplier in a non-active org must be indistinguishable from a missing one",
    ).toBeNull();
  });

  it("org B's supplier is not found even with the columns the detail page requests", async () => {
    const client = userClient(dual.token) as unknown as SuppliersClient;
    const row = await loadSupplierForOrg(
      client,
      orgA,
      supplierB,
      "id, name, email, phone, category, notes",
    );
    expect(row).toBeNull();
  });

  it("the address book lists ONLY the active org's suppliers", async () => {
    const client = userClient(dual.token) as unknown as SuppliersClient;
    const inA = await listSuppliersForOrg<{ id: string }>(client, orgA);
    const idsA = inA.map((s) => s.id);
    expect(idsA).toContain(supplierA);
    expect(idsA, "org B's supplier listed inside org A's address book").not.toContain(supplierB);
  });

  // ------------------------------------------------------- no over-scoping

  it("org A's own supplier IS still readable while org A is active (regression)", async () => {
    const client = userClient(dual.token) as unknown as SuppliersClient;
    const row = await loadSupplierForOrg<{ id: string; notes: string | null }>(
      client,
      orgA,
      supplierA,
      "id, notes",
    );
    expect(row?.id, "the ordinary single-org read path must keep working").toBe(supplierA);
    expect(row?.notes).toBe("supplier in org A");
  });

  it("switching the active org to B flips both reads — the org switcher still works", async () => {
    // Proves the predicate tracks the ACTIVE org rather than hiding org B for
    // ever. Same client, same JWT, different active org.
    const client = userClient(dual.token) as unknown as SuppliersClient;
    expect(await loadSupplierForOrg(client, orgB, supplierB)).not.toBeNull();
    expect(await loadSupplierForOrg(client, orgB, supplierA)).toBeNull();

    const idsB = (await listSuppliersForOrg<{ id: string }>(client, orgB)).map((s) => s.id);
    expect(idsB).toContain(supplierB);
    expect(idsB).not.toContain(supplierA);
  });

  // ----------------------------------------------------------------- writes

  it("an UPDATE scoped to the active org cannot touch org B's supplier", async () => {
    // The exact predicate pair updateSupplier now issues.
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .update({ name: "renamed from org A", notes: "written from org A" }, { count: "exact" })
      .eq("id", supplierB)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "zero rows must be affected — the action reports not-found").toBe(0);

    const after = await svc.from("suppliers").select("name, notes").eq("id", supplierB).maybeSingle();
    expect(after.data?.name, "org B's supplier must be untouched").toBe(SUPPLIER_NAME);
    expect(after.data?.notes).toBe("supplier in org B");
  });

  it("without the predicate that same UPDATE DOES hit org B (the defect)", async () => {
    // The unscoped write the action performed before the fix.
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .update({ notes: "cross-org write" }, { count: "exact" })
      .eq("id", supplierB);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "this is precisely what the fix prevents").toBe(1);

    // Restore the fixture so later assertions are not confused by it.
    await svc.from("suppliers").update({ notes: "supplier in org B" }).eq("id", supplierB);
  });

  it("an UPDATE scoped to the active org still works on org A's own supplier", async () => {
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .update({ notes: "legitimate org A write" }, { count: "exact" })
      .eq("id", supplierA)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "the normal write path must not be over-scoped").toBe(1);
  });

  it("a DELETE scoped to the active org cannot remove org B's supplier", async () => {
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .delete({ count: "exact" })
      .eq("id", supplierB)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "deleteSupplier must match nothing and redirect to the list").toBe(0);

    const still = await svc.from("suppliers").select("id").eq("id", supplierB).maybeSingle();
    expect(still.data?.id, "org B's supplier must survive an org-A delete").toBe(supplierB);
  });

  it("a DELETE scoped to the active org still removes org A's own supplier", async () => {
    const r = await db(userClient(dual.token))
      .from("suppliers")
      .delete({ count: "exact" })
      .eq("id", disposableA)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "the normal delete path must not be over-scoped").toBe(1);
  });

  // -------------------------------------------------------------- CIS (M1)

  it("CIS: the composite FK refuses a profile pointing at another org's supplier", async () => {
    // Defence in depth behind the read fix. `cis_subcontractors` is keyed
    // (org_id, supplier_id) with
    //   foreign key (supplier_id, org_id) references suppliers (id, org_id)
    // so even if a CIS page were reached for a foreign supplier, the identity
    // could not be filed against it. The dual user is an ADMIN of both orgs,
    // so the admin-only RLS does not stop this — only the FK does.
    const r = await db(userClient(dual.token))
      .from("cis_subcontractors")
      .insert({ org_id: orgA, supplier_id: supplierB, legal_name: "Cross-org attempt" });
    expect(r.error, "an org-A CIS profile for an org-B supplier must be refused").not.toBeNull();
  });

  it("CIS: admin-only RLS is untouched — an org-B-only member cannot read org A's table", async () => {
    const r = await db(userClient(outsider.token))
      .from("cis_subcontractors")
      .select("supplier_id")
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data ?? []).toHaveLength(0);
  });

  // ------------------------------------------------------------ RLS control

  it("RLS is untouched: an org-B-only member sees nothing of org A", async () => {
    const client = userClient(outsider.token) as unknown as SuppliersClient;
    // The pin is scoping, not the security boundary — even ASKING for org A
    // returns nothing, because RLS never serves org A's rows to this viewer.
    expect(await loadSupplierForOrg(client, orgA, supplierA)).toBeNull();
    expect(await listSuppliersForOrg(client, orgA)).toEqual([]);
  });

  it("RLS is untouched: a non-member is denied even by the UNSCOPED query", async () => {
    // The outer boundary must not depend on the application-layer predicate.
    const r = await db(userClient(outsider.token))
      .from("suppliers")
      .select("id")
      .eq("id", supplierA)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data, "RLS alone must still deny a genuine outsider").toBeNull();
  });

  it("RLS is untouched: a non-member's UNSCOPED write affects nothing", async () => {
    const r = await db(userClient(outsider.token))
      .from("suppliers")
      .update({ notes: "outsider write" }, { count: "exact" })
      .eq("id", supplierA);
    expect(r.count ?? 0, "RLS must refuse the write regardless of the app predicate").toBe(0);
  });

  it("RLS is untouched: anon sees nothing", async () => {
    const anon = anonClient() as unknown as SuppliersClient;
    expect(await listSuppliersForOrg(anon, orgA)).toEqual([]);
    expect(await loadSupplierForOrg(anon, orgA, supplierA)).toBeNull();
  });
});
