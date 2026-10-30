import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Job-assignment reconciliation — the two transactional RPCs (20261246000000)
 * that make jobs.assigned_to (the legacy "primary") and job_assignments (the
 * crew) one coherent model instead of independent writes that can drift.
 *
 * Founder-confirmed semantics proven here against REAL Postgres:
 *   • set_job_primary_assignment sets the primary AND places the new primary on
 *     the crew, and when the primary CHANGES it preserves the OUTGOING primary on
 *     the crew — reassigning the lead never silently strips the old lead's access.
 *   • remove_job_worker revokes EVERY path atomically — the crew row is deleted
 *     AND jobs.assigned_to is nulled if it pointed at the removed worker. No stale
 *     assignment survives a removal.
 *   • Both are owner/admin-only, org-pinned, and reject non-members as primary.
 *   • Under concurrency the unique(job_id,user_id) + on-conflict-do-nothing path
 *     yields exactly one crew row and a consistent final state (no lost rows).
 *
 * On this branch the two access paths ARE this state (jobs.assigned_to + the
 * job_assignments rows); the RLS CONSUMPTION of that state (the my_assigned_job_ids
 * union → child visibility) is exercised by the R5 Phase 3 suite. Here we assert
 * ground truth via the service client, which is the complete picture of "every
 * path" at this layer.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del { eq(c: string, v: unknown): PromiseLike<Res<null>> }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
type Rpc = (fn: string, args: Row) => PromiseLike<Res<unknown>>;
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc: Rpc };
const TOKEN = `it-asgn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const insId = async (svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> =>
  String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

async function mkUser(email: string, role: string, orgId: string): Promise<{ id: string; token: string }> {
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${email}`);
  return { id, token };
}

describeIntegration("job assignment reconciliation · transactional RPCs", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "";
  let admin = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let workerW = { id: "", token: "" };
  let workerX = { id: "", token: "" };
  let outsider = { id: "", token: "" }; // owner of orgB, member of NO orgA

  // A fresh, unassigned job in orgA — each scenario gets its own so state never
  // leaks between tests.
  const freshJob = () => insId(svc, "jobs", { org_id: orgA, status: "in-progress" });

  const crew = async (jobId: string): Promise<string[]> => {
    const r = await svc.from("job_assignments").select("user_id").eq("job_id", jobId);
    return (r.data ?? []).map((row) => String(row.user_id)).sort();
  };
  const primary = async (jobId: string): Promise<string | null> => {
    const r = await svc.from("jobs").select("assigned_to").eq("id", jobId);
    const v = r.data?.[0]?.assigned_to;
    return v == null ? null : String(v);
  };
  const setPrimary = (client: { rpc: Rpc }, jobId: string, orgId: string, to: string | null) =>
    client.rpc("set_job_primary_assignment", { p_job_id: jobId, p_org_id: orgId, p_assigned_to: to });
  const removeWorker = (client: { rpc: Rpc }, jobId: string, orgId: string, userId: string) =>
    client.rpc("remove_job_worker", { p_job_id: jobId, p_org_id: orgId, p_user_id: userId });

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Asgn A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Asgn B", slug: `${TOKEN}-b` });
    if (!orgA || !orgB) throw new Error("fixture org setup failed");
    admin = await mkUser(`${TOKEN}-adm@example.test`, "owner", orgA);
    staff = await mkUser(`${TOKEN}-staff@example.test`, "staff", orgA);
    workerW = await mkUser(`${TOKEN}-w@example.test`, "staff", orgA);
    workerX = await mkUser(`${TOKEN}-x@example.test`, "staff", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);
  });

  afterAll(async () => {
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    for (const u of [admin.id, staff.id, workerW.id, workerX.id, outsider.id]) {
      if (u) await serviceClient().auth.admin.deleteUser(u);
    }
  });

  it("RULE 1: reassigning the primary preserves the previous primary on the crew", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));

    const first = await setPrimary(asAdmin, job, orgA, workerW.id);
    expect(first.error, "admin sets the primary").toBeNull();
    expect(await primary(job)).toBe(workerW.id);
    expect(await crew(job)).toEqual([workerW.id]);

    // Reassign to X — W must NOT be dropped from the crew.
    const second = await setPrimary(asAdmin, job, orgA, workerX.id);
    expect(second.error, "admin reassigns the primary").toBeNull();
    expect(await primary(job), "jobs.assigned_to now points at the new primary").toBe(workerX.id);
    expect(
      await crew(job),
      "the outgoing primary W stays on the crew; X is added",
    ).toEqual([workerW.id, workerX.id].sort());
  });

  it("setting the same primary twice is idempotent — exactly one crew row", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    await setPrimary(asAdmin, job, orgA, workerW.id);
    await setPrimary(asAdmin, job, orgA, workerW.id);
    expect(await crew(job)).toEqual([workerW.id]);
    expect(await primary(job)).toBe(workerW.id);
  });

  it("clearing the primary (null) leaves the crew intact", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    await setPrimary(asAdmin, job, orgA, workerW.id); // W primary + crew
    await setPrimary(asAdmin, job, orgA, workerX.id); // X primary, W preserved
    const cleared = await setPrimary(asAdmin, job, orgA, null); // clear primary
    expect(cleared.error).toBeNull();
    expect(await primary(job), "primary is cleared").toBeNull();
    expect(
      await crew(job),
      "both former primaries remain on the crew until explicitly removed",
    ).toEqual([workerW.id, workerX.id].sort());
  });

  it("RULE 2: explicit removal revokes BOTH paths atomically", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    // W is the primary AND on the crew.
    await setPrimary(asAdmin, job, orgA, workerW.id);
    expect(await primary(job)).toBe(workerW.id);
    expect(await crew(job)).toContain(workerW.id);

    const removed = await removeWorker(asAdmin, job, orgA, workerW.id);
    expect(removed.error).toBeNull();
    expect(await crew(job), "crew row deleted").not.toContain(workerW.id);
    expect(await primary(job), "legacy primary nulled — no stale access path").toBeNull();
  });

  it("removing a NON-primary crew worker leaves the primary untouched", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    await setPrimary(asAdmin, job, orgA, workerW.id); // W primary + crew
    await setPrimary(asAdmin, job, orgA, workerX.id); // X primary, W preserved on crew
    // W is now a non-primary crew member. Remove W.
    const removed = await removeWorker(asAdmin, job, orgA, workerW.id);
    expect(removed.error).toBeNull();
    expect(await crew(job)).toEqual([workerX.id]);
    expect(await primary(job), "X stays the primary").toBe(workerX.id);
  });

  it("CONCURRENCY: parallel sets to the same primary yield exactly one crew row", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => setPrimary(asAdmin, job, orgA, workerW.id)),
    );
    for (const r of results) expect(r.error, "no concurrent call errors").toBeNull();
    expect(await crew(job), "unique(job_id,user_id) collapses the race to one row").toEqual([workerW.id]);
    expect(await primary(job)).toBe(workerW.id);
  });

  it("AUTHZ: a non-admin member cannot set or remove assignments (42501)", async () => {
    const job = await freshJob();
    await setPrimary(db(userClient(admin.token)), job, orgA, workerW.id); // seed via admin
    const asStaff = db(userClient(staff.token));

    const set = await setPrimary(asStaff, job, orgA, workerX.id);
    expect(set.error, "staff set is denied").not.toBeNull();
    const rm = await removeWorker(asStaff, job, orgA, workerW.id);
    expect(rm.error, "staff remove is denied").not.toBeNull();

    // State unchanged by the denied calls.
    expect(await primary(job)).toBe(workerW.id);
    expect(await crew(job)).toEqual([workerW.id]);
  });

  it("AUTHZ: anon cannot set or remove assignments", async () => {
    const job = await freshJob();
    await setPrimary(db(userClient(admin.token)), job, orgA, workerW.id);
    const asAnon = db(anonClient());
    expect((await setPrimary(asAnon, job, orgA, workerX.id)).error).not.toBeNull();
    expect((await removeWorker(asAnon, job, orgA, workerW.id)).error).not.toBeNull();
    expect(await primary(job)).toBe(workerW.id);
  });

  it("CROSS-ORG: an admin of another org cannot reach this job's assignments", async () => {
    const job = await freshJob();
    await setPrimary(db(userClient(admin.token)), job, orgA, workerW.id);
    const asOutsider = db(userClient(outsider.token));

    // With their OWN org id: not a member of orgA ⇒ 42501 guard.
    const wrongOrg = await setPrimary(asOutsider, job, orgA, workerX.id);
    expect(wrongOrg.error, "outsider using orgA is blocked by the membership guard").not.toBeNull();

    // With their own org id but this (foreign) job: the job isn't in orgB.
    const foreignJob = await setPrimary(asOutsider, job, orgB, workerX.id);
    expect(foreignJob.error, "the job is not in the outsider's org").not.toBeNull();

    expect(await primary(job), "the foreign job is untouched").toBe(workerW.id);
    expect(await crew(job)).toEqual([workerW.id]);
  });

  it("MEMBERSHIP: the primary must be a member of the job's org (23514)", async () => {
    const job = await freshJob();
    const asAdmin = db(userClient(admin.token));
    // outsider is a member of orgB only.
    const bad = await setPrimary(asAdmin, job, orgA, outsider.id);
    expect(bad.error, "a non-member cannot be set as the primary").not.toBeNull();
    expect(await primary(job), "the rejected set left no partial state").toBeNull();
    expect(await crew(job)).toEqual([]);
  });
});
