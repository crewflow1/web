import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Weather intelligence · the GLOBAL cache's trust boundary, and teardown safety
 * (20261074000000).
 *
 * `weather_readings` is deliberately NOT org-scoped — weather is a fact about the
 * world, one row serves every tenant, and that sharing is what makes the whole
 * feature affordable. The consequence is that its READ POLICY is the entire trust
 * boundary, so this file's headline proofs are:
 *
 *   - a tenant sees a cached district ONLY while one of its own orgs watches it.
 *     An unrestricted read would let any tenant enumerate which parts of the
 *     country the platform is working in — a cross-tenant inference channel, the
 *     defect class the 20261031–37 storage wave was written to eliminate;
 *   - stopping the watch immediately stops the read, so visibility is derived and
 *     not granted once;
 *   - no tenant client can FORGE a reading (there is no INSERT policy), because a
 *     forged reading would drive a false work-viability verdict;
 *   - the PII containment CHECK refuses a full postcode for EVERY role,
 *     service_role included — a leak of customer addresses into a cross-tenant
 *     table is unrepresentable rather than merely discouraged;
 *   - a watch cannot be anchored to another tenant's job or site;
 *   - STANDING (unanchored) watches are admin-only while anchored ones are not,
 *     and a member cannot escalate by nulling out an anchor;
 *   - and `delete from organizations` STILL SUCCEEDS with watches present — the
 *     20261052 cascade lesson, re-proved because this migration adds a new
 *     cascade child and that is exactly how that P1 would come back.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
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
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Two real, distinct districts. A watches LS1, B watches WF1. */
const DISTRICT_A = "LS1";
const DISTRICT_B = "WF1";
/** Watched by nobody in this test — the control for the read gate. */
const DISTRICT_UNWATCHED = "PL7";

describeIntegration("weather · global cache boundary + teardown safety", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let siteB = "";
  let adminAId = "";
  let adminAToken = "";
  let memberAId = "";
  let memberAToken = "";
  let adminBId = "";
  let adminBToken = "";
  let outsiderId = "";
  let outsiderToken = "";
  let customerA = "";

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
      .insert({ id, email, full_name: `Weather ${suffix}` })
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
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  /** A forecast row, written as service_role — the only role that can. */
  async function seedReading(district: string, hourOffset: number) {
    const validAt = new Date(Date.UTC(2026, 10, 12, 9 + hourOffset)).toISOString();
    const res = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: district,
        kind: "forecast",
        valid_at: validAt,
        expires_at: new Date(Date.UTC(2026, 10, 13, 9)).toISOString(),
        air_temp_c: 7.5,
        wind_speed_ms: 6,
        wind_gust_ms: 11.5,
        precip_rate_mm_h: 0.4,
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return String(res.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("Weather Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Weather Probe B", `${TOKEN}-b`);
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: "Weather Customer A" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    customerA = String(cust.data?.id ?? "");

    const ja = await svc()
      .from("jobs")
      .insert({ org_id: orgA, status: "new", notes: "Slab pour", customer_id: customerA })
      .select("id")
      .single();
    expect(ja.error, ja.error?.message).toBeNull();
    jobA = String(ja.data?.id ?? "");

    const jb = await svc()
      .from("jobs")
      .insert({ org_id: orgB, status: "new", notes: "Roof strip" })
      .select("id")
      .single();
    expect(jb.error, jb.error?.message).toBeNull();
    jobB = String(jb.data?.id ?? "");

    const sb = await svc()
      .from("sites")
      .insert({ org_id: orgB, name: "B yard", kind: "yard" })
      .select("id")
      .single();
    expect(sb.error, sb.error?.message).toBeNull();
    siteB = String(sb.data?.id ?? "");

    const adminA = await makeUser("admin-a");
    adminAId = adminA.id;
    adminAToken = adminA.token;
    const memberA = await makeUser("member-a");
    memberAId = memberA.id;
    memberAToken = memberA.token;
    const adminB = await makeUser("admin-b");
    adminBId = adminB.id;
    adminBToken = adminB.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    for (const [org, user, role] of [
      [orgA, adminAId, "admin"],
      [orgA, memberAId, "staff"],
      [orgB, adminBId, "admin"],
    ] as const) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: user, role })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }

    // A watches LS1 (anchored to its job). B watches WF1.
    const wa = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: DISTRICT_A, job_id: jobA })
      .select("id")
      .single();
    expect(wa.error, wa.error?.message).toBeNull();

    const wb = await svc()
      .from("weather_watches")
      .insert({ org_id: orgB, postcode_district: DISTRICT_B, job_id: jobB })
      .select("id")
      .single();
    expect(wb.error, wb.error?.message).toBeNull();

    // Cache rows for all three districts, including one nobody watches.
    await seedReading(DISTRICT_A, 0);
    await seedReading(DISTRICT_B, 0);
    await seedReading(DISTRICT_UNWATCHED, 0);
  });

  afterAll(async () => {
    // Readings are global — no cascade will remove them, so clean up explicitly.
    for (const d of [DISTRICT_A, DISTRICT_B, DISTRICT_UNWATCHED]) {
      await svc().from("weather_readings").delete().eq("postcode_district", d);
    }
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const id of [adminAId, memberAId, adminBId, outsiderId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── the cache read gate ───────────────────────────────────────────────────

  it("anon is denied the weather cache entirely", async () => {
    const { data, error } = await db(anonClient()).from("weather_readings").select("*");
    expect(error ? true : (data ?? []).length === 0, "cache leaked to anon").toBe(true);
  });

  it("an authenticated non-member sees NO readings — they watch nothing", async () => {
    const { data, error } = await db(userClient(outsiderToken))
      .from("weather_readings")
      .select("postcode_district");
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });

  it("org A sees the district it WATCHES", async () => {
    const { data, error } = await db(userClient(adminAToken))
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_A);
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("org A CANNOT see org B's watched district — the cross-tenant inference channel is closed", async () => {
    // The headline. Both rows exist in one global table; only the watch
    // distinguishes them.
    const { data, error } = await db(userClient(adminAToken))
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_B);
    expect(error ? true : (data ?? []).length === 0, "org B's watched district leaked to A").toBe(
      true,
    );
  });

  it("nobody sees a district that NO org watches", async () => {
    for (const token of [adminAToken, adminBToken, outsiderToken]) {
      const { data, error } = await db(userClient(token))
        .from("weather_readings")
        .select("postcode_district")
        .eq("postcode_district", DISTRICT_UNWATCHED);
      expect(error ? true : (data ?? []).length === 0).toBe(true);
    }
    // …but the row is really there, so the assertions above are not vacuous.
    const truth = await svc()
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_UNWATCHED);
    expect((truth.data ?? []).length).toBeGreaterThan(0);
  });

  it("an unfiltered read returns ONLY the caller's watched districts", async () => {
    const { data, error } = await db(userClient(adminAToken))
      .from("weather_readings")
      .select("postcode_district");
    expect(error, error?.message).toBeNull();
    const districts = new Set((data ?? []).map((r) => String(r.postcode_district)));
    expect(districts.has(DISTRICT_A)).toBe(true);
    expect(districts.has(DISTRICT_B)).toBe(false);
    expect(districts.has(DISTRICT_UNWATCHED)).toBe(false);
  });

  it("visibility is DERIVED: removing the watch immediately removes the read", async () => {
    // Proves the gate is evaluated per-read rather than granted once.
    const created = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: DISTRICT_UNWATCHED, job_id: jobA })
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const watchId = String(created.data?.id ?? "");

    const withWatch = await db(userClient(adminAToken))
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_UNWATCHED);
    expect(withWatch.error, withWatch.error?.message).toBeNull();
    expect((withWatch.data ?? []).length).toBeGreaterThan(0);

    await svc().from("weather_watches").delete().eq("id", watchId);

    const withoutWatch = await db(userClient(adminAToken))
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_UNWATCHED);
    expect(
      withoutWatch.error ? true : (withoutWatch.data ?? []).length === 0,
      "read survived the watch being removed",
    ).toBe(true);
  });

  // ── the cache is unwritable by tenants ────────────────────────────────────

  it("a tenant client cannot FORGE a reading — there is no INSERT policy", async () => {
    // A forged reading is the most consequential write in this domain: it would
    // drive a false work-viability verdict on a real site.
    const { error } = await db(userClient(adminAToken))
      .from("weather_readings")
      .insert({
        provider: "forged",
        postcode_district: DISTRICT_A,
        kind: "forecast",
        valid_at: new Date(Date.UTC(2026, 10, 20, 9)).toISOString(),
        expires_at: new Date(Date.UTC(2026, 10, 21, 9)).toISOString(),
        air_temp_c: 25,
      })
      .select("id")
      .single();
    expect(error, "a tenant client forged a weather reading").not.toBeNull();
  });

  it("a tenant client cannot REWRITE or DELETE a reading", async () => {
    const upd = await db(userClient(adminAToken))
      .from("weather_readings")
      .update({ air_temp_c: 30 })
      .eq("postcode_district", DISTRICT_A)
      .select("postcode_district");
    // No UPDATE policy ⇒ either an error or zero rows affected.
    expect(upd.error ? true : (upd.data ?? []).length === 0).toBe(true);

    await db(userClient(adminAToken))
      .from("weather_readings")
      .delete()
      .eq("postcode_district", DISTRICT_A);
    const still = await svc()
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_A);
    expect((still.data ?? []).length).toBeGreaterThan(0);
  });

  // ── PII containment, enforced for EVERY role ──────────────────────────────

  it("a FULL POSTCODE is refused on the cache, even for service_role", async () => {
    // The containment control. This table is readable across tenants, so a full
    // postcode in it would publish where a builder's customers live. A CHECK
    // binds every role; RLS would not have bound service_role at all.
    for (const bad of ["LS1 4AP", "LS14AP", "ls1 4ap", "NOT-A-POSTCODE", "LS1 4"]) {
      const { error } = await svc()
        .from("weather_readings")
        .insert({
          provider: "test-fixture",
          postcode_district: bad,
          kind: "forecast",
          valid_at: new Date(Date.UTC(2026, 11, 1, 9)).toISOString(),
          expires_at: new Date(Date.UTC(2026, 11, 2, 9)).toISOString(),
        })
        .select("id")
        .single();
      expect(error, `postcode_district accepted "${bad}"`).not.toBeNull();
    }
  });

  it("a full postcode is refused on the WATCH table too", async () => {
    const { error } = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS1 4AP", job_id: jobA })
      .select("id")
      .single();
    expect(error, "weather_watches accepted a full postcode").not.toBeNull();
  });

  it("an OBSERVATION with an expiry is unrepresentable, and a forecast without one too", async () => {
    const observationWithExpiry = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: DISTRICT_A,
        kind: "observation",
        valid_at: new Date(Date.UTC(2026, 9, 1, 9)).toISOString(),
        expires_at: new Date(Date.UTC(2026, 9, 2, 9)).toISOString(),
      })
      .select("id")
      .single();
    expect(observationWithExpiry.error, "an observation was allowed to expire").not.toBeNull();

    const forecastWithoutExpiry = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: DISTRICT_A,
        kind: "forecast",
        valid_at: new Date(Date.UTC(2026, 9, 3, 9)).toISOString(),
      })
      .select("id")
      .single();
    expect(forecastWithoutExpiry.error, "a forecast was allowed with no expiry").not.toBeNull();
  });

  it("the identity index makes a refreshed forecast an UPSERT, not a duplicate", async () => {
    const validAt = new Date(Date.UTC(2026, 10, 12, 9)).toISOString();
    const { error } = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: DISTRICT_A,
        kind: "forecast",
        valid_at: validAt,
        expires_at: new Date(Date.UTC(2026, 10, 13, 9)).toISOString(),
      })
      .select("id")
      .single();
    expect(error, "the identity index did not refuse a duplicate").not.toBeNull();
  });

  // ── watch anchors cannot cross tenants ────────────────────────────────────

  it("a watch cannot be anchored to another tenant's JOB, even as service_role", async () => {
    // RLS checks the row's own org_id and says nothing about the org of the thing
    // it points at — the class 20261011 closed for purchase orders. A trigger is
    // the only control that binds service_role too.
    const { error } = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: DISTRICT_A, job_id: jobB })
      .select("id")
      .single();
    expect(error, "a cross-tenant job anchor was accepted").not.toBeNull();
    expect(error?.message ?? "").toMatch(/not in this org/i);
  });

  it("a watch cannot be anchored to another tenant's SITE", async () => {
    const { error } = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: DISTRICT_A, site_id: siteB })
      .select("id")
      .single();
    expect(error, "a cross-tenant site anchor was accepted").not.toBeNull();
  });

  it("a watch cannot carry BOTH anchors", async () => {
    const siteA = await svc()
      .from("sites")
      .insert({ org_id: orgA, name: "A yard", kind: "yard" })
      .select("id")
      .single();
    expect(siteA.error, siteA.error?.message).toBeNull();
    const { error } = await svc()
      .from("weather_watches")
      .insert({
        org_id: orgA,
        postcode_district: "LS2",
        job_id: jobA,
        site_id: String(siteA.data?.id ?? ""),
      })
      .select("id")
      .single();
    expect(error, "a watch with two anchors was accepted").not.toBeNull();
  });

  // ── the graded write rule ─────────────────────────────────────────────────

  it("a STAFF member may create an ANCHORED watch — day-to-day site management", async () => {
    const { data, error } = await db(userClient(memberAToken))
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS3", job_id: jobA })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    expect(data?.id).toBeTruthy();
    await svc().from("weather_watches").delete().eq("id", String(data?.id ?? ""));
  });

  it("a STAFF member may NOT create a STANDING watch — it has no natural end", async () => {
    // The unanchored watch keeps costing provider calls until a human removes it,
    // so it sits with whoever owns the bill.
    const { error } = await db(userClient(memberAToken))
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS4" })
      .select("id")
      .single();
    expect(error, "a staff member created a standing watch").not.toBeNull();
  });

  it("an ADMIN may create a standing watch", async () => {
    const { data, error } = await db(userClient(adminAToken))
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS5" })
      .select("id")
      .single();
    expect(error, error?.message).toBeNull();
    await svc().from("weather_watches").delete().eq("id", String(data?.id ?? ""));
  });

  it("a member cannot ESCALATE by nulling out an anchor", async () => {
    // Without the update policy's WITH CHECK arm, a member could take an anchored
    // watch they may edit and arrive at a standing watch they could never create.
    const created = await db(userClient(memberAToken))
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS6", job_id: jobA })
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const id = String(created.data?.id ?? "");

    const escalated = await db(userClient(memberAToken))
      .from("weather_watches")
      .update({ job_id: null })
      .eq("id", id)
      .select("id");
    expect(
      escalated.error ? true : (escalated.data ?? []).length === 0,
      "a member converted an anchored watch into a standing one",
    ).toBe(true);

    // Ground truth: the anchor is still there.
    const truth = await svc().from("weather_watches").select("job_id").eq("id", id);
    expect(String((truth.data ?? [])[0]?.job_id ?? "")).toBe(jobA);
    await svc().from("weather_watches").delete().eq("id", id);
  });

  it("a non-member cannot create a watch in someone else's org", async () => {
    const { error } = await db(userClient(outsiderToken))
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS7", job_id: jobA })
      .select("id")
      .single();
    expect(error, "a non-member created a watch").not.toBeNull();
  });

  it("org A cannot see org B's watch list — where a builder works is commercially sensitive", async () => {
    const { data, error } = await db(userClient(adminAToken))
      .from("weather_watches")
      .select("postcode_district")
      .eq("org_id", orgB);
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });

  // ── anchor cascades ───────────────────────────────────────────────────────

  it("deleting the anchored JOB removes the watch, not the other way round", async () => {
    const job = await svc()
      .from("jobs")
      .insert({ org_id: orgA, status: "new", notes: "Temporary job" })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    const jobId = String(job.data?.id ?? "");

    const watch = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS8", job_id: jobId })
      .select("id")
      .single();
    expect(watch.error, watch.error?.message).toBeNull();
    const watchId = String(watch.data?.id ?? "");

    // No RESTRICT anywhere: deleting the job must simply succeed.
    const del = await svc().from("jobs").delete().eq("id", jobId);
    expect(del.error, del.error?.message).toBeNull();

    const gone = await svc().from("weather_watches").select("id").eq("id", watchId);
    expect((gone.data ?? []).length).toBe(0);
  });

  it("a watch NEVER blocks retiring a depot — sites_delete_guard is untouched", async () => {
    const site = await svc()
      .from("sites")
      .insert({ org_id: orgA, name: "Doomed yard", kind: "lock_up" })
      .select("id")
      .single();
    expect(site.error, site.error?.message).toBeNull();
    const siteId = String(site.data?.id ?? "");

    const watch = await svc()
      .from("weather_watches")
      .insert({ org_id: orgA, postcode_district: "LS9", site_id: siteId })
      .select("id")
      .single();
    expect(watch.error, watch.error?.message).toBeNull();

    // The site delete guard counts vehicles and custody records ONLY. A weather
    // watch must never be able to make a depot undeletable.
    const del = await svc().from("sites").delete().eq("id", siteId);
    expect(del.error, del.error?.message).toBeNull();
  });

  // ── THE TEARDOWN PROOF (the 20261052 lesson) ──────────────────────────────

  it("`delete from organizations` STILL SUCCEEDS with watches present", async () => {
    // A new BEFORE DELETE trigger or a RESTRICT on a cascade child is exactly how
    // the 20261052 P1 would come back. This migration adds neither, and this is
    // the proof rather than the claim.
    const org = await makeOrg("Weather Teardown", `${TOKEN}-teardown`);
    const job = await svc()
      .from("jobs")
      .insert({ org_id: org, status: "new", notes: "Teardown job" })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    const site = await svc()
      .from("sites")
      .insert({ org_id: org, name: "Teardown yard", kind: "depot" })
      .select("id")
      .single();
    expect(site.error, site.error?.message).toBeNull();

    // One watch of each shape: job-anchored, site-anchored and standing.
    for (const patch of [
      { job_id: String(job.data?.id ?? "") },
      { site_id: String(site.data?.id ?? "") },
      {},
    ]) {
      const w = await svc()
        .from("weather_watches")
        .insert({ org_id: org, postcode_district: "TD1", ...patch })
        .select("id")
        .single();
      expect(w.error, w.error?.message).toBeNull();
    }

    const del = await svc().from("organizations").delete().eq("id", org);
    expect(del.error, `org teardown blocked: ${del.error?.message}`).toBeNull();

    const orgGone = await svc().from("organizations").select("id").eq("id", org);
    expect((orgGone.data ?? []).length).toBe(0);
  });

  it("org teardown leaves the GLOBAL cache untouched — weather is not tenant data", async () => {
    // The cache has no org_id and no FK to organizations, so a teardown cannot
    // reach it. Deleting a tenant must not destroy a fact about the world that
    // other tenants are still using.
    const before = await svc()
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_B);
    expect((before.data ?? []).length).toBeGreaterThan(0);

    const org = await makeOrg("Weather Teardown 2", `${TOKEN}-teardown2`);
    const w = await svc()
      .from("weather_watches")
      .insert({ org_id: org, postcode_district: DISTRICT_B })
      .select("id")
      .single();
    expect(w.error, w.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", org);
    expect(del.error, del.error?.message).toBeNull();

    const after = await svc()
      .from("weather_readings")
      .select("postcode_district")
      .eq("postcode_district", DISTRICT_B);
    expect((after.data ?? []).length).toBe((before.data ?? []).length);
  });

  // ── retention ─────────────────────────────────────────────────────────────

  it("purge_weather_readings is service_role only", async () => {
    const asAdmin = await rpc(userClient(adminAToken)).rpc("purge_weather_readings", {});
    expect(asAdmin.error, "an authenticated user could run the purge").not.toBeNull();

    const asAnon = await rpc(anonClient()).rpc("purge_weather_readings", {});
    expect(asAnon.error, "anon could run the purge").not.toBeNull();
  });

  it("the purge removes EXPIRED forecasts past the grace period and spares live ones", async () => {
    const district = "PL9";
    // Long expired.
    const stale = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: district,
        kind: "forecast",
        valid_at: new Date(Date.UTC(2020, 0, 1, 9)).toISOString(),
        expires_at: new Date(Date.UTC(2020, 0, 2, 9)).toISOString(),
      })
      .select("id")
      .single();
    expect(stale.error, stale.error?.message).toBeNull();

    // Far-future expiry — must survive.
    const live = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: district,
        kind: "forecast",
        valid_at: new Date(Date.UTC(2030, 0, 1, 9)).toISOString(),
        expires_at: new Date(Date.UTC(2030, 0, 2, 9)).toISOString(),
      })
      .select("id")
      .single();
    expect(live.error, live.error?.message).toBeNull();
    const liveId = String(live.data?.id ?? "");

    const purge = await rpc(serviceClient()).rpc("purge_weather_readings", {});
    expect(purge.error, purge.error?.message).toBeNull();

    const remaining = await svc()
      .from("weather_readings")
      .select("id")
      .eq("postcode_district", district);
    const ids = (remaining.data ?? []).map((r) => String(r.id));
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(String(stale.data?.id ?? ""));

    await svc().from("weather_readings").delete().eq("postcode_district", district);
  });

  it("the purge SPARES observations inside the retention window", async () => {
    const district = "PL6";
    const recent = await svc()
      .from("weather_readings")
      .insert({
        provider: "test-fixture",
        postcode_district: district,
        kind: "observation",
        // Within 24 months of now — a record of fact that must not be destroyed.
        valid_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      })
      .select("id")
      .single();
    expect(recent.error, recent.error?.message).toBeNull();

    const purge = await rpc(serviceClient()).rpc("purge_weather_readings", {});
    expect(purge.error, purge.error?.message).toBeNull();

    const still = await svc()
      .from("weather_readings")
      .select("id")
      .eq("postcode_district", district);
    expect((still.data ?? []).length).toBe(1);

    await svc().from("weather_readings").delete().eq("postcode_district", district);
  });
});
