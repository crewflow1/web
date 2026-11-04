import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { loadJobForOrg } from "@/lib/jobs/load";
import { roleCanViewPrivate } from "@/server/auth/financial-visibility";

/**
 * AI Site Manager — job data gate, against real Postgres.
 *
 * The Site Manager's overview tool reads via `loadJobForOrg(userClient(jwt), …)`,
 * exactly the call this test drives through genuine signed-in JWTs. It proves the
 * tool's read boundary is RLS, not application code:
 *   • owner → reads any job in their org.
 *   • assigned staff → reads their assigned job.
 *   • unassigned staff → gets NULL (→ the tool reports "couldn't find that job",
 *     a 404-shaped answer, never a 403 that would confirm the job exists).
 *   • a member of another org → gets NULL for this org's job (cross-tenant).
 *   • anon → NULL.
 * Plus the commercial ROLE gate (`roleCanViewPrivate`) resolves per the seeded
 * membership role — the decision the financial tool makes before any figure.
 *
 * Mirrors __tests__/integration/rls/jobs-assignment-access.test.ts (R5 Phase 2),
 * narrowed to the Site Manager's own entry point.
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

const TOKEN = `sm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const COLS = "id, status, scheduled_date, customer:customers ( name )";

let orgA = "";
let orgB = "";
let jobAssigned = "";
let jobUnassigned = "";
let jobB = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await svc().from("users").insert({ id, email, full_name: `SM ${suffix}` }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
  return { id, token };
}

async function makeOrg(suffix: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `SM ${suffix}`, slug: `${TOKEN}-${suffix}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}
async function member(org: string, userId: string, role: string): Promise<void> {
  const r = await svc().from("memberships").insert({ org_id: org, user_id: userId, role });
  expect(r.error, r.error?.message).toBeNull();
}
async function makeJob(org: string, assignedTo: string | null): Promise<string> {
  const r = await svc().from("jobs").insert({ org_id: org, status: "new", assigned_to: assignedTo }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

const uc = (who: string) => userClient(tok[who] ?? "");
const U = (who: string): string => uid[who] ?? "";
const overview = (who: string, job: string, org: string) =>
  loadJobForOrg(uc(who) as never, job, org, COLS);

describeIntegration("rls · AI site-manager overview tool read gate", () => {
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
    jobB = await makeJob(orgB, U("otherOrg"));

    const ja = await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobAssigned, user_id: U("assigned") });
    expect(ja.error, ja.error?.message).toBeNull();
  });

  it("owner reads any job in their org", async () => {
    expect(await overview("owner", jobAssigned, orgA)).not.toBeNull();
    expect(await overview("owner", jobUnassigned, orgA)).not.toBeNull();
  });

  it("assigned staff reads their assigned job", async () => {
    const job = await overview("assigned", jobAssigned, orgA);
    expect(job).not.toBeNull();
    expect((job as { id: string }).id).toBe(jobAssigned);
  });

  it("unassigned staff gets NULL for an unassigned job (404-shaped, not 403)", async () => {
    expect(await overview("unassigned", jobUnassigned, orgA)).toBeNull();
    // ...and NULL for the assigned job they are not on.
    expect(await overview("unassigned", jobAssigned, orgA)).toBeNull();
  });

  it("a member of another org gets NULL for this org's job (cross-tenant)", async () => {
    expect(await overview("otherOrg", jobAssigned, orgA)).toBeNull();
    // sanity: they DO see their own org's job (not globally denied).
    expect(await overview("otherOrg", jobB, orgB)).not.toBeNull();
  });

  it("anon reads nothing", async () => {
    const job = await loadJobForOrg(anonClient() as never, jobAssigned, orgA, COLS);
    expect(job).toBeNull();
  });

  it("the commercial gate resolves per membership role", () => {
    expect(roleCanViewPrivate("owner")).toBe(true);
    expect(roleCanViewPrivate("admin")).toBe(true);
    expect(roleCanViewPrivate("staff")).toBe(false);
  });
});
