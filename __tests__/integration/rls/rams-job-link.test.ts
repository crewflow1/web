import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * D-16 regression — a RAMS can be linked to a job, and only to a job in the
 * caller's own org. Real Postgres.
 *
 * The bug: no UI ever set risk_assessments.job_id, so the job's Health & safety
 * panel (which reads risk_assessments by job_id) always showed "No issued RAMS".
 * The fix exposes a job picker on the RAMS create form and a "Create RAMS for
 * this job" deep-link. Because risk_assessments→jobs is a BARE FK (not composite
 * org-scoped), the create action also resolves the submitted jobId against the
 * caller's own org before persisting, so a crafted cross-tenant jobId cannot be
 * linked.
 *
 * This pins the two properties the fix relies on:
 *   • READ PATH — a RAMS carrying job_id is returned by the job-scoped,
 *     org-pinned query the job safety panel uses.
 *   • TENANT GUARD — the org-ownership resolve the action performs (select the
 *     job by id AND org under the tenant client) returns the job for its own
 *     org and NULL for another tenant's job, so job_id is never set cross-org.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());

const TOKEN = `rjl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let orgA = "", orgB = "", ownerAToken = "", jobA = "", jobB = "", ramsA = "";

async function makeUser(s: string) {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `RJL ${s}` });
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  return { id, token: signedIn.data.session?.access_token ?? "" };
}
async function makeOrg(s: string) {
  const r = await svc().from("organizations").insert({ name: `RJL ${s}`, slug: `${TOKEN}-${s}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

/** Mirror of the server action's resolveOrgJobId: tenant client, id AND org. */
async function resolveOrgJobId(token: string, jobId: string, orgId: string): Promise<string | null> {
  const r = await db(userClient(token))
    .from("jobs").select("id").eq("id", jobId).eq("org_id", orgId).maybeSingle();
  return (r.data as { id: string } | null)?.id ?? null;
}

describeIntegration("rls · RAMS job link + cross-tenant guard (D-16)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    const ownerA = await makeUser("ownerA");
    ownerAToken = ownerA.token;
    await svc().from("memberships").insert({ org_id: orgA, user_id: ownerA.id, role: "owner" });

    const ja = await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    jobA = (ja.data as { id: string }).id;
    const jb = await svc().from("jobs").insert({ org_id: orgB, status: "new" }).select("id").single();
    jobB = (jb.data as { id: string }).id;

    const ra = await svc().from("risk_assessments").insert({
      org_id: orgA, job_id: jobA, title: "Groundworks", activity: "Excavation", status: "draft",
    }).select("id").single();
    expect(ra.error, ra.error?.message).toBeNull();
    ramsA = (ra.data as { id: string }).id;
  });

  it("READ PATH: the job safety query (by job_id, org-pinned) returns the linked RAMS", async () => {
    const r = await db(userClient(ownerAToken))
      .from("risk_assessments").select("id, job_id").eq("job_id", jobA).eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    const ids = ((r.data ?? []) as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(ramsA);
  });

  it("TENANT GUARD: resolves own-org job to its id (so the link is persisted)", async () => {
    expect(await resolveOrgJobId(ownerAToken, jobA, orgA)).toBe(jobA);
  });

  it("TENANT GUARD: resolves another tenant's job to NULL (so job_id is never set cross-org)", async () => {
    expect(await resolveOrgJobId(ownerAToken, jobB, orgA)).toBeNull();
  });
});
