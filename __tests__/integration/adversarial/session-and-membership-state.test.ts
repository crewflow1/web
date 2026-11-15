/* eslint-disable @typescript-eslint/no-explicit-any -- see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { describeIntegration, serviceClient } from "../_harness";
import {
  algNone,
  anonKey,
  as,
  createWorld,
  decodeJwt,
  destroyWorld,
  mkActor,
  mkOrg,
  rawFetch,
  signHs256,
  signIn,
  svc,
  tamperPayload,
  type Actor,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 4 (stale access, forged / tampered / expired JWTs, session invalidation) and
 * the membership-STATE half of ATTACK 3 (no onboarding, suspended / cancelled orgs).
 *
 * Two kinds of test live here, and the difference matters:
 *
 *   • ENFORCED — the control holds; a failure is a regression.
 *   • OPEN (register id in the title) — the suite asserts the behaviour the stack has
 *     TODAY, which the programme considers a gap awaiting a product decision. These are
 *     deliberately written to FAIL the day the gap is closed, so the register and this
 *     file get updated together instead of the gap being silently forgotten.
 *
 * "Document actual Supabase behaviour honestly": the password-change cases record what
 * GoTrue + PostgREST really do (see docs/programme/security-tenant/VULNERABILITY-REGISTER.md
 * ST-07c) rather than what one might assume.
 */

/**
 * The local stack signs HS256. The secret is taken from the environment when present;
 * otherwise the Supabase CLI's published local default is tried. Either way it is used
 * ONLY if it actually verifies the anon key's signature — so a wrong guess can never
 * make the "validly signed but expired" case pass vacuously.
 */
function localJwtSecret(): string | null {
  const candidates = [
    process.env.SUPABASE_JWT_SECRET,
    process.env.JWT_SECRET,
    "super-secret-jwt-token-with-at-least-32-characters-long",
  ].filter((s): s is string => Boolean(s));
  const [h, p, sig] = anonKey().split(".");
  for (const c of candidates) {
    const expect = createHmac("sha256", c).update(`${h}.${p}`).digest("base64url");
    if (expect === sig) return c;
  }
  return null;
}

describeIntegration("ADVERSARIAL · sessions, tokens and membership state", () => {
  let w: World | null = null;
  let customerB = "";
  const observed: Record<string, unknown> = {};

  /** Can this bearer read org B's customer row? (The canary for "has tenant access".) */
  const canReadB = async (bearer: string | null | undefined): Promise<boolean> => {
    const r = await rawFetch(`/rest/v1/customers?id=eq.${customerB}&select=id`, { bearer });
    return r.status === 200 && Array.isArray(r.json) && r.json.length === 1;
  };
  const status = async (bearer: string): Promise<number> =>
    (await rawFetch(`/rest/v1/customers?id=eq.${customerB}&select=id`, { bearer })).status;

  beforeAll(async () => {
    w = await createWorld("sectenant-sess");
    const c = await svc().from("customers").insert({ org_id: w.B.id, name: `Canary ${w.tag}` }).select("id").single();
    if (c.error) throw new Error(c.error.message);
    customerB = (c.data as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    writeReport("session-behaviour.json", observed);
    await destroyWorld(w);
  }, 120_000);

  // ── forged / tampered / expired tokens ─────────────────────────────────────

  it("control: org B's owner reads the canary; org A's owner and anon do not", async () => {
    const world = w!;
    expect(await canReadB(world.B.owner.token)).toBe(true);
    expect(await canReadB(world.A.owner.token)).toBe(false);
    expect(await canReadB(undefined)).toBe(false);
  });

  it("ENFORCED · a JWT signed with the wrong key is rejected (forged identity of B's owner)", async () => {
    const world = w!;
    const { payload } = decodeJwt(world.B.owner.token);
    const forged = signHs256(payload, "not-the-project-secret-not-the-project-secret");
    expect(await status(forged)).toBe(401);
    expect(await canReadB(forged)).toBe(false);
    // A service_role claim signed with the wrong key is just as worthless.
    const fakeService = signHs256({ role: "service_role", iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 }, "x".repeat(40));
    expect(await status(fakeService)).toBe(401);
  });

  it("ENFORCED · a tampered payload (sub := B's owner / role := service_role) with the original signature is rejected", async () => {
    const world = w!;
    for (const patch of [{ sub: world.B.owner.id }, { role: "service_role" }, { exp: 9999999999 }]) {
      const t = tamperPayload(world.A.owner.token, patch);
      expect(await status(t), JSON.stringify(patch)).toBe(401);
      expect(await canReadB(t)).toBe(false);
    }
  });

  it("ENFORCED · alg:none and an empty signature are rejected", async () => {
    const world = w!;
    const none = algNone(world.B.owner.token);
    expect(await status(none)).toBe(401);
    const [h, p] = world.B.owner.token.split(".");
    expect(await status(`${h}.${p}.`)).toBe(401);
    expect(await canReadB(none)).toBe(false);
  });

  it("ENFORCED · a correctly signed but EXPIRED token is rejected", async (ctx) => {
    const world = w!;
    const secret = localJwtSecret();
    if (!secret) {
      // Cannot mint a validly-signed token without the project secret. Recorded, not hidden.
      observed.expiredTokenCase = "SKIPPED — JWT secret not available to the test process";
      ctx.skip();
      return;
    }
    const { payload } = decodeJwt(world.B.owner.token);
    // Sanity: re-signing the live payload with this secret yields a WORKING token, so the
    // only thing wrong with the next one is its expiry.
    expect(await canReadB(signHs256(payload, secret))).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    const expired = signHs256({ ...payload, iat: now - 7200, exp: now - 3600 }, secret);
    expect(await status(expired)).toBe(401);
    expect(await canReadB(expired)).toBe(false);
    observed.expiredTokenCase = "rejected (401)";
  });

  // ── stale access ───────────────────────────────────────────────────────────

  it("ENFORCED · removing a member revokes Data API access IMMEDIATELY, even though their JWT is still valid", async () => {
    const world = w!;
    const leaver = await mkActor(world.tag, "leaver", world.B.id, "admin");
    world.extras.push(leaver);
    expect(await canReadB(leaver.token)).toBe(true);
    const del = await svc().from("memberships").delete().eq("org_id", world.B.id).eq("user_id", leaver.id);
    expect(del.error).toBeNull();
    // Same token, no refresh, no wait: RLS reads memberships live.
    expect(await canReadB(leaver.token)).toBe(false);
    const write = await as(leaver.token).from("customers").update({ name: "pwned" }).eq("id", customerB).select("id");
    expect(write.data ?? []).toEqual([]);
    // …and a freshly REFRESHED token is no better.
    const refreshed = await rawFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: leaver.refreshToken } });
    if (refreshed.status === 200) expect(await canReadB(refreshed.json.access_token)).toBe(false);
  });

  it("ENFORCED · demoting an admin to staff takes effect on their existing JWT", async () => {
    const world = w!;
    const demoted = await mkActor(world.tag, "demoted", world.B.id, "admin");
    world.extras.push(demoted);
    const inv = await svc().from("invoices").insert({ org_id: world.B.id, number: `INV-${world.tag}-d`, amount: 1 }).select("id").single();
    const invoiceId = (inv.data as { id: string }).id;
    const sees = async () => ((await as(demoted.token).from("invoices").select("id").eq("id", invoiceId)).data ?? []).length;
    expect(await sees()).toBe(1);
    await svc().from("memberships").update({ role: "staff" }).eq("org_id", world.B.id).eq("user_id", demoted.id);
    expect(await sees()).toBe(0);
  });

  it("ENFORCED · a deleted auth user's still-valid JWT reaches nothing", async () => {
    const world = w!;
    const ghost = await mkActor(world.tag, "ghost", world.B.id, "owner");
    expect(await canReadB(ghost.token)).toBe(true);
    await svc().from("users").delete().eq("id", ghost.id); // cascades the membership
    await serviceClient().auth.admin.deleteUser(ghost.id);
    expect(await canReadB(ghost.token)).toBe(false);
  });

  it("ENFORCED · a multi-org user's reach is exactly the union of their memberships, and shrinks when one is removed", async () => {
    // RLS is membership-scoped, NOT active-org-scoped: the `active_org_id` cookie is an
    // application pin (server/auth/session.ts), so a direct Data API caller who belongs
    // to A and B reads both regardless of which org is "active". That is by design; what
    // must hold is that it is never MORE than the union, and follows membership changes.
    const world = w!;
    const dual = await mkActor(world.tag, "dual", world.A.id, "staff");
    world.extras.push(dual);
    expect(await canReadB(dual.token)).toBe(false);
    await svc().from("memberships").insert({ org_id: world.B.id, user_id: dual.id, role: "owner" });
    expect(await canReadB(dual.token)).toBe(true);
    const orgs = await as(dual.token).rpc("current_org_ids");
    expect(new Set(orgs.data as string[])).toEqual(new Set([world.A.id, world.B.id]));
    // A forged "active org" cannot widen anything: there is no claim/header PostgREST honours.
    const spoof = await rawFetch(`/rest/v1/customers?id=eq.${customerB}&select=id`, {
      bearer: world.A.owner.token,
      headers: { Cookie: `active_org_id=${world.B.id}`, "x-active-org-id": world.B.id },
    });
    expect(spoof.json).toEqual([]);
    await svc().from("memberships").delete().eq("org_id", world.B.id).eq("user_id", dual.id);
    expect(await canReadB(dual.token)).toBe(false);
  });

  it("OPEN ST-07d · a worker who belongs to TWO orgs has ONE pay row: each employer's admin reads (and can overwrite) the rate the other set", async () => {
    // staff_compensation is keyed by user_id alone — there is no org_id. can_read_/
    // can_write_compensation() pass for an owner/admin of ANY org the worker belongs to.
    // So for a shared worker (a subcontractor on two firms' books) org A's admin sees the
    // hourly rate and emergency contact org B recorded, and can change them. Only arises
    // for multi-org users (production has none today — read-only aggregate, 2026-11-13).
    // Fix needs a schema change (org_id on staff_compensation); asserts TODAY's behaviour.
    const world = w!;
    const shared = await mkActor(world.tag, "shared-worker", world.A.id, "staff");
    world.extras.push(shared);
    await svc().from("memberships").insert({ org_id: world.B.id, user_id: shared.id, role: "staff" });
    const set = await as(world.B.admin.token)
      .from("staff_compensation")
      .upsert({ user_id: shared.id, hourly_pay: 27.5, emergency_contact: { name: "Set by org B", phone: "07700900001", relationship: "x" } }, { onConflict: "user_id" });
    expect(set.error, JSON.stringify(set.error)).toBeNull();
    const seenByA = await as(world.A.admin.token).from("staff_compensation").select("hourly_pay, emergency_contact").eq("user_id", shared.id);
    expect((seenByA.data ?? []).length, "CURRENT behaviour: org A's admin reads the rate org B set").toBe(1);
    expect(Number((seenByA.data as any[])[0].hourly_pay)).toBe(27.5);
    // Bounded: an admin of an org the worker does NOT belong to sees nothing.
    await svc().from("memberships").delete().eq("org_id", world.A.id).eq("user_id", shared.id);
    const afterLeaving = await as(world.A.admin.token).from("staff_compensation").select("hourly_pay").eq("user_id", shared.id);
    expect(afterLeaving.data ?? []).toEqual([]);
  });

  it("ENFORCED · a user cannot grant themselves an invite: app_metadata is not user-writable", async () => {
    // acceptOrgInvite (app/onboarding/join/actions.ts) trusts app_metadata.invited_org_id.
    // Prove the anchor is out of the user's reach: updateUser({data}) lands in
    // user_metadata only, and a direct app_metadata write is ignored.
    const world = w!;
    const sneaky = await mkActor(world.tag, "sneaky", null, null);
    world.extras.push(sneaky);
    for (const body of [
      { data: { invited_org_id: world.B.id, invited_role: "admin" } },
      { app_metadata: { invited_org_id: world.B.id, invited_role: "admin" } },
      { raw_app_meta_data: { invited_org_id: world.B.id, invited_role: "admin" } },
    ]) {
      await rawFetch("/auth/v1/user", { method: "PUT", bearer: sneaky.token, body });
    }
    const fresh = await serviceClient().auth.admin.getUserById(sneaky.id);
    expect((fresh.data.user?.app_metadata as any)?.invited_org_id).toBeUndefined();
    expect((fresh.data.user?.app_metadata as any)?.invited_role).toBeUndefined();
    expect(await canReadB(sneaky.token)).toBe(false);
  });

  // ── session invalidation on password change (documented behaviour) ─────────

  it("DOCUMENTED · password change: which other sessions die, and when (ST-07c)", async () => {
    const world = w!;
    const victim = await mkActor(world.tag, "pwchange", world.B.id, "staff");
    world.extras.push(victim);
    // Two independent sessions for the same user: the attacker's (stolen) and the owner's.
    const stolen = await signIn(victim.email, victim.password);
    const mine = await signIn(victim.email, victim.password);
    await svc().from("customers").update({ name: "canary" }).eq("id", customerB); // no-op touch

    // The user changes their password from `mine`.
    const newPassword = `${victim.password}-rotated`;
    const change = await rawFetch("/auth/v1/user", { method: "PUT", bearer: mine.token, body: { password: newPassword } });
    observed.passwordChangeStatus = change.status;
    expect(change.status).toBe(200);

    // 1. The old password no longer signs in.
    const oldPw = await rawFetch("/auth/v1/token?grant_type=password", { method: "POST", body: { email: victim.email, password: victim.password } });
    expect(oldPw.status).toBeGreaterThanOrEqual(400);

    // 2. The stolen session's ACCESS token: a JWT is stateless, so PostgREST keeps
    //    honouring it until it expires (jwt_expiry, 3600s locally).
    const staffReadable = async (bearer: string) =>
      (await rawFetch(`/rest/v1/memberships?org_id=eq.${world.B.id}&select=id&limit=1`, { bearer })).json?.length === 1;
    observed.stolenAccessTokenStillWorksOnDataApi = await staffReadable(stolen.token);
    // 3. GoTrue's own view of that session (what the Next.js server checks on every
    //    request via supabase.auth.getUser()).
    const gotrueUser = await rawFetch("/auth/v1/user", { bearer: stolen.token });
    observed.stolenAccessTokenGoTrueUserStatus = gotrueUser.status;
    // 4. The stolen session's REFRESH token — can it mint a new access token?
    const refresh = await rawFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: stolen.refreshToken } });
    observed.stolenRefreshTokenStatus = refresh.status;

    // What we ASSERT is only what the platform guarantees and the product relies on:
    expect(observed.stolenAccessTokenStillWorksOnDataApi, "an unexpired access token is honoured by PostgREST until exp — if this ever becomes false, update ST-07c").toBe(true);
    // The remaining two are recorded in the evidence report and the register verbatim.
    expect([200, 401, 403]).toContain(observed.stolenAccessTokenGoTrueUserStatus);
    expect([200, 400, 401, 403]).toContain(observed.stolenRefreshTokenStatus);
  });

  it("ENFORCED · an admin-forced sign-out revokes the refresh token (the access token still runs to expiry)", async () => {
    const world = w!;
    const u = await mkActor(world.tag, "signout", world.B.id, "staff");
    world.extras.push(u);
    const out = await rawFetch("/auth/v1/logout?scope=global", { method: "POST", bearer: u.token });
    expect([200, 204]).toContain(out.status);
    const refresh = await rawFetch("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: u.refreshToken } });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    observed.afterGlobalLogoutGoTrueUserStatus = (await rawFetch("/auth/v1/user", { bearer: u.token })).status;
  });

  // ── membership STATE: no onboarding, suspended, cancelled ──────────────────

  it("ENFORCED · a signed-up user with NO organisation cannot create one, join one, or read any tenant row", async () => {
    const world = w!;
    const fresh = await mkActor(world.tag, "fresh", null, null);
    world.extras.push(fresh);
    const c = as(fresh.token);
    const orgIns = await c.from("organizations").insert({ name: "self-made", slug: `${world.tag}-selfmade`, status: "active", plan: "enterprise" });
    expect(orgIns.error).not.toBeNull();
    const memIns = await c.from("memberships").insert({ org_id: world.B.id, user_id: fresh.id, role: "owner" });
    expect(memIns.error).not.toBeNull();
    expect(((await c.from("organizations").select("id")).data ?? []).length).toBe(0);
    expect(((await c.from("memberships").select("id")).data ?? []).length).toBe(0);
    expect(await canReadB(fresh.token)).toBe(false);
    // They can read exactly one users row: their own.
    const users = await c.from("users").select("id");
    expect((users.data ?? []).map((u: any) => u.id)).toEqual([fresh.id]);
    const made = await svc().from("organizations").select("id").eq("slug", `${world.tag}-selfmade`);
    expect(made.data).toEqual([]);
  });

  for (const state of ["suspended", "cancelled", "rejected", "pending"] as const) {
    it(`OPEN ST-07b · a member of a ${state.toUpperCase()} org keeps full Data API access to that org (the status gate is application-only)`, async () => {
      // server/auth/session.ts → requireOrgContext() redirects a non active/trial org to
      // /access-pending. current_org_ids() does not look at organizations.status, so the
      // SAME session used directly against PostgREST still reads and writes the org's
      // data. Own-org only (no cross-tenant reach) — a commercial / abuse-hold bypass.
      const world = w!;
      const orgId = await mkOrg(world.tag, `st-${state}`, { status: state });
      world.extraOrgIds.push(orgId);
      const member: Actor = await mkActor(world.tag, `m-${state}`, orgId, "owner");
      world.extras.push(member);
      const cust = await svc().from("customers").insert({ org_id: orgId, name: "held" }).select("id").single();
      const id = (cust.data as { id: string }).id;

      const read = await as(member.token).from("customers").select("id").eq("id", id);
      const write = await as(member.token).from("customers").insert({ org_id: orgId, name: "written while held" }).select("id");
      const reach = { read: (read.data ?? []).length === 1, write: write.error === null };
      observed[`org_${state}`] = reach;
      // CURRENT behaviour. When ST-07b is fixed these flip to false — update the register.
      expect(reach).toEqual({ read: true, write: true });
      // And it is strictly own-org: the held org's member still cannot touch org B.
      expect(await canReadB(member.token)).toBe(false);
    });
  }
});
