import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * ACCOUNTING PUSH-ONCE LEDGER (20261110) — against real Postgres RLS.
 *
 * This is the DB half of the duplicate-invoice fix: `accounting_pushed_entities`
 * records exactly which (org, provider, entity_type, entity_id) a provider has
 * accepted, and the next sync excludes them so a re-push can never re-send them.
 *
 *   1. RLS: member-read / admin-write / admin-delete, org-isolated. A plain
 *      member READS but cannot INSERT or DELETE; an admin can; an outsider sees
 *      nothing; a UNIQUE(org,provider,type,id) makes a re-record a no-op.
 *   2. EXCLUSION SEMANTICS (the anti-set the service applies in memory), proven
 *      end-to-end against real rows: with A,B recorded for xero, a read that
 *      excludes the xero-ledger ids returns ONLY C — and the qbo ledger is
 *      independent, so a qbo sync still sees A,B,C (per-provider push-once).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  neq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-pushonce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const LEDGER = "accounting_pushed_entities";

describeIntegration("accounting push-once ledger · RLS + exclusion", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  const invId: Record<string, string> = {}; // number → id

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `PushOnce ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function seedInvoice(org: string, customerId: string, number: string): Promise<string> {
    const res = await db(serviceClient())
      .from("invoices")
      .insert({
        org_id: org,
        customer_id: customerId,
        number,
        amount: 100,
        vat_total: 20,
        status: "sent",
        sent_at: "2026-07-01T09:00:00Z",
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return String(res.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "PushOnce A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "PushOnce B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const custA = await svc.from("customers").insert({ org_id: orgA, name: "Acme Ltd" }).select("id").single();
    const custAId = String(custA.data?.id ?? "");

    invId["INV-A"] = await seedInvoice(orgA, custAId, `${TOKEN}-INV-A`);
    invId["INV-B"] = await seedInvoice(orgA, custAId, `${TOKEN}-INV-B`);
    invId["INV-C"] = await seedInvoice(orgA, custAId, `${TOKEN}-INV-C`);

    const owner = await mintUser("owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    for (const org of [orgA, orgB]) {
      const m = await svc.from("memberships").insert({ org_id: org, user_id: ownerId, role: "owner" });
      expect(m.error, m.error?.message).toBeNull();
    }
    const member = await mintUser("member");
    memberToken = member.token;
    const mm = await svc.from("memberships").insert({ org_id: orgA, user_id: member.id, role: "staff" });
    expect(mm.error, mm.error?.message).toBeNull();
    outsiderToken = (await mintUser("outsider")).token;

    if (!ownerToken || !memberToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. RLS ─────────────────────────────────────────────────────────────────

  it("an ADMIN (owner) can insert a pushed-entity record", async () => {
    const res = await db(userClient(ownerToken))
      .from(LEDGER)
      .insert({
        org_id: orgA,
        created_by: ownerId,
        provider: "xero",
        entity_type: "invoice",
        entity_id: invId["INV-A"],
      })
      .select("id");
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBe(1);
  });

  it("a plain MEMBER may READ but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const read = await asMember.from(LEDGER).select("id").eq("org_id", orgA);
    expect(read.error, read.error?.message).toBeNull();
    expect((read.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from(LEDGER)
      .insert({ org_id: orgA, provider: "xero", entity_type: "invoice", entity_id: invId["INV-B"] })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no records at all (org isolation)", async () => {
    const res = await db(userClient(outsiderToken)).from(LEDGER).select("id").eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("the UNIQUE(org,provider,type,id) key makes a duplicate record a no-op (push-once)", async () => {
    // The same entity recorded twice is refused — a row pushed once is never
    // re-recorded, so it can never re-enter a later batch.
    const dup = await db(userClient(ownerToken))
      .from(LEDGER)
      .insert({
        org_id: orgA,
        created_by: ownerId,
        provider: "xero",
        entity_type: "invoice",
        entity_id: invId["INV-A"],
      })
      .select("id");
    expect(dup.error, "duplicate (org,provider,type,id) must be refused").not.toBeNull();
  });

  // ── 2. EXCLUSION SEMANTICS (the anti-set the service applies) ────────────────

  it("EXCLUDES recorded rows: with A,B in the xero ledger, only C survives", async () => {
    const asOwner = db(userClient(ownerToken));
    // Record B too (A was recorded in test 1). This is what a successful sync writes.
    const recB = await asOwner
      .from(LEDGER)
      .insert({
        org_id: orgA,
        created_by: ownerId,
        provider: "xero",
        entity_type: "invoice",
        entity_id: invId["INV-B"],
      })
      .select("id");
    expect(recB.error, recB.error?.message).toBeNull();

    // Mirror buildAccountingExport's exclusion EXACTLY: read the xero ledger ids
    // (org-pinned + provider-pinned), then drop those invoice ids.
    const ledger = await asOwner
      .from(LEDGER)
      .select("entity_id")
      .eq("org_id", orgA)
      .eq("provider", "xero");
    expect(ledger.error, ledger.error?.message).toBeNull();
    const pushed = new Set((ledger.data ?? []).map((r) => String((r as Row).entity_id)));

    const invRes = await asOwner
      .from("invoices")
      .select("id, number")
      .eq("org_id", orgA)
      .neq("status", "draft");
    expect(invRes.error, invRes.error?.message).toBeNull();
    const surviving = (invRes.data ?? [])
      .filter((r) => !pushed.has(String((r as Row).id)))
      .map((r) => String((r as Row).number));

    expect(surviving).toEqual([`${TOKEN}-INV-C`]);
  });

  it("push-once is PER-PROVIDER: the qbo ledger is independent, so a qbo sync still sees A,B,C", async () => {
    const asOwner = db(userClient(ownerToken));
    const ledger = await asOwner
      .from(LEDGER)
      .select("entity_id")
      .eq("org_id", orgA)
      .eq("provider", "quickbooks");
    expect(ledger.error, ledger.error?.message).toBeNull();
    const pushed = new Set((ledger.data ?? []).map((r) => String((r as Row).entity_id)));

    const invRes = await asOwner.from("invoices").select("id, number").eq("org_id", orgA).neq("status", "draft");
    const surviving = (invRes.data ?? [])
      .filter((r) => !pushed.has(String((r as Row).id)))
      .map((r) => String((r as Row).number))
      .sort();
    expect(surviving).toEqual([`${TOKEN}-INV-A`, `${TOKEN}-INV-B`, `${TOKEN}-INV-C`]);
  });

  // ── 3. ADMIN DELETE resets the high-water-mark (re-sync from zero) ───────────

  it("an ADMIN can DELETE records (disconnect → clean re-sync); a MEMBER cannot", async () => {
    const asMember = db(userClient(memberToken));
    const memberDel = await asMember.from(LEDGER).delete().eq("org_id", orgA);
    // Member delete is refused by RLS: nothing is removed.
    const stillThere = await db(userClient(ownerToken)).from(LEDGER).select("id").eq("org_id", orgA);
    expect((stillThere.data ?? []).length).toBeGreaterThanOrEqual(2);
    void memberDel;

    const asOwner = db(userClient(ownerToken));
    const del = await asOwner.from(LEDGER).delete().eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    const after = await asOwner.from(LEDGER).select("id").eq("org_id", orgA);
    expect(after.data ?? []).toHaveLength(0);
  });
});
