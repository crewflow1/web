import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * QUOTE AUTHZ against real Postgres — ADMIN-ONLY model (migration 20261278000000).
 *
 * PRODUCT DECISION (D-13, founder-approved 2026-11-02): quotes + quote_line_items
 * are owner/admin only. Ordinary staff must not read, create, edit or delete
 * quotes via the UI, PostgREST, APIs or RPCs. (This supersedes the earlier model
 * in which staff could draft/send quotes at the RLS layer with only the approval
 * transition trigger-gated — that staff access is deliberately NOT preserved.)
 *
 * This file proves the DB boundary with real JWTs:
 *   - an ADMIN reads quotes and performs the full lifecycle (draft → pending →
 *     approved → sent);
 *   - STAFF cannot READ / INSERT / UPDATE / DELETE quotes (RLS: 0 rows or 42501);
 *   - quote_line_items follow quotes (admin reads, staff sees nothing);
 *   - customer-accept via the SERVICE-ROLE client still succeeds (portal path is
 *     RLS-exempt).
 *
 * The enforce_quote_approval_authz trigger remains as defence-in-depth, but
 * admin-only RLS is now the primary gate (it denies non-admins before the
 * trigger runs). Cross-org + revoked-user negatives live in the dedicated
 * `quotes-admin-only-scope.test.ts`.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-qauthz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("quote approval authz · DB-layer owner/admin gate", () => {
  let orgA = "";
  let customerA = "";
  let adminId = "";
  let adminToken = "";
  let staffId = "";
  let staffToken = "";
  let quoteSeq = 0;

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `QAuthz ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  /** Seed a quote via service_role (bypasses the trigger — it's exempt). */
  async function seedQuote(overrides: Row = {}): Promise<string> {
    quoteSeq += 1;
    const r = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-Q${quoteSeq}`,
        status: "draft",
        ...overrides,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function statusOf(id: string): Promise<string> {
    const r = await svc().from("quotes").select("status").eq("id", id).maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.status ?? "");
  }

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "QAuthz Probe", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgA = String(org.data?.id ?? "");

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: "QAuthz Customer" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    customerA = String(cust.data?.id ?? "");

    const admin = await makeUser("admin");
    adminId = admin.id;
    adminToken = admin.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    // Admin of org A (is_org_admin → true), plain staff of org A (member: passes
    // RLS UPDATE, so the trigger — not RLS — is what refuses the manager acts).
    const am = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: adminId, role: "admin" })
      .select("user_id")
      .single();
    expect(am.error, am.error?.message).toBeNull();
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (orgA) {
      const del = await svc().from("organizations").delete().eq("id", orgA);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
    for (const id of [adminId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── Admin-only model (D-13, founder-approved): quotes are owner/admin only.
  // Ordinary staff cannot read/create/edit/delete quotes via PostgREST; the
  // customer-portal (service-role) and the owner/admin lifecycle are preserved.
  // The enforce_quote_approval_authz trigger remains as defence-in-depth, but
  // admin-only RLS now fires first for non-admins.

  it("an ADMIN can read quotes", async () => {
    const id = await seedQuote();
    const r = await db(userClient(adminToken)).from("quotes").select("id").eq("id", id);
    expect((r.data ?? []).map((x) => String((x as Row).id))).toContain(id);
  });

  it("an ADMIN performs the full lifecycle: draft → pending → approved → sent", async () => {
    const id = await seedQuote();
    const a = db(userClient(adminToken));
    expect((await a.from("quotes").update({ status: "pending_approval" }).eq("id", id)).error).toBeNull();
    expect(await statusOf(id)).toBe("pending_approval");
    expect((await a.from("quotes").update({ status: "approved", approved_by: adminId, approved_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect(await statusOf(id)).toBe("approved");
    expect((await a.from("quotes").update({ status: "sent" }).eq("id", id)).error).toBeNull();
    expect(await statusOf(id)).toBe("sent");
  });

  it("STAFF cannot READ quotes (0 rows)", async () => {
    const id = await seedQuote();
    const r = await db(userClient(staffToken)).from("quotes").select("id").eq("id", id);
    expect(r.data ?? []).toHaveLength(0);
  });

  it("STAFF cannot INSERT a quote (RLS 42501)", async () => {
    const r = await db(userClient(staffToken))
      .from("quotes")
      .insert({ org_id: orgA, customer_id: customerA, number: `${TOKEN}-STAFF-INS`, status: "draft" })
      .select("id")
      .single();
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  });

  it("STAFF cannot UPDATE a quote (0 rows — status unchanged)", async () => {
    const id = await seedQuote();
    await db(userClient(staffToken)).from("quotes").update({ status: "sent", notes: "sneaky" }).eq("id", id);
    expect(await statusOf(id)).toBe("draft");
  });

  it("STAFF cannot DELETE a quote (it remains)", async () => {
    const id = await seedQuote();
    await db(userClient(staffToken)).from("quotes").delete().eq("id", id);
    expect(await statusOf(id)).toBe("draft");
  });

  it("quote_line_items: ADMIN reads, STAFF reads nothing", async () => {
    const id = await seedQuote();
    const ins = await svc().from("quote_line_items").insert({ org_id: orgA, quote_id: id, description: "Item" }).select("id").single();
    expect(ins.error, JSON.stringify(ins.error)).toBeNull();
    const adminRows = await db(userClient(adminToken)).from("quote_line_items").select("id").eq("quote_id", id);
    expect((adminRows.data ?? []).length).toBeGreaterThan(0);
    const staffRows = await db(userClient(staffToken)).from("quote_line_items").select("id").eq("quote_id", id);
    expect(staffRows.data ?? []).toHaveLength(0);
  });

  it("customer-accept via SERVICE ROLE still succeeds (portal path, RLS-exempt)", async () => {
    const id = await seedQuote({ status: "sent", approved_by: adminId });
    const r = await svc().from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", id);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(await statusOf(id)).toBe("accepted");
  });
});
