import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * FEATURE 3 — staff notification privacy at the DATABASE (migration
 * 20261263000000), through real signed-in user JWTs (not the service role).
 *
 * The leak this proves is closed: an ORG-WIDE (user_id null) customer-audience
 * notification carrying billing / stripe / onboarding / migration / support
 * content used to be readable by EVERY member, so a non-admin staff member saw
 * company money + the CrewFlow relationship in their notifications centre.
 *
 * Proven, all via RLS (user JWTs):
 *   • owner / admin        → see every org-wide row (capabilities preserved).
 *   • non-admin staff      → see NONE of the sensitive org-wide rows.
 *   • staff                → DO see a row targeted at them (user_id = them);
 *                            do NOT see one targeted at another user.
 *   • staff                → see an org-wide 'all'-scope non-sensitive row.
 *   • assigned staff       → see an org-wide 'assigned' row for THEIR job only;
 *                            an unassigned staffer does not; and access is LOST
 *                            when the assignment is revoked.
 *   • cross-tenant         → a staff member of another org sees nothing here.
 *   • UPDATE               → staff cannot mark-read a row they cannot see.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: unknown[]): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Ins extends PromiseLike<Res<null>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(values: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());

const TOKEN = `nsp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let orgA = "";
let orgB = "";
let jobAssigned = ""; // in A, assigned to staffAssigned

// notification ids (all in orgA unless noted)
let nBilling = "";
let nStripe = "";
let nSupport = "";
let nOnboarding = "";
let nTargetedStaff = ""; // user_id = staff
let nTargetedOther = ""; // user_id = staffAssigned
let nAllOther = ""; //      org-wide, category other, scope 'all'
let nAssigned = ""; //      org-wide, category other, scope 'assigned', job = jobAssigned
let nHq = ""; //            audience hq
let nBillingB = ""; //      org-wide billing in orgB

const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await svc().from("users").insert({ id, email, full_name: `NSP ${suffix}` }).select("id").single();
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
    .insert({ name: `NSP ${suffix}`, slug: `${TOKEN}-${suffix}` })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

async function member(org: string, userId: string, role: string): Promise<void> {
  const r = await svc().from("memberships").insert({ org_id: org, user_id: userId, role });
  expect(r.error, r.error?.message).toBeNull();
}

async function makeNotif(row: Row): Promise<string> {
  const r = await svc()
    .from("notifications")
    .insert({ type: "test.event", title: "t", ...row })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

const uc = (who: string) => db(userClient(tok[who] ?? ""));

/** The set of orgA notification ids this user can SELECT via RLS. */
async function visibleInA(who: string): Promise<Set<string>> {
  const r = await uc(who).from("notifications").select("id").eq("org_id", orgA);
  expect(r.error, r.error?.message).toBeNull();
  return new Set((r.data ?? []).map((x) => x.id as string));
}

describeIntegration("notifications staff privacy (RLS)", () => {
  beforeAll(async () => {
    orgA = await makeOrg("orgA");
    orgB = await makeOrg("orgB");

    for (const who of ["owner", "admin", "staff", "staffAssigned", "ownerB", "staffB"]) {
      const u = await makeUser(who);
      tok[who] = u.token;
      uid[who] = u.id;
    }
    await member(orgA, uid.owner!, "owner");
    await member(orgA, uid.admin!, "admin");
    await member(orgA, uid.staff!, "staff");
    await member(orgA, uid.staffAssigned!, "staff");
    await member(orgB, uid.ownerB!, "owner");
    await member(orgB, uid.staffB!, "staff");

    // a job in A, assigned to staffAssigned via the Phase-1 table.
    const job = await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    expect(job.error, job.error?.message).toBeNull();
    jobAssigned = (job.data as { id: string }).id;
    const ja = await svc()
      .from("job_assignments")
      .insert({ org_id: orgA, job_id: jobAssigned, user_id: uid.staffAssigned! });
    expect(ja.error, ja.error?.message).toBeNull();

    // org-wide sensitive rows (default scope 'admins').
    nBilling = await makeNotif({ org_id: orgA, user_id: null, audience: "customer", category: "billing", title: "£500 invoice overdue" });
    nStripe = await makeNotif({ org_id: orgA, user_id: null, audience: "customer", category: "stripe", title: "Payment of £500 failed" });
    nSupport = await makeNotif({ org_id: orgA, user_id: null, audience: "customer", category: "support", title: "CrewFlow support replied" });
    nOnboarding = await makeNotif({ org_id: orgA, user_id: null, audience: "customer", category: "onboarding", title: "Onboarding 80%" });

    // targeted rows.
    nTargetedStaff = await makeNotif({ org_id: orgA, user_id: uid.staff!, audience: "customer", category: "other", title: "job.assigned to you" });
    nTargetedOther = await makeNotif({ org_id: orgA, user_id: uid.staffAssigned!, audience: "customer", category: "other", title: "for someone else" });

    // staff-eligible org-wide rows.
    nAllOther = await makeNotif({ org_id: orgA, user_id: null, audience: "customer", category: "other", audience_scope: "all", title: "Company-wide notice" });
    nAssigned = await makeNotif({
      org_id: orgA,
      user_id: null,
      audience: "customer",
      category: "other",
      audience_scope: "assigned",
      source_module: "jobs",
      source_id: jobAssigned,
      title: "Update on your job",
    });

    // hq row — never visible to a tenant via RLS.
    nHq = await makeNotif({ org_id: orgA, user_id: null, audience: "hq", category: "alert", title: "hq only" });

    // org B sensitive row.
    nBillingB = await makeNotif({ org_id: orgB, user_id: null, audience: "customer", category: "billing", title: "orgB money" });
  });

  it("owner sees every org-wide row (including sensitive)", async () => {
    const v = await visibleInA("owner");
    for (const id of [nBilling, nStripe, nSupport, nOnboarding, nAllOther, nAssigned]) {
      expect(v.has(id), `owner should see ${id}`).toBe(true);
    }
  });

  it("admin sees every org-wide row (including sensitive)", async () => {
    const v = await visibleInA("admin");
    for (const id of [nBilling, nStripe, nSupport, nOnboarding, nAllOther, nAssigned]) {
      expect(v.has(id), `admin should see ${id}`).toBe(true);
    }
  });

  it("non-admin staff sees NONE of the sensitive org-wide rows", async () => {
    const v = await visibleInA("staff");
    for (const id of [nBilling, nStripe, nSupport, nOnboarding]) {
      expect(v.has(id), `staff must NOT see ${id}`).toBe(false);
    }
  });

  it("staff sees a row targeted at them, not one targeted at another user", async () => {
    const v = await visibleInA("staff");
    expect(v.has(nTargetedStaff)).toBe(true);
    expect(v.has(nTargetedOther)).toBe(false);
  });

  it("staff sees an org-wide 'all'-scope non-sensitive row", async () => {
    const v = await visibleInA("staff");
    expect(v.has(nAllOther)).toBe(true);
  });

  it("assigned staff sees the 'assigned' row; unassigned staff does not", async () => {
    expect((await visibleInA("staffAssigned")).has(nAssigned)).toBe(true);
    expect((await visibleInA("staff")).has(nAssigned)).toBe(false);
  });

  it("no tenant sees the hq-audience row via RLS", async () => {
    for (const who of ["owner", "admin", "staff"]) {
      expect((await visibleInA(who)).has(nHq), `${who} must not see hq row`).toBe(false);
    }
  });

  it("cross-tenant: orgA staff sees nothing from orgB, orgB staff sees nothing from orgA", async () => {
    const aFromB = await uc("staff").from("notifications").select("id").eq("org_id", orgB);
    expect(aFromB.error, aFromB.error?.message).toBeNull();
    expect((aFromB.data ?? []).length).toBe(0);

    const bFromA = await uc("staffB").from("notifications").select("id").eq("org_id", orgA);
    expect(bFromA.error, bFromA.error?.message).toBeNull();
    expect((bFromA.data ?? []).length).toBe(0);
    // sanity: the orgB row exists (owner of B can see it).
    const ownerBView = await uc("ownerB").from("notifications").select("id").eq("org_id", orgB);
    expect((ownerBView.data ?? []).map((x) => x.id)).toContain(nBillingB);
  });

  it("staff CANNOT mark-read a sensitive org-wide row they cannot see", async () => {
    const upd = await uc("staff")
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", nBilling)
      .select("id");
    expect(upd.error, upd.error?.message).toBeNull();
    expect((upd.data ?? []).length, "RLS should block the update → 0 rows").toBe(0);
    // ground truth: still unread.
    const truth = await svc().from("notifications").select("read_at").eq("id", nBilling);
    expect((truth.data ?? [])[0]?.read_at ?? null).toBeNull();
  });

  it("revocation: unassigning the staffer removes their 'assigned' visibility", async () => {
    expect((await visibleInA("staffAssigned")).has(nAssigned)).toBe(true);
    const del = await svc().from("job_assignments").delete().eq("job_id", jobAssigned);
    expect(del.error, del.error?.message).toBeNull();
    expect((await visibleInA("staffAssigned")).has(nAssigned)).toBe(false);
  });
});
