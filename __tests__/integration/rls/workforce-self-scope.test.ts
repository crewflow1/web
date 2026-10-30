import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 5 — workforce self-scoping (migration 20261251000000), real JWTs.
 *
 * A staff member reads only their OWN rota_entries / time_entries; owners/admins
 * read everyone's; a worker cannot read another worker's rota/timesheet by
 * changing an identifier; cross-tenant + anon read nothing.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; in(c: string, v: unknown[]): Sel; }
interface Ins extends PromiseLike<Res<null>> { select(c?: string): { single(): PromiseLike<Res<Row>> }; }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());
const TOKEN = `r5p5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
const row: Record<string, { staffA: string; staffB: string; b: string }> = {};

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `P5 ${s}` });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}
const insId = async (table: string, r: Row): Promise<string> =>
  String((await svc().from(table).insert(r).select("id").single()).data?.id ?? "");

const extra: Record<string, Row> = {
  rota_entries: { starts_at: "2026-02-01T08:00:00Z", ends_at: "2026-02-01T16:00:00Z" },
  time_entries: {},
};

describeIntegration("rls · workforce self-scope (20261251 · R5 Phase 5)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `P5 A ${TOKEN}`, slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: `P5 B ${TOKEN}`, slug: `${TOKEN}-b` });
    for (const who of ["owner", "staffA", "staffB", "otherOrg"]) {
      const u = await mkUser(who);
      uid[who] = u.id; tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.owner, role: "owner" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffA, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffB, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.otherOrg, role: "staff" });
    for (const table of ["rota_entries", "time_entries"]) {
      row[table] = {
        staffA: await insId(table, { org_id: orgA, user_id: uid.staffA, ...extra[table] }),
        staffB: await insId(table, { org_id: orgA, user_id: uid.staffB, ...extra[table] }),
        b: await insId(table, { org_id: orgB, user_id: uid.otherOrg, ...extra[table] }),
      };
      if (!row[table]!.staffA || !row[table]!.staffB || !row[table]!.b) throw new Error(`seed ${table}`);
    }
  });

  for (const table of ["rota_entries", "time_entries"]) {
    it(`${table}: a worker reads only their own; owner reads all; cross-worker/tenant/anon denied`, async () => {
      const ids = [row[table]!.staffA, row[table]!.staffB, row[table]!.b];
      const see = async (who: string) => {
        const r = await db(userClient(tok[who] ?? "")).from(table).select("id").in("id", ids);
        expect(r.error, `${who}/${table}: ${r.error?.message}`).toBeNull();
        return new Set((r.data ?? []).map((x) => String(x.id)));
      };
      const owner = await see("owner");
      expect(owner.has(row[table]!.staffA) && owner.has(row[table]!.staffB), "owner sees both workers").toBe(true);
      expect(owner.has(row[table]!.b), "owner never sees org B").toBe(false);

      const a = await see("staffA");
      expect([...a], "staffA sees ONLY their own entry").toEqual([row[table]!.staffA]);

      const b = await see("staffB");
      expect([...b], "staffB sees ONLY their own entry — never staffA's").toEqual([row[table]!.staffB]);

      expect((await see("otherOrg")).has(row[table]!.staffA), "cross-tenant denied").toBe(false);
      const anon = await db(anonClient()).from(table).select("id").in("id", ids);
      expect(anon.data ?? [], "anon denied").toHaveLength(0);
    });
  }
});
