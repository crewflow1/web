import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 3 (slice 1) — operational child-table assignment-aware SELECT
 * (migration 20261244000000), against real Postgres with real signed-in JWTs.
 *
 * For each operational child table, a row on an ASSIGNED job is visible to the
 * assigned staff member; a row on an UNASSIGNED job is not; owners and admins
 * see both; a staff member of another org sees neither; anon sees nothing.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  in(c: string, v: unknown[]): Sel;
}
interface Ins extends PromiseLike<Res<null>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());

const TOKEN = `r5p3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// The first-slice operational child tables + their extra required columns.
const TABLES: { name: string; extra: () => Row }[] = [
  { name: "snags", extra: () => ({ title: "Snag" }) },
  { name: "site_diary_entries", extra: () => ({}) },
  { name: "site_reports", extra: () => ({ title: "Report", period_start: "2026-01-01", period_end: "2026-01-07" }) },
  { name: "job_progress_observations", extra: () => ({ percent: 50, observed_on: "2026-01-01" }) },
  { name: "job_checklists", extra: () => ({ label: "Task", sort: 1 }) },
];

let orgA = "";
let orgB = "";
let jobAssigned = ""; // orgA, assigned to `assigned`
let jobUnassigned = ""; // orgA, no assignee
let jobB = ""; // orgB
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};
const uc = (who: string) => userClient(tok[who] ?? "");
const U = (who: string): string => uid[who] ?? "";
// ids[table] = { assigned, unassigned, b }
const ids: Record<string, { assigned: string; unassigned: string; b: string }> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirror = await svc().from("users").insert({ id, email, full_name: `R5P3 ${suffix}` }).select("id").single();
  expect(mirror.error, mirror.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint failed ${suffix}`);
  return { id, token };
}
async function makeOrg(suffix: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `R5P3 ${suffix}`, slug: `${TOKEN}-${suffix}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String((r.data as { id: string }).id);
}
async function member(org: string, userId: string, role: string) {
  const r = await svc().from("memberships").insert({ org_id: org, user_id: userId, role });
  expect(r.error, r.error?.message).toBeNull();
}
async function makeJob(org: string, assignedTo: string | null): Promise<string> {
  const r = await svc().from("jobs").insert({ org_id: org, status: "new", assigned_to: assignedTo }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String((r.data as { id: string }).id);
}
async function seedChild(table: string, org: string, job: string, extra: Row): Promise<string> {
  const r = await svc().from(table).insert({ org_id: org, job_id: job, ...extra }).select("id").single();
  expect(r.error, `${table}: ${r.error?.message}`).toBeNull();
  return String((r.data as { id: string }).id);
}
async function visible(who: string, table: string): Promise<Set<string>> {
  const all = [ids[table]!.assigned, ids[table]!.unassigned, ids[table]!.b];
  const res = await db(uc(who)).from(table).select("id").in("id", all);
  expect(res.error, `${who}/${table}: ${res.error?.message}`).toBeNull();
  return new Set((res.data ?? []).map((r) => String(r.id)));
}

describeIntegration("rls · operational child tables assignment-aware (20261244 · R5 Phase 3)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("orgA");
    orgB = await makeOrg("orgB");
    for (const who of ["owner", "admin", "assigned", "unassigned", "otherOrg"]) {
      const u = await makeUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }
    await member(orgA, U("owner"), "owner");
    await member(orgA, U("admin"), "admin");
    await member(orgA, U("assigned"), "staff");
    await member(orgA, U("unassigned"), "staff");
    await member(orgB, U("otherOrg"), "staff");

    jobAssigned = await makeJob(orgA, null);
    jobUnassigned = await makeJob(orgA, null);
    jobB = await makeJob(orgB, null);
    const ja = await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobAssigned, user_id: U("assigned") });
    expect(ja.error, ja.error?.message).toBeNull();

    for (const { name, extra } of TABLES) {
      ids[name] = {
        assigned: await seedChild(name, orgA, jobAssigned, extra()),
        unassigned: await seedChild(name, orgA, jobUnassigned, extra()),
        b: await seedChild(name, orgB, jobB, extra()),
      };
    }
  });

  for (const { name } of TABLES) {
    it(`${name}: owner/admin see both A rows; assigned sees only its job; unassigned/other/anon see none`, async () => {
      const a = ids[name]!.assigned;
      const u = ids[name]!.unassigned;
      const b = ids[name]!.b;

      const owner = await visible("owner", name);
      expect(owner.has(a) && owner.has(u)).toBe(true);
      expect(owner.has(b)).toBe(false); // org pin — never org B

      const admin = await visible("admin", name);
      expect(admin.has(a) && admin.has(u)).toBe(true);

      const assigned = await visible("assigned", name);
      expect([...assigned]).toEqual([a]); // ONLY the assigned-job row

      const unassigned = await visible("unassigned", name);
      expect(unassigned.size).toBe(0); // a seat without assignment sees nothing

      const other = await visible("otherOrg", name);
      expect(other.has(a) || other.has(u)).toBe(false); // cross-tenant denied

      const res = await db(anonClient()).from(name).select("id").in("id", [a, u, b]);
      expect(res.data ?? []).toHaveLength(0); // anon sees nothing
    });
  }
});
