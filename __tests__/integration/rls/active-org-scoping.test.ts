import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import { loadJobForOrg } from "@/lib/jobs/load";

/**
 * ACTIVE-ORG SCOPING — proven against real Postgres with a genuine MULTI-ORG user.
 *
 * The defect: CrewFlow users may belong to more than one organisation, and the
 * app tracks an "active org" (the `active_org_id` cookie → `requireOrgContext()`).
 * The RLS helper `current_org_ids()` returns EVERY org the viewer belongs to —
 * correct for RLS, which enforces the OUTER boundary — so a query that
 * identifies a row by primary key alone was NOT constrained to the active org.
 * A user working in org A could open org B's job by URL and see it rendered in
 * A's shell, and (far worse) writes issued with A's assumptions could land on
 * B's row.
 *
 * This is NOT a cross-tenant vulnerability — the viewer is a legitimate member
 * of both orgs. It is a correctness / data-integrity defect.
 *
 * The three properties pinned here:
 *   1. SCOPING  — an org-B row is not-found while org A is active.
 *   2. NO OVER-SCOPING — the ordinary org-A row is still readable/writable.
 *   3. RLS UNTOUCHED — a user who belongs to NEITHER org still sees nothing,
 *      so the application-layer predicate is not load-bearing for the outer
 *      security boundary.
 *
 * It also pins the PREMISE (test "documents the defect"): the un-scoped query
 * shape really does return org B's row for this user. If that ever stops being
 * true, `current_org_ids()` changed and this whole fix should be revisited.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-aos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("active-org scoping · multi-org user (jobs)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";

  // The multi-org user: OWNER of both org A and org B, "working in" org A.
  let dualUserId = "";
  let dualToken = "";

  // A user who belongs to NEITHER org — the RLS control.
  let outsiderUserId = "";
  let outsiderToken = "";

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    // No auth.users → public.users trigger in this schema, so mirror the row
    // ourselves (memberships.user_id FKs public.users).
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `Active-org ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: "Active-Org Scoping A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "Active-Org Scoping B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const ja = await svc
      .from("jobs")
      .insert({ org_id: orgA, status: "new", notes: "job in org A" })
      .select("id")
      .single();
    const jb = await svc
      .from("jobs")
      .insert({ org_id: orgB, status: "new", notes: "job in org B" })
      .select("id")
      .single();
    jobA = String(ja.data?.id ?? "");
    jobB = String(jb.data?.id ?? "");
    if (!jobA || !jobB) throw new Error("failed to create probe jobs");

    const dual = await mintUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    // OWNER in BOTH orgs — this is what makes the blend possible and what
    // makes RLS (correctly) permit the row.
    const m1 = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: dualUserId, role: "owner" });
    const m2 = await svc
      .from("memberships")
      .insert({ org_id: orgB, user_id: dualUserId, role: "owner" });
    expect(m1.error, m1.error?.message).toBeNull();
    expect(m2.error, m2.error?.message).toBeNull();

    const outsider = await mintUser("outsider");
    outsiderUserId = outsider.id;
    outsiderToken = outsider.token;

    if (!dualToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderUserId) await serviceClient().auth.admin.deleteUser(outsiderUserId);
  });

  // ---------------------------------------------------------------- premise

  it("documents the defect: the UNSCOPED query really does return org B's job", async () => {
    // This is the exact shape the app used before the fix. RLS admits it
    // because the viewer is a genuine member of org B.
    const r = await db(userClient(dualToken))
      .from("jobs")
      .select("id, org_id")
      .eq("id", jobB)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    expect(
      r.data?.id,
      "RLS is deliberately permissive across memberships — if this ever " +
        "returns null, current_org_ids() changed and lib/jobs/load should be revisited",
    ).toBe(jobB);
  });

  // ---------------------------------------------------------------- scoping

  it("org B's job is NOT FOUND while org A is the active org", async () => {
    const job = await loadJobForOrg(userClient(dualToken), jobB, orgA);
    expect(
      job,
      "a row in a non-active org must be indistinguishable from a missing row",
    ).toBeNull();
  });

  it("org B's job is not found even with the columns the detail page requests", async () => {
    const job = await loadJobForOrg(
      userClient(dualToken),
      jobB,
      orgA,
      "id, status, notes, customer_id",
    );
    expect(job).toBeNull();
  });

  // ------------------------------------------------------- no over-scoping

  it("org A's own job IS still readable while org A is active (regression)", async () => {
    const job = await loadJobForOrg<{ id: string; notes: string | null }>(
      userClient(dualToken),
      jobA,
      orgA,
      "id, notes",
    );
    expect(job?.id, "the ordinary single-org read path must keep working").toBe(jobA);
    expect(job?.notes).toBe("job in org A");
  });

  it("switching active org to B makes B's job readable and A's not-found", async () => {
    // Proves the predicate tracks the ACTIVE org rather than simply hiding
    // org B for ever — the org switcher must still work.
    const bWhileActiveB = await loadJobForOrg(userClient(dualToken), jobB, orgB);
    const aWhileActiveB = await loadJobForOrg(userClient(dualToken), jobA, orgB);
    expect(bWhileActiveB).not.toBeNull();
    expect(aWhileActiveB).toBeNull();
  });

  // ------------------------------------------------------------------ writes

  it("an UPDATE scoped to the active org cannot touch org B's job", async () => {
    const r = await db(userClient(dualToken))
      .from("jobs")
      .update({ notes: "written from org A" }, { count: "exact" })
      .eq("id", jobB)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "zero rows must be affected").toBe(0);

    const after = await db(serviceClient())
      .from("jobs")
      .select("notes")
      .eq("id", jobB)
      .maybeSingle();
    expect(after.data?.notes, "org B's row must be untouched").toBe("job in org B");
  });

  it("without the predicate that same UPDATE DOES hit org B (the defect)", async () => {
    // The unscoped write the app performed before the fix. `is_org_admin()`
    // passes because the user is an owner of org B too.
    const r = await db(userClient(dualToken))
      .from("jobs")
      .update({ notes: "cross-org write" }, { count: "exact" })
      .eq("id", jobB);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "this is precisely what the fix prevents").toBe(1);

    // Restore the fixture so later assertions are not confused by it.
    await db(serviceClient())
      .from("jobs")
      .update({ notes: "job in org B" })
      .eq("id", jobB);
  });

  it("an UPDATE scoped to the active org still works on org A's own job", async () => {
    const r = await db(userClient(dualToken))
      .from("jobs")
      .update({ notes: "legitimate org A write" }, { count: "exact" })
      .eq("id", jobA)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "the normal write path must not be over-scoped").toBe(1);
  });

  // ------------------------------------------------------------ RLS control

  it("RLS is untouched: a non-member sees neither job", async () => {
    const outsiderSeesA = await loadJobForOrg(userClient(outsiderToken), jobA, orgA);
    const outsiderSeesB = await loadJobForOrg(userClient(outsiderToken), jobB, orgB);
    expect(outsiderSeesA).toBeNull();
    expect(outsiderSeesB).toBeNull();
  });

  it("RLS is untouched: a non-member is denied even by the UNSCOPED query", async () => {
    // The outer security boundary must not depend on the application-layer
    // predicate this change introduces.
    const r = await db(userClient(outsiderToken))
      .from("jobs")
      .select("id")
      .eq("id", jobA)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data, "RLS alone must still deny a genuine outsider").toBeNull();
  });

  it("RLS is untouched: anon sees nothing", async () => {
    const r = await db(anonClient()).from("jobs").select("id").eq("id", jobA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data ?? []).toHaveLength(0);
  });
});
