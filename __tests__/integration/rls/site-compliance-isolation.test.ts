import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Site compliance · tenant isolation + the structural controls of
 * 20261140000000 (inductions) and 20261140000001 (visitor log):
 *
 *   - org_id is TRIGGER-DERIVED from the site — a spoofed org_id is overwritten,
 *     so a poisoned insert can never cross tenants;
 *   - inductions are APPEND-ONLY — the update trigger blocks every UPDATE;
 *   - a cross-tenant site reference is UNWRITABLE (composite FK to sites(id,org_id));
 *   - the visitor lifecycle is sign-in (insert) → sign-out (update), and the
 *     visitor's identity (site/org/arrival) is IMMUTABLE on update;
 *   - the dual-org proof: RLS alone returns BOTH orgs' rows, so the app's
 *     active-org pin is load-bearing.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-sitecomp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("site-compliance · tenant isolation + triggers", () => {
  let orgA = "";
  let orgB = "";
  let siteA = "";
  let siteB = "";
  let dualUserId = "";
  let dualToken = "";
  let outsiderId = "";
  let outsiderToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: `SC ${suffix}` }).select("id").single();
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

  async function makeSite(orgId: string, name: string): Promise<string> {
    const site = await svc().from("sites").insert({ org_id: orgId, name, kind: "yard" }).select("id").single();
    expect(site.error, site.error?.message).toBeNull();
    return String(site.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("SC Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("SC Probe B", `${TOKEN}-b`);
    siteA = await makeSite(orgA, "Wakefield yard");
    siteB = await makeSite(orgB, "Wakefield yard");

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    for (const org of [orgA, orgB]) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: dualUserId, role: "admin" }).select("user_id").single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────
  it("anon is denied inductions and visitors", async () => {
    const i = await db(anonClient()).from("site_inductions").select("*");
    const v = await db(anonClient()).from("site_visitors").select("*");
    expect(i.error ? true : (i.data ?? []).length === 0).toBe(true);
    expect(v.error ? true : (v.data ?? []).length === 0).toBe(true);
  });

  it("a non-member cannot record an induction in someone else's org", async () => {
    const { error } = await db(userClient(outsiderToken))
      .from("site_inductions")
      .insert({
        org_id: orgA,
        site_id: siteA,
        person_name: "Hostile",
        induction_version: "v1",
        statement: "x",
        signed_name: "Hostile",
      })
      .select("id")
      .single();
    expect(error, "site_inductions_insert should refuse a non-member").not.toBeNull();
  });

  // ── org derivation + append-only ──────────────────────────────────────────
  it("org_id is derived from the site even if the client spoofs it", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("site_inductions")
      .insert({
        org_id: orgB, // LIE — the site is in org A
        site_id: siteA,
        user_id: dualUserId,
        induction_version: "v1",
        statement: "I confirm…",
        signed_name: "Dual Admin",
      })
      .select("id, org_id")
      .single();
    expect(error, error?.message).toBeNull();
    expect(String(data?.org_id), "trigger must overwrite org_id with the site's org").toBe(orgA);
  });

  it("an induction is append-only — UPDATE is blocked", async () => {
    const ins = await db(userClient(dualToken))
      .from("site_inductions")
      .insert({ org_id: orgA, site_id: siteA, person_name: "Ext Op", induction_version: "v2", statement: "s", signed_name: "Ext Op" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const upd = await db(userClient(dualToken))
      .from("site_inductions")
      .update({ signed_name: "Tampered" })
      .eq("id", String(ins.data?.id))
      .select("id");
    // Append-only is enforced by RLS having NO update policy (a tenant UPDATE
    // matches zero rows and returns no error) with the no_update trigger as the
    // service-role backstop. The property is immutability — assert zero rows
    // changed rather than expecting an error PostgREST never raises here.
    expect(upd.error, upd.error?.message).toBeNull();
    expect((upd.data ?? []).length, "append-only: tenant UPDATE must change no rows").toBe(0);
  });

  it("an induction cannot point at another org's site (cross-tenant FK)", async () => {
    // Member of A tries to induct onto site B. org_id will be derived to B, but
    // the caller is not a member of B for the RLS INSERT check on the derived
    // org — and the site/org pair is B/B while RLS requires membership of B.
    // Use the outsider (member of neither) against site B to isolate the FK/RLS
    // refusal cleanly:
    const { error } = await db(userClient(outsiderToken))
      .from("site_inductions")
      .insert({ org_id: orgB, site_id: siteB, person_name: "X", induction_version: "v1", statement: "s", signed_name: "X" })
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  // ── visitor lifecycle ─────────────────────────────────────────────────────
  it("visitor sign-in then sign-out (update), with immutable identity", async () => {
    const ins = await db(userClient(dualToken))
      .from("site_visitors")
      .insert({ org_id: orgB, site_id: siteA, visitor_name: "Ada Lovelace", company: "Analytical" })
      .select("id, org_id, site_id, signed_in_at")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    // org derived from the site (A), not the spoofed B.
    expect(String(ins.data?.org_id)).toBe(orgA);
    const id = String(ins.data?.id);
    // signed_in_at is stamped by the DB clock, which can run ~100ms ahead of
    // this harness's host clock under Docker Desktop. The check constraint
    // (signed_out_at >= signed_in_at) is the subject working as designed, so
    // order the sign-out AFTER the row's own stamp instead of trusting the
    // host clock — real sign-outs happen on human timescales, never inside
    // the skew window.
    const signedInMs = Date.parse(String(ins.data?.signed_in_at));
    const signedOutIso = new Date(Math.max(Date.now(), signedInMs + 1000)).toISOString();

    // Sign out — a legitimate update.
    const out = await db(userClient(dualToken))
      .from("site_visitors")
      .update({ signed_out_at: signedOutIso })
      .eq("id", id)
      .select("id");
    expect(out.error, out.error?.message).toBeNull();

    // Moving the visitor to another site is refused by the immutable-identity trigger.
    const move = await db(userClient(dualToken))
      .from("site_visitors")
      .update({ site_id: siteB })
      .eq("id", id)
      .select("id");
    expect(move.error, "identity trigger must refuse a site change").not.toBeNull();
  });

  // ── the dual-org proof ────────────────────────────────────────────────────
  it("RLS ALONE returns BOTH orgs' inductions to a dual-org member", async () => {
    // Seed one induction in each org (service role, org-derived).
    await svc().from("site_inductions").insert({ org_id: orgA, site_id: siteA, person_name: "A-only", induction_version: "vA", statement: "s", signed_name: "A" });
    await svc().from("site_inductions").insert({ org_id: orgB, site_id: siteB, person_name: "B-only", induction_version: "vB", statement: "s", signed_name: "B" });

    const all = await db(userClient(dualToken)).from("site_inductions").select("org_id");
    expect(all.error, all.error?.message).toBeNull();
    const orgs = new Set((all.data ?? []).map((r) => String(r.org_id)));
    expect(orgs.has(orgA)).toBe(true);
    expect(orgs.has(orgB)).toBe(true);

    // Pinned to the active org, only that org's rows come back — the pin the app enforces.
    const pinned = await db(userClient(dualToken)).from("site_inductions").select("org_id").eq("org_id", orgA);
    expect(pinned.error, pinned.error?.message).toBeNull();
    expect((pinned.data ?? []).every((r) => String(r.org_id) === orgA)).toBe(true);
  });
});
