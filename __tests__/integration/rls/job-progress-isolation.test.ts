import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import {
  buildProgressSeries,
  summariseProgress,
} from "@/lib/job-progress/series";
import { loadProgressForJobs, type ProgressClient } from "@/server/services/job-progress";

/**
 * Job progress observations — real-Postgres security + integrity proof
 * (migration 20261078000000).
 *
 * Proves against a live database:
 *   1. TENANT ISOLATION — anon and an authenticated non-member read nothing.
 *   2. COMPOSITE-FK ORG BINDING — an observation against ANOTHER tenant's job
 *      is unrepresentable even for service_role (which bypasses RLS entirely).
 *   3. DUAL-ORG — a member of BOTH orgs sees both under bare RLS, and the
 *      service's explicit org pin is what narrows them to the active workspace.
 *   4. PROGRESS CAN GO DOWN — a regression is accepted and preserved.
 *   5. ONE READING PER JOB PER DAY — the series can never have two y for one x.
 *   6. NO FUTURE OBSERVATIONS, and the author must be a member of the org.
 *   7. NO FINANCES POSTINGS — writing progress moves no money, anywhere.
 *   8. ORG TEARDOWN still works with progress rows present (the 20261052 class).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: readonly unknown[]): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-jp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("job_progress_observations · isolation + integrity", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let memberId = "";
  let memberToken = "";
  let outsiderToken = "";
  let dualToken = "";
  let dualUserId = "";

  const createUser = async (suffix: string) => {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    // memberships.user_id references public.users, not auth.users — the profile
    // row must exist before this user can be given a membership.
    const profile = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: email });
    expect(profile.error, profile.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return {
      id,
      token: signedIn.data.session?.access_token ?? "",
    };
  };

  beforeAll(async () => {
    const svc = db(serviceClient());

    for (const [label, set] of [
      ["A", (v: string) => (orgA = v)],
      ["B", (v: string) => (orgB = v)],
    ] as const) {
      const org = await svc
        .from("organizations")
        .insert({ name: `Progress Probe ${label}`, slug: `${TOKEN}-${label.toLowerCase()}` })
        .select("id")
        .single();
      expect(org.error, org.error?.message).toBeNull();
      set(String(org.data?.id ?? ""));
    }

    for (const [orgId, set] of [
      [orgA, (v: string) => (jobA = v)],
      [orgB, (v: string) => (jobB = v)],
    ] as const) {
      const job = await svc
        .from("jobs")
        .insert({ org_id: orgId, status: "in-progress" })
        .select("id")
        .single();
      expect(job.error, job.error?.message).toBeNull();
      set(String(job.data?.id ?? ""));
    }

    const member = await createUser("member");
    memberId = member.id;
    memberToken = member.token;
    const outsider = await createUser("outsider");
    outsiderToken = outsider.token;
    const dual = await createUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;

    const memberships = await svc.from("memberships").insert([
      { org_id: orgA, user_id: memberId, role: "admin" },
      { org_id: orgA, user_id: dualUserId, role: "staff" },
      { org_id: orgB, user_id: dualUserId, role: "staff" },
    ]);
    expect(memberships.error, memberships.error?.message).toBeNull();
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
  });

  // ── 1. Tenant isolation ────────────────────────────────────────────────────

  it("anon and a non-member read nothing; a member reads their org's series", async () => {
    const svc = db(serviceClient());
    const seeded = await svc
      .from("job_progress_observations")
      .insert({
        org_id: orgA,
        job_id: jobA,
        observed_on: "2026-06-01",
        percent: 30,
        note: "internal only",
      })
      .select("id")
      .single();
    expect(seeded.error, seeded.error?.message).toBeNull();

    const asAnon = await db(anonClient())
      .from("job_progress_observations")
      .select("id")
      .eq("job_id", jobA);
    expect(asAnon.data ?? []).toHaveLength(0);

    const asOutsider = await db(userClient(outsiderToken))
      .from("job_progress_observations")
      .select("id")
      .eq("job_id", jobA);
    expect(asOutsider.data ?? []).toHaveLength(0);

    const asMember = await db(userClient(memberToken))
      .from("job_progress_observations")
      .select("id, percent")
      .eq("job_id", jobA);
    expect(asMember.error, asMember.error?.message).toBeNull();
    expect(asMember.data ?? []).toHaveLength(1);
  });

  // ── 2. Composite-FK org binding ────────────────────────────────────────────

  it("an observation against ANOTHER tenant's job is refused for service_role too", async () => {
    // service_role bypasses RLS entirely, so this can only be the composite FK
    // (job_id, org_id) -> jobs(id, org_id) doing the work.
    const forged = await db(serviceClient())
      .from("job_progress_observations")
      .insert({ org_id: orgA, job_id: jobB, observed_on: "2026-06-02", percent: 10 })
      .select("id")
      .single();
    expect(forged.error, "cross-tenant job reference must be unrepresentable").not.toBeNull();
    expect(forged.error?.message ?? "").toMatch(/foreign key|violates/i);
  });

  it("a member cannot write an observation into an org they don't belong to", async () => {
    const res = await db(userClient(memberToken))
      .from("job_progress_observations")
      .insert({ org_id: orgB, job_id: jobB, observed_on: "2026-06-02", percent: 10 })
      .select("id")
      .single();
    expect(res.error, "RLS must refuse a foreign-org insert").not.toBeNull();
  });

  // ── 3. Dual-org proof ──────────────────────────────────────────────────────

  it("DUAL-ORG: bare RLS blends both orgs; the service's org pin is what narrows", async () => {
    const svc = db(serviceClient());
    const seedB = await svc
      .from("job_progress_observations")
      .insert({ org_id: orgB, job_id: jobB, observed_on: "2026-06-03", percent: 80 })
      .select("id")
      .single();
    expect(seedB.error, seedB.error?.message).toBeNull();

    // The user is a member of BOTH orgs. current_org_ids() returns both, so an
    // RLS-only read returns rows from both — this is the blend the explicit
    // org pin exists to prevent, asserted rather than assumed.
    const blended = await db(userClient(dualToken))
      .from("job_progress_observations")
      .select("id, org_id")
      .in("job_id", [jobA, jobB]);
    expect(blended.error, blended.error?.message).toBeNull();
    const orgIds = new Set((blended.data ?? []).map((r) => String(r.org_id)));
    expect(orgIds).toEqual(new Set([orgA, orgB]));

    // The SERVICE — the path the app actually uses — pins org_id, so the same
    // dual-org user working in org A sees ONLY org A's job.
    const pinned = await loadProgressForJobs(
      userClient(dualToken) as unknown as ProgressClient,
      orgA,
      [jobA, jobB],
      new Date("2026-06-10T09:00:00Z"),
    );
    expect(pinned.failed).toBe(false);
    expect(pinned.byJob.get(jobA)?.percent).toBe(30);
    // org B's job is asked for but pinned out — it comes back empty, not 80.
    expect(pinned.byJob.get(jobB)?.percent).toBeNull();

    const pinnedB = await loadProgressForJobs(
      userClient(dualToken) as unknown as ProgressClient,
      orgB,
      [jobA, jobB],
      new Date("2026-06-10T09:00:00Z"),
    );
    expect(pinnedB.byJob.get(jobB)?.percent).toBe(80);
    expect(pinnedB.byJob.get(jobA)?.percent).toBeNull();
  });

  // ── 4. THE REGRESSION CASE ─────────────────────────────────────────────────

  it("PROGRESS CAN GO DOWN — a regression is stored and read back intact", async () => {
    const svc = db(serviceClient());
    const job = await svc
      .from("jobs")
      .insert({ org_id: orgA, status: "in-progress" })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    const jobId = String(job.data?.id ?? "");

    // 70% at practical progress, then a failed inspection forces rework: 55%.
    const inserted = await svc.from("job_progress_observations").insert([
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-01", percent: 45 },
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-05", percent: 70 },
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-09", percent: 55 },
    ]);
    expect(
      inserted.error,
      "the DB must accept a fall in percent — rework is real",
    ).toBeNull();

    const read = await db(userClient(memberToken))
      .from("job_progress_observations")
      .select("observed_on, percent")
      .eq("job_id", jobId)
      .order("observed_on", { ascending: true });
    expect(read.error, read.error?.message).toBeNull();
    expect((read.data ?? []).map((r) => Number(r.percent))).toEqual([45, 70, 55]);

    // …and the pure lib calls it what it is, end to end.
    const summary = summariseProgress(
      buildProgressSeries({
        observations: (read.data ?? []).map((r, i) => ({
          id: `r${i}`,
          observed_on: String(r.observed_on),
          percent: Number(r.percent),
          note: null,
          recorded_by: null,
        })),
      }),
      new Date("2026-06-10T09:00:00Z"),
    );
    expect(summary.trend).toBe("regressed");
    expect(summary.delta).toBe(-15);
  });

  // ── 5. One reading per job per day ─────────────────────────────────────────

  it("refuses a SECOND reading for the same job and day", async () => {
    const dup = await db(serviceClient())
      .from("job_progress_observations")
      .insert({ org_id: orgA, job_id: jobA, observed_on: "2026-06-01", percent: 44 })
      .select("id")
      .single();
    expect(dup.error, "a day may hold only one reading").not.toBeNull();
    expect(dup.error?.message ?? "").toMatch(/duplicate key|unique/i);
  });

  it("a same-day correction is an UPDATE, and it may lower the figure", async () => {
    const updated = await db(userClient(memberToken))
      .from("job_progress_observations")
      .update({ percent: 22 })
      .eq("job_id", jobA)
      .eq("observed_on", "2026-06-01");
    expect(updated.error, updated.error?.message).toBeNull();

    const read = await db(userClient(memberToken))
      .from("job_progress_observations")
      .select("percent")
      .eq("job_id", jobA)
      .eq("observed_on", "2026-06-01");
    expect(Number((read.data ?? [])[0]?.percent)).toBe(22);
  });

  // ── 6. Honest dates and authorship ─────────────────────────────────────────

  it("refuses a FUTURE-dated observation", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const res = await db(serviceClient())
      .from("job_progress_observations")
      .insert({ org_id: orgA, job_id: jobA, observed_on: future, percent: 90 })
      .select("id")
      .single();
    expect(res.error, "progress cannot be observed in the future").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/future/i);
  });

  it("accepts a BACK-dated observation (Friday's walk-round, logged Monday)", async () => {
    const res = await db(serviceClient())
      .from("job_progress_observations")
      .insert({ org_id: orgA, job_id: jobA, observed_on: "2026-05-15", percent: 12 })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
  });

  it("refuses an author who is not a member of the org", async () => {
    const res = await db(serviceClient())
      .from("job_progress_observations")
      .insert({
        org_id: orgB,
        job_id: jobB,
        observed_on: "2026-06-04",
        percent: 10,
        recorded_by: memberId, // a member of org A only
      })
      .select("id")
      .single();
    expect(res.error, "a foreign author would put another tenant's name on this record").not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/not a member/i);
  });

  it("refuses a percentage outside 0-100", async () => {
    for (const percent of [-1, 101]) {
      const res = await db(serviceClient())
        .from("job_progress_observations")
        .insert({ org_id: orgA, job_id: jobA, observed_on: "2026-04-01", percent })
        .select("id")
        .single();
      expect(res.error, `percent ${percent} must be refused`).not.toBeNull();
    }
  });

  // ── 7. No finances postings ────────────────────────────────────────────────

  it("recording progress posts NOTHING to finances or invoices", async () => {
    const svc = db(serviceClient());
    const countFor = async (table: string, orgId: string) => {
      const res = await svc.from(table).select("id").eq("org_id", orgId);
      expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
      return (res.data ?? []).length;
    };

    const before = {
      finances: await countFor("finances", orgA),
      invoices: await countFor("invoices", orgA),
      payments: await countFor("payments", orgA),
    };

    const job = await svc
      .from("jobs")
      .insert({ org_id: orgA, status: "in-progress" })
      .select("id")
      .single();
    const jobId = String(job.data?.id ?? "");
    // A full journey, including 100% — the figure most likely to be mistaken
    // for "the job is now billable".
    const written = await svc.from("job_progress_observations").insert([
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-01", percent: 25 },
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-02", percent: 50 },
      { org_id: orgA, job_id: jobId, observed_on: "2026-06-03", percent: 100 },
    ]);
    expect(written.error, written.error?.message).toBeNull();

    expect(await countFor("finances", orgA)).toBe(before.finances);
    expect(await countFor("invoices", orgA)).toBe(before.invoices);
    expect(await countFor("payments", orgA)).toBe(before.payments);
  });

  it("no billing plan or stage is created or advanced by a progress write", async () => {
    const svc = db(serviceClient());
    const plans = await svc.from("job_billing_plans").select("id").eq("org_id", orgA);
    expect(plans.error, plans.error?.message).toBeNull();
    expect(plans.data ?? []).toHaveLength(0);

    const stages = await svc.from("job_billing_stages").select("id").eq("org_id", orgA);
    expect(stages.error, stages.error?.message).toBeNull();
    expect(stages.data ?? []).toHaveLength(0);
  });

  // ── 8. Org teardown ────────────────────────────────────────────────────────

  it("ORG TEARDOWN still works with progress rows present (20261052 class)", async () => {
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "Progress Teardown", slug: `${TOKEN}-teardown` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    const orgId = String(org.data?.id ?? "");

    const job = await svc
      .from("jobs")
      .insert({ org_id: orgId, status: "in-progress" })
      .select("id")
      .single();
    const jobId = String(job.data?.id ?? "");

    const obs = await svc
      .from("job_progress_observations")
      .insert({ org_id: orgId, job_id: jobId, observed_on: "2026-06-01", percent: 60 })
      .select("id")
      .single();
    expect(obs.error, obs.error?.message).toBeNull();

    const deleted = await svc.from("organizations").delete().eq("id", orgId);
    expect(
      deleted.error,
      "org teardown must not be blocked by progress rows",
    ).toBeNull();

    const left = await svc
      .from("job_progress_observations")
      .select("id")
      .eq("org_id", orgId);
    expect(left.data ?? []).toHaveLength(0);
  });

  it("deleting the JOB cascades its progress away (no orphan series)", async () => {
    const svc = db(serviceClient());
    const job = await svc
      .from("jobs")
      .insert({ org_id: orgA, status: "in-progress" })
      .select("id")
      .single();
    const jobId = String(job.data?.id ?? "");
    await svc
      .from("job_progress_observations")
      .insert({ org_id: orgA, job_id: jobId, observed_on: "2026-06-01", percent: 15 })
      .select("id")
      .single();

    const deleted = await svc.from("jobs").delete().eq("id", jobId);
    expect(deleted.error, deleted.error?.message).toBeNull();

    const left = await svc
      .from("job_progress_observations")
      .select("id")
      .eq("job_id", jobId);
    expect(left.data ?? []).toHaveLength(0);
  });
});
