import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * EXPENSE BUDGETS (20261089) — tenant isolation + admin-write, against real
 * Postgres RLS.
 *
 * Proven with a genuine MULTI-ORG user, in the shape of the finance-scoping
 * proof that shipped with the active-org read slices. Two properties:
 *
 *   1. BUDGETS NEVER BLEND. `current_org_ids()` returns EVERY org the viewer
 *      belongs to, so RLS alone is the OUTER boundary, not active-org scoping.
 *      A read pinned to one org returns only that org's target; the unpinned
 *      read (the premise) really would reach both, which is why the app-layer
 *      `.eq("org_id", …)` pin is load-bearing. An outsider sees nothing (RLS).
 *
 *   2. ADMIN-ONLY WRITE. A plain member may READ every target but may not
 *      INSERT, UPDATE or DELETE one, nor set one through the SECURITY INVOKER
 *      RPC — the caller's RLS still applies, so the admins-only policies are the
 *      real authorisation. An owner/admin can.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
};
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const asRpc = (client: unknown) => client as unknown as Rpc;

const TOKEN = `it-eb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("expense budgets · tenant isolation + admin-write", () => {
  let orgA = "";
  let orgB = "";

  let ownerId = "";
  let ownerToken = "";
  let memberId = "";
  let memberToken = "";
  let outsiderToken = "";

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
      .insert({ id, email, full_name: `Expense budgets ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: "Expense Budgets A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "Expense Budgets B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    // A budget in each org, same category, so a blend would be unmistakable.
    for (const [org, pence] of [[orgA, 100000], [orgB, 999999]] as const) {
      const seeded = await svc
        .from("expense_budgets")
        .insert({ org_id: org, category: "materials", amount_pence: pence, period_type: "monthly" })
        .select("id")
        .single();
      expect(seeded.error, seeded.error?.message).toBeNull();
    }

    // Owner of BOTH orgs (makes the blend possible); a plain MEMBER of org A;
    // an outsider in neither.
    const owner = await mintUser("owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    for (const org of [orgA, orgB]) {
      const m = await svc
        .from("memberships")
        .insert({ org_id: org, user_id: ownerId, role: "owner" });
      expect(m.error, m.error?.message).toBeNull();
    }

    const member = await mintUser("member");
    memberId = member.id;
    memberToken = member.token;
    const mm = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: memberId, role: "member" });
    expect(mm.error, mm.error?.message).toBeNull();

    const outsider = await mintUser("outsider");
    outsiderToken = outsider.token;

    if (!ownerToken || !memberToken || !outsiderToken) {
      throw new Error("failed to mint tokens");
    }
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. Budgets never blend ────────────────────────────────────────────────

  it("PREMISE: the owner's UNPINNED read really reaches BOTH orgs' budgets", () => {
    // If this ever returns one row, current_org_ids() changed and the app-layer
    // pin below is no longer load-bearing — revisit the whole overlay.
    return db(userClient(ownerToken))
      .from("expense_budgets")
      .select("org_id, amount_pence")
      .eq("category", "materials")
      .then((res) => {
        expect(res.error, res.error?.message).toBeNull();
        const orgs = new Set((res.data ?? []).map((r) => String(r.org_id)));
        expect(orgs.has(orgA) && orgs.has(orgB)).toBe(true);
      });
  });

  it("SCOPED: a read pinned to org A returns ONLY org A's target", async () => {
    const res = await db(userClient(ownerToken))
      .from("expense_budgets")
      .select("org_id, amount_pence")
      .eq("org_id", orgA)
      .eq("category", "materials");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(String(res.data?.[0]?.org_id)).toBe(orgA);
    expect(Number(res.data?.[0]?.amount_pence)).toBe(100000);
  });

  it("RLS CONTROL: an outsider sees no budgets at all", async () => {
    const res = await db(userClient(outsiderToken))
      .from("expense_budgets")
      .select("id")
      .eq("category", "materials");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  // ── 2. Admin-only write ───────────────────────────────────────────────────

  it("a plain MEMBER may READ the org's targets", async () => {
    const res = await db(userClient(memberToken))
      .from("expense_budgets")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("a plain MEMBER may NOT insert, update or delete a budget", async () => {
    const asMember = db(userClient(memberToken));

    const ins = await asMember
      .from("expense_budgets")
      .insert({ org_id: orgA, category: "fuel", amount_pence: 5000, period_type: "monthly" })
      .select("id");
    // RLS with_check refuses → error, and definitely no new fuel row.
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();

    const upd = await asMember
      .from("expense_budgets")
      .update({ amount_pence: 1 })
      .eq("org_id", orgA)
      .eq("category", "materials");
    // No row matches the member's write policy → zero rows affected.
    expect(upd.count ?? 0).toBe(0);

    const del = await asMember
      .from("expense_budgets")
      .delete()
      .eq("org_id", orgA)
      .eq("category", "materials");
    expect(del.count ?? 0).toBe(0);

    // Org A's materials target is byte-for-byte intact.
    const after = await db(serviceClient())
      .from("expense_budgets")
      .select("amount_pence")
      .eq("org_id", orgA)
      .eq("category", "materials")
      .maybeSingle();
    expect(Number(after.data?.amount_pence)).toBe(100000);
  });

  it("the SECURITY INVOKER RPC still refuses a member (RLS applies)", async () => {
    const res = await asRpc(userClient(memberToken)).rpc("set_expense_budget", {
      p_org_id: orgA,
      p_category: "office",
      p_amount_pence: 4200,
      p_period_type: "monthly",
      p_note: null,
    });
    expect(res.error, "member RPC insert must be refused by RLS").not.toBeNull();
    const check = await db(serviceClient())
      .from("expense_budgets")
      .select("id")
      .eq("org_id", orgA)
      .eq("category", "office");
    expect(check.data ?? []).toHaveLength(0);
  });

  it("an OWNER can set a budget through the RPC, upserting in place", async () => {
    const first = await asRpc(userClient(ownerToken)).rpc("set_expense_budget", {
      p_org_id: orgA,
      p_category: "tools",
      p_amount_pence: 25000,
      p_period_type: "quarterly",
      p_note: "kit fund",
    });
    expect(first.error, first.error?.message).toBeNull();

    // Second call for the same category UPDATES, not duplicates.
    const second = await asRpc(userClient(ownerToken)).rpc("set_expense_budget", {
      p_org_id: orgA,
      p_category: "tools",
      p_amount_pence: 30000,
      p_period_type: "annual",
      p_note: null,
    });
    expect(second.error, second.error?.message).toBeNull();

    const rows = await db(serviceClient())
      .from("expense_budgets")
      .select("amount_pence, period_type")
      .eq("org_id", orgA)
      .eq("category", "tools");
    expect(rows.data ?? []).toHaveLength(1);
    expect(Number(rows.data?.[0]?.amount_pence)).toBe(30000);
    expect(String(rows.data?.[0]?.period_type)).toBe("annual");
  });
});
