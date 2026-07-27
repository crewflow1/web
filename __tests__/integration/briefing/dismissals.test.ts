import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Daily Briefing — briefing_dismissals RLS boundary (real Postgres).
 *   - a user manages ONLY their own dismissals (per-user, not org-wide);
 *   - a member cannot write on behalf of another user or into another tenant;
 *   - anon is denied entirely;
 *   - the unique constraint makes "dismiss for today" idempotent.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del { eq(c: string, v: unknown): Del & PromiseLike<Res<null>> }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; delete(): Del }
const db = (c: unknown) => c as unknown as { from(t: string): Table };
const T = `it-brief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = "2026-07-26";

describeIntegration("Briefing dismissals RLS (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let a1 = { id: "", token: "" };
  let a2 = { id: "", token: "" };
  let b1 = { id: "", token: "" };
  const svc = () => db(serviceClient());

  async function mkMember(orgId: string, tag: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role: "admin" });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(`signIn ${tag}: ${s.error.message}`);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "BRIEF A", slug: `${T}-a` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc().from("organizations").insert({ name: "BRIEF B", slug: `${T}-b` }).select("id").single()).data?.id ?? "");
    if (!orgA || !orgB) throw new Error("fixture org setup failed");
    a1 = await mkMember(orgA, "a1");
    a2 = await mkMember(orgA, "a2");
    b1 = await mkMember(orgB, "b1");
    if (!a1.token || !a2.token || !b1.token) throw new Error("member tokens missing");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [a1, a2, b1]) if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
  });

  it("a member can create and read their OWN dismissal", async () => {
    const ins = await db(userClient(a1.token)).from("briefing_dismissals").insert({
      org_id: orgA, user_id: a1.id, item_key: "overdue_invoices", dismissed_on: DAY,
    }).select("id").single();
    expect(ins.error, ins.error?.message).toBeNull();

    const sel = await db(userClient(a1.token)).from("briefing_dismissals").select("item_key").eq("dismissed_on", DAY);
    expect((sel.data ?? []).map((r) => r.item_key)).toContain("overdue_invoices");
  });

  it("another member of the SAME org cannot see it (per-user, not org-wide)", async () => {
    const sel = await db(userClient(a2.token)).from("briefing_dismissals").select("item_key").eq("dismissed_on", DAY);
    expect(sel.error, sel.error?.message).toBeNull();
    expect((sel.data ?? []).length).toBe(0);
  });

  it("a member cannot dismiss on behalf of ANOTHER user (user_id pinned to auth.uid())", async () => {
    const bad = await db(userClient(a1.token)).from("briefing_dismissals").insert({
      org_id: orgA, user_id: a2.id, item_key: "leads_cold", dismissed_on: DAY,
    }).select("id").single();
    expect(bad.error, "insert impersonating another user must be RLS-denied").not.toBeNull();
  });

  it("a member cannot write into ANOTHER tenant (org_id ∈ current_org_ids())", async () => {
    const bad = await db(userClient(b1.token)).from("briefing_dismissals").insert({
      org_id: orgA, user_id: b1.id, item_key: "overdue_invoices", dismissed_on: DAY,
    }).select("id").single();
    expect(bad.error, "cross-tenant dismissal must be RLS-denied").not.toBeNull();
  });

  it("a member cannot delete another user's dismissal", async () => {
    await db(userClient(a2.token)).from("briefing_dismissals").delete().eq("user_id", a1.id).eq("dismissed_on", DAY);
    // A1's row must still be there (A2's delete matched no rows it's allowed to touch).
    const still = await db(userClient(a1.token)).from("briefing_dismissals").select("item_key").eq("dismissed_on", DAY);
    expect((still.data ?? []).map((r) => r.item_key)).toContain("overdue_invoices");
  });

  it("anon cannot read dismissals at all", async () => {
    const sel = await db(anonClient()).from("briefing_dismissals").select("item_key").eq("dismissed_on", DAY);
    expect((sel.data ?? []).length).toBe(0);
  });

  it("the same dismissal twice is idempotent at the DB (unique constraint)", async () => {
    const dupe = await svc().from("briefing_dismissals").insert({
      org_id: orgA, user_id: a1.id, item_key: "overdue_invoices", dismissed_on: DAY,
    }).select("id").single();
    expect(dupe.error?.message ?? "", "duplicate dismissal must violate the unique constraint").toMatch(/duplicate|unique|23505/i);

    // A user CAN delete their own dismissal (the undo path).
    const del = await db(userClient(a1.token)).from("briefing_dismissals").delete().eq("item_key", "overdue_invoices").eq("dismissed_on", DAY);
    expect(del.error, del.error?.message).toBeNull();
    const after = await db(userClient(a1.token)).from("briefing_dismissals").select("item_key").eq("dismissed_on", DAY);
    expect((after.data ?? []).length).toBe(0);
  });
});
