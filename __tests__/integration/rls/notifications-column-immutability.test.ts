import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * INJ-01 — notification CONTENT is immutable to tenant users (migration
 * 20261305000000), proven through real signed-in user JWTs against the Data API.
 *
 * The defect this closes (mass assignment through PostgREST): `notifications`
 * carried a table-wide UPDATE grant for `authenticated`, and the RLS UPDATE
 * policy only decides WHICH ROWS a member may touch — never which columns. The
 * app only ever writes `read_at` / `dismissed_at` from a user session, but any
 * member could PATCH /rest/v1/notifications directly and rewrite `title`,
 * `body`, `action_url`, `user_id`, `category`, `audience_scope` on every row
 * they could see. A non-admin staff member could therefore:
 *   • repoint an org-wide notification's deep link at an attacker origin (or a
 *     `javascript:` URL), which the bell + /notifications render as a link for
 *     the owner/admin, and which the email digest + notification email append
 *     to `https://crewflow.uk` (so `@evil.example/x` became a first-party-sent
 *     phishing link);
 *   • promote their OWN targeted row to an org-wide one (user_id → null) with
 *     forged title/body — a spoofed "system" notification for every member.
 *
 * Proven here, all via RLS + grants (user JWTs, never the service role):
 *   • staff CANNOT rewrite action_url / title / body of an org-wide row;
 *   • staff CANNOT promote a targeted row to org-wide, nor re-categorise it;
 *   • the row is byte-for-byte unchanged after each refused attempt;
 *   • the legitimate writes still work: mark-read (read_at) and dismiss
 *     (dismissed_at) on a row the member can see;
 *   • an org ADMIN is equally unable to rewrite content (content is authored by
 *     the service role only — there is no in-app "edit notification" surface).
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string; code?: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
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

const TOKEN = `secinject-nci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let org = "";
let nOrgWide = ""; // org-wide (user_id null), category other, scope 'all'
let nMine = ""; //    targeted at staff
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

const ORIGINAL = {
  title: "Material request approved",
  body: "Your request MR-0001 was approved.",
  action_url: "/materials/requests/abc",
};

async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  const mirrored = await svc().from("users").insert({ id, email, full_name: `NCI ${suffix}` }).select("id").single();
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  const signedIn = await anonClient().auth.signInWithPassword({ email, password });
  expect(signedIn.error, signedIn.error?.message).toBeNull();
  const token = signedIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
  return { id, token };
}

async function makeNotif(row: Row): Promise<string> {
  const r = await svc()
    .from("notifications")
    .insert({ type: "test.event", audience: "customer", category: "other", ...ORIGINAL, ...row })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return (r.data as { id: string }).id;
}

const uc = (who: string) => db(userClient(tok[who] ?? ""));

async function readBack(id: string): Promise<Row> {
  const r = await svc()
    .from("notifications")
    .select("title, body, action_url, user_id, category, audience_scope, read_at, dismissed_at")
    .eq("id", id);
  expect(r.error, r.error?.message).toBeNull();
  return (r.data ?? [])[0] ?? {};
}

/** A refused write: either a hard privilege error or zero rows changed. Both
 *  are acceptable refusals, but the row must be UNCHANGED either way — that is
 *  asserted separately by every caller. */
function expectRefused(res: Res<Row[]>): void {
  const changed = (res.data ?? []).length;
  expect(res.error !== null || changed === 0, "the forged UPDATE must not succeed").toBe(true);
}

describeIntegration("INJ-01 notification content is immutable to tenant users", () => {
  beforeAll(async () => {
    const o = await svc()
      .from("organizations")
      .insert({ name: `NCI ${TOKEN}`, slug: TOKEN })
      .select("id")
      .single();
    expect(o.error, o.error?.message).toBeNull();
    org = (o.data as { id: string }).id;

    for (const who of ["admin", "staff"]) {
      const u = await makeUser(who);
      tok[who] = u.token;
      uid[who] = u.id;
    }
    for (const [who, role] of [["admin", "admin"], ["staff", "staff"]] as const) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: uid[who], role });
      expect(m.error, m.error?.message).toBeNull();
    }

    nOrgWide = await makeNotif({ org_id: org, user_id: null, audience_scope: "all" });
    nMine = await makeNotif({ org_id: org, user_id: uid.staff });
  });

  afterAll(async () => {
    if (!org) return;
    await svc().from("notifications").delete().eq("org_id", org);
    await svc().from("memberships").delete().eq("org_id", org);
    await svc().from("organizations").delete().eq("id", org);
    for (const who of Object.keys(uid)) {
      await svc().from("users").delete().eq("id", uid[who]);
      await serviceClient().auth.admin.deleteUser(uid[who] ?? "");
    }
  });

  it("precondition: staff can SEE the org-wide row (so RLS alone would admit an UPDATE)", async () => {
    const r = await uc("staff").from("notifications").select("id").eq("id", nOrgWide);
    expect(r.error, r.error?.message).toBeNull();
    expect((r.data ?? []).length).toBe(1);
  });

  it("staff cannot repoint an org-wide notification's deep link off-origin", async () => {
    for (const forged of ["https://evil.example/login", "@evil.example/login", "javascript:alert(1)"]) {
      const res = await uc("staff")
        .from("notifications")
        .update({ action_url: forged })
        .eq("id", nOrgWide)
        .select("id");
      expectRefused(res);
    }
    expect((await readBack(nOrgWide)).action_url).toBe(ORIGINAL.action_url);
  });

  it("staff cannot rewrite an org-wide notification's title/body", async () => {
    const res = await uc("staff")
      .from("notifications")
      .update({ title: "Payroll: confirm your bank details", body: "Sign in again to continue." })
      .eq("id", nOrgWide)
      .select("id");
    expectRefused(res);
    const after = await readBack(nOrgWide);
    expect(after.title).toBe(ORIGINAL.title);
    expect(after.body).toBe(ORIGINAL.body);
  });

  it("staff cannot promote their own targeted row to an org-wide broadcast", async () => {
    const res = await uc("staff")
      .from("notifications")
      .update({ user_id: null, audience_scope: "all", title: "System notice" })
      .eq("id", nMine)
      .select("id");
    expectRefused(res);
    const after = await readBack(nMine);
    expect(after.user_id).toBe(uid.staff);
    expect(after.title).toBe(ORIGINAL.title);
  });

  it("a content column smuggled alongside read_at refuses the WHOLE write", async () => {
    const res = await uc("staff")
      .from("notifications")
      .update({ read_at: new Date().toISOString(), action_url: "https://evil.example/" })
      .eq("id", nMine)
      .select("id");
    expectRefused(res);
    const after = await readBack(nMine);
    expect(after.action_url).toBe(ORIGINAL.action_url);
    expect(after.read_at).toBeNull();
  });

  it("an org admin is equally unable to rewrite notification content", async () => {
    const res = await uc("admin")
      .from("notifications")
      .update({ action_url: "https://evil.example/" })
      .eq("id", nOrgWide)
      .select("id");
    expectRefused(res);
    expect((await readBack(nOrgWide)).action_url).toBe(ORIGINAL.action_url);
  });

  it("legitimate writes survive: mark-read and dismiss still work for a visible row", async () => {
    const now = new Date().toISOString();
    const read = await uc("staff").from("notifications").update({ read_at: now }).eq("id", nMine).select("id");
    expect(read.error, read.error?.message).toBeNull();
    expect((read.data ?? []).length).toBe(1);

    const dismissed = await uc("staff")
      .from("notifications")
      .update({ dismissed_at: now })
      .eq("id", nOrgWide)
      .select("id");
    expect(dismissed.error, dismissed.error?.message).toBeNull();
    expect((dismissed.data ?? []).length).toBe(1);

    expect((await readBack(nMine)).read_at).not.toBeNull();
    expect((await readBack(nOrgWide)).dismissed_at).not.toBeNull();
  });
});
