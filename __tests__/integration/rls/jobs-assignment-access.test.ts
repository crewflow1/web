import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * R5 Phase 2 — jobs PARENT assignment-aware SELECT (migration 20261243000000),
 * against real Postgres.
 *
 * Proves the enforcing step of R5 at the database, through real signed-in user
 * JWTs (not the service role):
 *   • owner  → sees EVERY job in their org (assigned or not).
 *   • admin  → sees EVERY job in their org.
 *   • staff assigned via the Phase-1 job_assignments table → sees ONLY that job.
 *   • staff assigned via the legacy jobs.assigned_to column → sees ONLY that job.
 *   • staff with membership but NO assignment → sees NOTHING (a seat/rota does
 *     not grant job access — only an explicit assignment does).
 *   • a staff member of another org → sees none of this org's jobs.
 *   • anon → sees nothing.
 *
 * The owner case is the lockout guard: the policy must never deny an owner a job
 * in their own org.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<null>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());

const TOKEN = `r5p2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let orgA = "";
let orgB = "";
let jobAssigned = ""; // in A, assigned to staffAssigned via job_assignments
let jobLegacy = ""; //   in A, assigned to staffLegacy via jobs.assigned_to
let jobUnassigned = ""; // in A, no assignee
let jobB = ""; //         in B

const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await svc().from("users").insert({ id, email, full_name: `R5P2 ${suffix}` }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
  return { id, token };
}

async function makeOrg(suffix: string): Promise<string> {
  const r = await svc()
    .from("organizations")
    .insert({ name: `R5P2 ${suffix}`, slug: `${TOKEN}-${suffix}` })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

async function member(org: string, userId: string, role: string): Promise<void> {
  const r = await svc().from("memberships").insert({ org_id: org, user_id: userId, role });
  expect(r.error, r.error?.message).toBeNull();
}

async function makeJob(org: string, assignedTo: string | null): Promise<string> {
  const r = await svc()
    .from("jobs")
    .insert({ org_id: org, status: "new", assigned_to: assignedTo })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

const uc = (who: string) => userClient(tok[who] ?? "");
const U = (who: string): string => uid[who] ?? "";

async function idsFor(who: string): Promise<Set<string>> {
  const res = await db(uc(who)).from("jobs").select("id").eq("org_id", orgA);
  expect(res.error, `${who}: ${res.error?.message}`).toBeNull();
  return new Set((res.data ?? []).map((r) => String(r.id)));
}

describeIntegration("rls · jobs assignment-aware SELECT (20261243 · R5 Phase 2)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("orgA");
    orgB = await makeOrg("orgB");

    for (const who of ["owner", "admin", "assigned", "legacy", "unassigned", "otherOrg"]) {
      const u = await makeUser(who);
      uid[who] = u.id;
      tok[who] = u.token;
    }

    await member(orgA, U("owner"), "owner");
    await member(orgA, U("admin"), "admin");
    await member(orgA, U("assigned"), "staff");
    await member(orgA, U("legacy"), "staff");
    await member(orgA, U("unassigned"), "staff");
    await member(orgB, U("otherOrg"), "staff");

    // A-org jobs: one assigned via the join table, one via the legacy column, one unassigned.
    jobAssigned = await makeJob(orgA, null);
    jobLegacy = await makeJob(orgA, U("legacy")); // legacy single-assignee column
    jobUnassigned = await makeJob(orgA, null);
    // Assigned to otherOrg so the cross-tenant test can also prove they are NOT
    // globally denied — a staff member sees their OWN assigned job, just not
    // another tenant's jobs.
    jobB = await makeJob(orgB, U("otherOrg"));

    // Phase-1 multi-worker assignment (no legacy assigned_to on this job).
    const ja = await svc()
      .from("job_assignments")
      .insert({ org_id: orgA, job_id: jobAssigned, user_id: U("assigned") });
    expect(ja.error, ja.error?.message).toBeNull();
  });

  it("owner sees EVERY job in their org (lockout guard)", async () => {
    const seen = await idsFor("owner");
    expect(seen.has(jobAssigned)).toBe(true);
    expect(seen.has(jobLegacy)).toBe(true);
    expect(seen.has(jobUnassigned)).toBe(true);
    expect(seen.size).toBe(3);
  });

  it("admin sees EVERY job in their org", async () => {
    const seen = await idsFor("admin");
    expect(seen.size).toBe(3);
    expect(seen.has(jobUnassigned)).toBe(true);
  });

  it("staff assigned via job_assignments sees ONLY that job", async () => {
    const seen = await idsFor("assigned");
    expect([...seen]).toEqual([jobAssigned]);
  });

  it("staff assigned via legacy jobs.assigned_to sees ONLY that job", async () => {
    const seen = await idsFor("legacy");
    expect([...seen]).toEqual([jobLegacy]);
  });

  it("staff with a seat but NO assignment sees NOTHING (rota/seat grants nothing)", async () => {
    const seen = await idsFor("unassigned");
    expect(seen.size).toBe(0);
  });

  it("by-id deep link: assigned staff CAN read their assigned job, unassigned CANNOT", async () => {
    // The app reads jobs/[id] by id; prove the policy holds on the single-row path.
    const ok = await db(uc("assigned")).from("jobs").select("id").eq("id", jobAssigned);
    expect(ok.error, ok.error?.message).toBeNull();
    expect((ok.data ?? []).map((r) => String(r.id))).toEqual([jobAssigned]);

    const denied = await db(uc("unassigned")).from("jobs").select("id").eq("id", jobUnassigned);
    expect(denied.error, denied.error?.message).toBeNull();
    expect(denied.data ?? [], "unassigned staff by-id read must be empty (→ 404, not 403)").toHaveLength(0);
  });

  it("a staff member of another org sees none of this org's jobs", async () => {
    const seen = await idsFor("otherOrg");
    expect(seen.size).toBe(0);
    // ...and does see their own org's job (sanity: not globally denied).
    const own = await db(uc("otherOrg")).from("jobs").select("id").eq("org_id", orgB);
    expect(own.error, own.error?.message).toBeNull();
    expect(new Set((own.data ?? []).map((r) => String(r.id))).has(jobB)).toBe(true);
  });

  it("anon sees nothing", async () => {
    const res = await db(anonClient()).from("jobs").select("id").eq("org_id", orgA);
    expect(res.data ?? []).toHaveLength(0);
  });
});
