import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * D-17 regression — "My jobs" + the clock-in picker must honour BOTH assignment
 * stores, against real Postgres.
 *
 * The bug: `/me` ("My jobs" + the clock-in job picker) read the legacy
 * jobs.assigned_to column directly, so a worker assigned through the job page's
 * "Assigned team" panel — which writes the service-role-only job_assignments
 * table — saw "No jobs assigned to you" and could only clock in against
 * "general work", never their actual job.
 *
 * The fix makes `/me` source its jobs from my_assigned_job_ids(), the SAME
 * STABLE SECURITY DEFINER the jobs RLS uses. This test pins that function's
 * contract so a future edit can't silently drop either store:
 *   • a job assigned ONLY via job_assignments (crew panel) is returned;
 *   • a job assigned ONLY via the legacy jobs.assigned_to is returned;
 *   • a job in my org I'm NOT assigned to is NOT returned;
 *   • another tenant's job is never returned.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const rpc = (c: unknown) =>
  c as unknown as { rpc(fn: string): PromiseLike<Res<string[]>> };

const TOKEN = `maj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let orgA = "", orgB = "";
let jobCrewOnly = "", jobLegacyOnly = "", jobUnassigned = "", jobOtherOrg = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(s: string) {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `MAJ ${s}` });
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  return { id, token: signedIn.data.session?.access_token ?? "" };
}
async function makeOrg(s: string) {
  const r = await svc().from("organizations").insert({ name: `MAJ ${s}`, slug: `${TOKEN}-${s}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}
async function makeJob(orgId: string, extra: Record<string, unknown> = {}) {
  const r = await svc().from("jobs").insert({ org_id: orgId, status: "new", ...extra }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}
async function assignedIds(who: string): Promise<string[]> {
  const res = await rpc(userClient(tok[who] ?? "")).rpc("my_assigned_job_ids");
  expect(res.error, `${who}: ${res.error?.message}`).toBeNull();
  return (res.data ?? []).map(String);
}

describeIntegration("rls · my_assigned_job_ids unions crew + legacy assignment (D-17)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    const worker = await makeUser("worker");
    const other = await makeUser("other");
    uid.worker = worker.id; tok.worker = worker.token;
    uid.other = other.id; tok.other = other.token;

    await svc().from("memberships").insert({ org_id: orgA, user_id: worker.id, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: other.id, role: "owner" });

    // Crew-only: assigned via job_assignments, jobs.assigned_to stays null.
    jobCrewOnly = await makeJob(orgA);
    await svc().from("job_assignments").insert({ org_id: orgA, job_id: jobCrewOnly, user_id: worker.id });

    // Legacy-only: assigned via jobs.assigned_to, no job_assignments row.
    jobLegacyOnly = await makeJob(orgA, { assigned_to: worker.id });

    // In my org, but not mine.
    jobUnassigned = await makeJob(orgA);

    // Another tenant's job, assigned to a different user there.
    jobOtherOrg = await makeJob(orgB);
    await svc().from("job_assignments").insert({ org_id: orgB, job_id: jobOtherOrg, user_id: other.id });
  });

  it("returns a job assigned ONLY via the crew panel (job_assignments)", async () => {
    expect(await assignedIds("worker")).toContain(jobCrewOnly);
  });

  it("returns a job assigned ONLY via the legacy jobs.assigned_to column", async () => {
    expect(await assignedIds("worker")).toContain(jobLegacyOnly);
  });

  it("does NOT return an org job the worker is not assigned to", async () => {
    expect(await assignedIds("worker")).not.toContain(jobUnassigned);
  });

  it("never returns another tenant's job", async () => {
    const mine = await assignedIds("worker");
    expect(mine).not.toContain(jobOtherOrg);
  });
});
