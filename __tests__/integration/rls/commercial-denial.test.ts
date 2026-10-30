import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 4 (slice 1) — commercial/financial read DENIAL for staff
 * (migration 20261250000000), against real Postgres with real JWTs.
 *
 * Commercial data is barred from staff REGARDLESS of assignment: owners/admins
 * read it; staff read NONE of it; cross-tenant and anon read none. Representative
 * tables across the 8 narrowed in this slice (pg_policies confirms all 8 carry a
 * single admin-only SELECT policy); the behaviour is identical for each.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; in(c: string, v: unknown[]): Sel; }
interface Ins extends PromiseLike<Res<null>> { select(c?: string): { single(): PromiseLike<Res<Row>> }; }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());
const TOKEN = `r5p4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "", jobA = "", jobB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
// per-table: the orgA row id + the orgB row id
const rowA: Record<string, string> = {};
const rowB: Record<string, string> = {};

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `P4 ${s}` });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}
const insId = async (table: string, row: Row): Promise<string> =>
  String((await svc().from(table).insert(row).select("id").single()).data?.id ?? "");

// Minimal seed per table, parameterised by org + job.
const SEEDS: { table: string; row: (org: string, job: string) => Row }[] = [
  { table: "job_budgets", row: (org, job) => ({ org_id: org, job_id: job, total_cost: 1000 }) },
  { table: "job_valuations", row: (org, job) => ({ org_id: org, job_id: job, sequence: 1 }) },
  { table: "purchase_orders", row: (org) => ({ org_id: org, number: `PO-${TOKEN}-${Math.random().toString(36).slice(2, 7)}` }) },
  { table: "review_requests", row: (org) => ({ org_id: org, platform: "google", send_at: new Date().toISOString() }) },
  { table: "finances", row: (org, job) => ({ org_id: org, job_id: job, amount: 1000 }) },
];

describeIntegration("rls · commercial denial (20261250 · R5 Phase 4)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `P4 A ${TOKEN}`, slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: `P4 B ${TOKEN}`, slug: `${TOKEN}-b` });
    for (const who of ["owner", "admin", "staff", "otherOrg"]) {
      const u = await mkUser(who);
      uid[who] = u.id; tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.owner, role: "owner" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.admin, role: "admin" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staff, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.otherOrg, role: "owner" });
    jobA = await insId("jobs", { org_id: orgA, status: "new" });
    jobB = await insId("jobs", { org_id: orgB, status: "new" });
    // Even assign the staff to jobA — commercial denial is assignment-INDEPENDENT.
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobA, user_id: uid.staff });
    for (const { table, row } of SEEDS) {
      rowA[table] = await insId(table, row(orgA, jobA));
      rowB[table] = await insId(table, row(orgB, jobB));
      if (!rowA[table] || !rowB[table]) throw new Error(`seed failed ${table}`);
    }
  });

  for (const { table } of SEEDS) {
    it(`${table}: owner/admin read the org row; staff (even assigned) + cross-tenant + anon are denied`, async () => {
      const ids = [rowA[table]!, rowB[table]!];
      const see = async (who: string) => {
        const r = await db(userClient(tok[who] ?? "")).from(table).select("id").in("id", ids);
        expect(r.error, `${who}/${table}: ${r.error?.message}`).toBeNull();
        return new Set((r.data ?? []).map((x) => String(x.id)));
      };
      expect((await see("owner")).has(rowA[table]!), "owner sees the org-A row").toBe(true);
      expect((await see("admin")).has(rowA[table]!), "admin sees the org-A row").toBe(true);
      expect((await see("owner")).has(rowB[table]!), "owner never sees org B").toBe(false);

      expect((await see("staff")).size, "staff (even assigned to the job) sees NO commercial rows").toBe(0);
      expect((await see("otherOrg")).has(rowA[table]!), "cross-tenant denied").toBe(false);

      const anon = await db(anonClient()).from(table).select("id").in("id", ids);
      expect(anon.data ?? [], "anon denied").toHaveLength(0);
    });
  }

  it("finances: a non-admin member can STILL INSERT a cost (member-open entry preserved)", async () => {
    // Regression for the review BLOCKER: narrowing finances SELECT to is_org_admin
    // must NOT break member-open cost entry. The INSERT policy is unchanged; the
    // route mints its own id and skips RETURNING, so a staff insert succeeds even
    // though the staff member cannot read the ledger back.
    const id = crypto.randomUUID();
    const ins = await (db(userClient(tok.staff ?? "")) as unknown as {
      from(t: string): { insert(r: Row): PromiseLike<{ error: { message: string } | null }> };
    }).from("finances").insert({ id, org_id: orgA, amount: 250, job_id: jobA });
    expect(ins.error, `staff cost entry must succeed: ${ins.error?.message}`).toBeNull();
    // ...but the staff member still cannot SELECT it back (ledger stays hidden).
    const staffRead = await db(userClient(tok.staff ?? "")).from("finances").select("id").in("id", [id]);
    expect(staffRead.data ?? [], "staff still cannot read the cost they entered").toHaveLength(0);
  });
});
