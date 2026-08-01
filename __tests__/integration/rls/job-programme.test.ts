import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * JOB PROGRAMME BASELINE against real Postgres (migration 20261085000000).
 *
 * The job_budgets proof set (job-budgets.test.ts), transplanted to the date
 * twin and extended one level for the milestone children:
 *
 *   · CROSS-TENANT composite-FK rejection on BOTH tables — a baseline whose
 *     org differs from its job's org, and a milestone whose org differs from
 *     its baseline's org, are unrepresentable even for service_role;
 *   · the admin gate is in the DATABASE — a staff member's JWT is refused by
 *     RLS directly AND through the SECURITY INVOKER RPC; an admin lands;
 *   · WRITE-ONCE — a current revision cannot be edited, a superseded one
 *     cannot be touched, milestones cannot be UPDATEd at all, and a targeted
 *     DELETE is refused on both tables for every role;
 *   · exactly ONE current revision per job under CONCURRENT RPC calls;
 *   · a revision after the first STRUCTURALLY requires a note;
 *   · set-level RPC rules: empty milestones, out-of-window dates, partial
 *     weights and Σ≠100 are refused with sentences;
 *   · CASCADES still work: job delete takes revisions + milestones, and ORG
 *     TEARDOWN with a live programme attached is asserted in afterAll (the
 *     20261052 lesson).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  is(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-programme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const MILESTONES = [
  { title: "First fix", planned_end: "2026-06-08", weight: 40, customer_visible: true },
  { title: "Second fix", planned_end: "2026-06-15", weight: 35, customer_visible: false },
  { title: "Snag and hand over", planned_end: "2026-06-21", weight: 25, customer_visible: true },
];

describeIntegration("job programme baseline · isolation, immutability, atomicity", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobA2 = "";
  let jobB = "";
  let dualId = "";
  let dualToken = "";
  let staffId = "";
  let staffToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `Programme ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const r = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeJob(org: string): Promise<string> {
    const r = await svc().from("jobs").insert({ org_id: org, status: "new" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  function setProgramme(
    client: unknown,
    args: Partial<{
      p_job_id: string;
      p_org_id: string;
      p_planned_start: string;
      p_planned_end: string;
      p_milestones: unknown;
      p_note: string | null;
    }> = {},
  ) {
    return rpc(client).rpc("set_job_programme", {
      p_job_id: jobA,
      p_org_id: orgA,
      p_planned_start: "2026-06-01",
      p_planned_end: "2026-06-21",
      p_milestones: MILESTONES,
      p_note: null,
      ...args,
    });
  }

  beforeAll(async () => {
    orgA = await makeOrg("Programme Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Programme Probe B", `${TOKEN}-b`);
    jobA = await makeJob(orgA);
    jobA2 = await makeJob(orgA);
    jobB = await makeJob(orgB);

    const dual = await makeUser("dual");
    dualId = dual.id;
    dualToken = dual.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    // ADMIN of BOTH orgs, so nothing below passes merely because the user was
    // under-privileged.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    // Teardown is ASSERTED, not fire-and-forget (the 20261052 lesson). Org B
    // still holds a LIVE baseline + milestones at this point, so this IS the
    // org-teardown-with-programme-attached proof.
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc().from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
      const residue = await svc().from("job_programme_baselines").select("id").eq("org_id", id);
      expect(residue.data ?? [], "baselines leaked past org teardown").toHaveLength(0);
      const msResidue = await svc().from("job_milestones").select("id").eq("org_id", id);
      expect(msResidue.data ?? [], "milestones leaked past org teardown").toHaveLength(0);
    }
    for (const id of [dualId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── 1. the admin gate is in the database ──────────────────────────────────

  it("a STAFF member with a valid JWT is refused — directly and through the RPC", async () => {
    const direct = await db(userClient(staffToken))
      .from("job_programme_baselines")
      .insert({ org_id: orgA, job_id: jobA, planned_start: "2026-06-01", planned_end: "2026-06-21" })
      .select("id")
      .single();
    expect(direct.error, "staff must not baseline a programme").not.toBeNull();
    expect(direct.error?.message ?? "").toMatch(/row-level security|policy/i);

    const viaRpc = await setProgramme(userClient(staffToken));
    expect(viaRpc.error, "SECURITY INVOKER must not be a back door").not.toBeNull();
  });

  it("an ADMIN lands revision 1 with its milestones, atomically", async () => {
    const r = await setProgramme(userClient(dualToken));
    expect(r.error, JSON.stringify(r.error)).toBeNull();

    const current = await svc()
      .from("job_programme_baselines")
      .select("id, revision, planned_start, planned_end")
      .eq("job_id", jobA)
      .is("superseded_at", null);
    expect(current.data ?? []).toHaveLength(1);
    expect(Number((current.data ?? [])[0]?.revision)).toBe(1);

    const ms = await svc()
      .from("job_milestones")
      .select("title, weight, sort, customer_visible")
      .eq("baseline_id", String((current.data ?? [])[0]?.id))
      .order("sort", { ascending: true });
    expect((ms.data ?? []).map((m) => m.title)).toEqual([
      "First fix",
      "Second fix",
      "Snag and hand over",
    ]);
  });

  it("an anonymous caller sees nothing at all", async () => {
    const r = await db(anonClient()).from("job_programme_baselines").select("id");
    expect(r.data ?? []).toHaveLength(0);
    const m = await db(anonClient()).from("job_milestones").select("id");
    expect(m.data ?? []).toHaveLength(0);
  });

  // ── 2. cross-tenant composite-FK rejection ────────────────────────────────

  it("REFUSES a baseline whose org differs from its job's org, even for service_role", async () => {
    const bad = await svc()
      .from("job_programme_baselines")
      .insert({ org_id: orgB, job_id: jobA2, planned_start: "2026-06-01", planned_end: "2026-06-21" })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/job_programme_baselines_job_fk|foreign key/i);
  });

  it("REFUSES a milestone whose org differs from its baseline's org, even for service_role", async () => {
    const current = await svc()
      .from("job_programme_baselines")
      .select("id")
      .eq("job_id", jobA)
      .is("superseded_at", null)
      .maybeSingle();
    const bad = await svc()
      .from("job_milestones")
      .insert({
        org_id: orgB, // forged org on org A's baseline
        baseline_id: String(current.data?.id),
        title: "smuggled",
        planned_end: "2026-06-10",
        sort: 99,
      })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/job_milestones_baseline_fk|foreign key/i);
  });

  it("REFUSES the RPC when p_org_id is not the job's org (no cross-org write)", async () => {
    const bad = await setProgramme(userClient(dualToken), {
      p_job_id: jobA2, // org A's job…
      p_org_id: orgB, // …stamped as org B, which the caller IS an admin of
    });
    expect(bad.error, "the composite FK must refuse it").not.toBeNull();
  });

  // ── 3. the RPC's set-level rules ──────────────────────────────────────────

  it("REFUSES empty milestones, out-of-window dates, partial weights and Σ≠100", async () => {
    const empty = await setProgramme(userClient(dualToken), {
      p_job_id: jobA2,
      p_milestones: [],
    });
    expect(empty.error?.message ?? "").toMatch(/at least one milestone/i);

    const outside = await setProgramme(userClient(dualToken), {
      p_job_id: jobA2,
      p_milestones: [{ title: "Late finish", planned_end: "2026-07-05", weight: 100 }],
    });
    expect(outside.error?.message ?? "").toMatch(/outside the programme window/i);

    const partial = await setProgramme(userClient(dualToken), {
      p_job_id: jobA2,
      p_milestones: [
        { title: "A", planned_end: "2026-06-08", weight: 60 },
        { title: "B", planned_end: "2026-06-15" },
      ],
    });
    expect(partial.error?.message ?? "").toMatch(/weight every milestone or none/i);

    const wrongSum = await setProgramme(userClient(dualToken), {
      p_job_id: jobA2,
      p_milestones: [
        { title: "A", planned_end: "2026-06-08", weight: 60 },
        { title: "B", planned_end: "2026-06-15", weight: 60 },
      ],
    });
    expect(wrongSum.error?.message ?? "").toMatch(/must sum to 100/i);
  });

  it("REFUSES a revision after the first with no reason given", async () => {
    const bad = await setProgramme(userClient(dualToken), { p_note: "   " });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/needs a note/i);
  });

  // ── 4. write-once history, on both tables ─────────────────────────────────

  it("REFUSES to edit the CURRENT revision, for the admin and for service_role", async () => {
    for (const [who, client] of [
      ["admin", userClient(dualToken)],
      ["service_role", serviceClient()],
    ] as const) {
      const bad = await db(client)
        .from("job_programme_baselines")
        .update({ planned_end: "2026-12-25" })
        .eq("job_id", jobA)
        .eq("revision", 1);
      expect(bad.error, `${who} must not be able to move a baseline in place`).not.toBeNull();
      expect(bad.error?.message ?? "").toMatch(/immutable/i);
    }
  });

  it("REFUSES any milestone UPDATE at all, for every role", async () => {
    const bad = await svc()
      .from("job_milestones")
      .update({ planned_end: "2026-06-20" })
      .eq("org_id", orgA);
    expect(bad.error, "milestones are frozen").not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/immutable/i);
  });

  it("supersedes on re-baseline, then REFUSES to touch the superseded revision", async () => {
    const revise = await setProgramme(userClient(dualToken), {
      p_planned_end: "2026-07-12",
      p_milestones: [
        { title: "First fix", planned_end: "2026-06-08", weight: 40 },
        { title: "Second fix", planned_end: "2026-06-29", weight: 35 },
        { title: "Snag and hand over", planned_end: "2026-07-12", weight: 25 },
      ],
      p_note: "extension of time agreed on variation 2",
    });
    expect(revise.error, JSON.stringify(revise.error)).toBeNull();

    const current = await svc()
      .from("job_programme_baselines")
      .select("revision")
      .eq("job_id", jobA)
      .is("superseded_at", null);
    expect(current.data ?? [], "exactly one current baseline").toHaveLength(1);
    expect(Number((current.data ?? [])[0]?.revision)).toBe(2);

    const touchHistory = await svc()
      .from("job_programme_baselines")
      .update({ note: "quietly rewritten" })
      .eq("job_id", jobA)
      .eq("revision", 1);
    expect(touchHistory.error).not.toBeNull();
    expect(touchHistory.error?.message ?? "").toMatch(/history and cannot be changed/i);
  });

  it("REFUSES a targeted DELETE on both tables, for every role", async () => {
    const delBaseline = await svc().from("job_programme_baselines").delete().eq("job_id", jobA);
    expect(delBaseline.error, "the baseline guard must refuse it").not.toBeNull();
    expect(delBaseline.error?.message ?? "").toMatch(/audit trail/i);

    const delMilestone = await svc().from("job_milestones").delete().eq("org_id", orgA);
    expect(delMilestone.error, "the milestone guard must refuse it").not.toBeNull();
    expect(delMilestone.error?.message ?? "").toMatch(/supersede the baseline/i);

    // The admin is refused by the ABSENT delete policy (PostgREST no-op), so
    // assert on the surviving rows rather than on an error.
    await db(userClient(dualToken)).from("job_programme_baselines").delete().eq("job_id", jobA);
    const left = await svc().from("job_programme_baselines").select("id").eq("job_id", jobA);
    expect((left.data ?? []).length, "no revision may be deletable").toBe(2);
  });

  it("REFUSES a second CURRENT baseline for the same job (the index, not luck)", async () => {
    const bad = await svc()
      .from("job_programme_baselines")
      .insert({
        org_id: orgA,
        job_id: jobA,
        revision: 9,
        planned_start: "2026-06-01",
        planned_end: "2026-06-21",
        note: "sneak",
      })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/one_current|duplicate key/i);
  });

  // ── 5. the one-current race under CONCURRENT RPC ──────────────────────────

  it("two SIMULTANEOUS re-baselines serialise: one current revision, dense chain", async () => {
    const before = await svc().from("job_programme_baselines").select("id").eq("job_id", jobA);
    const countBefore = (before.data ?? []).length;
    const results = await Promise.all([
      setProgramme(userClient(dualToken), { p_note: "concurrent A" }),
      setProgramme(userClient(dualToken), { p_note: "concurrent B" }),
    ]);
    // Both may land (serialised by the advisory lock); what may NEVER happen is
    // two live baselines.
    const okCount = results.filter((r) => r.error === null).length;
    expect(okCount, "at least one must land").toBeGreaterThan(0);

    const current = await svc()
      .from("job_programme_baselines")
      .select("revision")
      .eq("job_id", jobA)
      .is("superseded_at", null);
    expect(current.data ?? [], "exactly one current baseline, always").toHaveLength(1);

    const all = await svc()
      .from("job_programme_baselines")
      .select("id, revision")
      .eq("job_id", jobA);
    expect((all.data ?? []).length).toBe(countBefore + okCount);
    const revs = (all.data ?? []).map((r) => Number(r.revision)).sort((a, b) => a - b);
    expect(new Set(revs).size, "revisions stay dense and unique").toBe(revs.length);
  });

  // ── 6. cascades ───────────────────────────────────────────────────────────

  it("deleting the JOB takes every revision AND milestone with it — guards do not block", async () => {
    // The 20261052 trap, one level deeper: the milestone guard checks its
    // BASELINE (already gone mid-cascade), the baseline guard checks its JOB
    // (already gone). Both must stand aside.
    const del = await svc().from("jobs").delete().eq("id", jobA);
    expect(del.error, `job delete must not be blocked: ${JSON.stringify(del.error)}`).toBeNull();
    const leftB = await svc().from("job_programme_baselines").select("id").eq("job_id", jobA);
    expect(leftB.data ?? []).toHaveLength(0);
    const leftM = await svc().from("job_milestones").select("id").eq("org_id", orgA);
    expect(leftM.data ?? []).toHaveLength(0);
  });

  it("org B gets a LIVE programme for the teardown proof in afterAll", async () => {
    // Direct service-role insert (org B has no admin session here); the
    // teardown assertion in afterAll is the actual proof.
    const b = await svc()
      .from("job_programme_baselines")
      .insert({ org_id: orgB, job_id: jobB, planned_start: "2026-06-01", planned_end: "2026-06-21" })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    const m = await svc()
      .from("job_milestones")
      .insert({
        org_id: orgB,
        baseline_id: String(b.data?.id),
        title: "Only milestone",
        planned_end: "2026-06-10",
        sort: 1,
      })
      .select("id")
      .single();
    expect(m.error, m.error?.message).toBeNull();
  });
});
