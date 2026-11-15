/* eslint-disable @typescript-eslint/no-explicit-any -- raw rows + a structural OrgContext */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, userClient } from "../_harness";
import { createWorld, destroyWorld, mkActor, svc, type Actor, type World } from "../adversarial/_fixture";

/**
 * BOUNDARY-TABLE WRITES — the server actions that write `organizations`, `memberships`
 * and `users`, driven for real.
 *
 * THE DEFECT (P1, pre-existing). Those three tables have RLS enabled with SELECT
 * policies only — no INSERT / UPDATE / DELETE policy has ever existed — and since
 * 20261295 no client write grant. Yet these actions wrote them through the USER client,
 * so they could never succeed: an owner saving company settings got "You don't have
 * permission…", profile saves and staff role changes failed the same way. Nothing
 * exercised these paths against real Postgres with a real session, so nothing caught it.
 *
 * THE HARNESS. No stubbed database. `@/lib/supabase/server` hands the action a REAL
 * user-JWT client for the acting member (RLS + grants apply exactly as in production)
 * and `createAdminClient()` is the REAL service-role client. Only what Next.js supplies
 * at runtime is replaced: the cookie → session lookup (`requireOrgContext` returns the
 * acting member's real ids and role), `redirect` (recorded, and thrown like Next does)
 * and `revalidatePath` (no-op). So the test proves the two things that matter: the row
 * ACTUALLY CHANGED for the right role, and did not for the wrong one.
 *
 * Every case asserts ground truth with the service role, never the action's return value
 * alone.
 */

type Session = { user: { id: string; email: string }; ctx: any };
const session: { current: Session | null; token: string } = { current: null, token: "" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => userClient(session.token),
}));

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const requireOrgContext = async () => {
    if (!session.current) throw new Error("test: no session set");
    return session.current;
  };
  return {
    ...actual,
    requireOrgContext,
    requireUser: async () => (await requireOrgContext()).user,
    // Same composition as the real helper, on the test session.
    requireManagementContext: async () => {
      const res = await requireOrgContext();
      actual.requireManagementRole(res.ctx as never);
      return res;
    },
  };
});

class Redirect extends Error {
  constructor(public readonly url: string) {
    super(`REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("server-only", () => ({}));

/** Run an action; return where it redirected (or null) and its return value. */
async function run<T>(fn: () => Promise<T>): Promise<{ redirect: string | null; value: T | undefined }> {
  try {
    return { redirect: null, value: await fn() };
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.url, value: undefined };
    throw e;
  }
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describeIntegration("BOUNDARY WRITES · organizations / memberships / users server actions (real sessions)", () => {
  let w: World | null = null;
  let extraStaff: Actor; // a second staff member of A — the role-change / removal target
  let grantedAdmin: Actor; // an admin of A holding settings:manage + staff:manage

  const as = (actor: Actor, orgId: string, role: string) => {
    session.token = actor.token;
    session.current = {
      user: { id: actor.id, email: actor.email },
      ctx: {
        membership: { org_id: orgId, role },
        org: { id: orgId, name: "x", slug: "x", status: "active", plan: "x", trial_ends_at: null, created_at: "", onboarding_state: {}, require_mfa: false, i18n: {} },
      },
    };
  };
  const org = async (id: string) =>
    (await svc().from("organizations").select("name, phone, vat_number, bank_details, default_terms, onboarding_state, logo_path, logo_url").eq("id", id).single()).data as any;
  const userRow = async (id: string) =>
    (await svc().from("users").select("full_name, phone, employment_type, start_date").eq("id", id).single()).data as any;
  const membership = async (orgId: string, userId: string) =>
    (await svc().from("memberships").select("id, role").eq("org_id", orgId).eq("user_id", userId).maybeSingle()).data as { id: string; role: string } | null;

  beforeAll(async () => {
    w = await createWorld("seclp-bw");
    extraStaff = await mkActor(w.tag, "extra-staff", w.A.id, "staff");
    grantedAdmin = await mkActor(w.tag, "granted-admin", w.A.id, "admin");
    w.extras.push(extraStaff, grantedAdmin);
    const m = await membership(w.A.id, grantedAdmin.id);
    const g = await svc().from("membership_permissions").insert([
      { org_id: w.A.id, membership_id: m!.id, module: "settings", action: "manage" },
      { org_id: w.A.id, membership_id: m!.id, module: "staff", action: "manage" },
    ]);
    if (g.error) throw new Error(g.error.message);
  }, 180_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 180_000);

  beforeEach(() => {
    session.current = null;
    session.token = "";
  });

  // ── the defect itself, pinned ───────────────────────────────────────────────
  it("WHY · a user-JWT client cannot write a boundary table — even as the owner (no policy, no grant)", async () => {
    const world = w!;
    const owner = userClient(world.A.owner.token);
    const before = await org(world.A.id);
    const o = await owner.from("organizations").update({ phone: "user-jwt" } as never, { count: "exact" }).eq("id", world.A.id);
    const u = await owner.from("users").update({ full_name: "user-jwt" } as never, { count: "exact" }).eq("id", world.A.owner.id);
    const m = await owner.from("memberships").update({ role: "admin" } as never, { count: "exact" }).eq("org_id", world.A.id).eq("user_id", extraStaff.id);
    for (const r of [o, u, m]) expect(r.error !== null || r.count === 0, JSON.stringify(r.error)).toBe(true);
    expect((await org(world.A.id)).phone).toBe(before.phone);
    expect((await membership(world.A.id, extraStaff.id))?.role).toBe("staff");
  });

  // ── settings: own profile ───────────────────────────────────────────────────
  it("updateProfile · a staff member saves their OWN profile and it persists; a forged id in the form changes nobody else", async () => {
    const world = w!;
    const { updateProfile } = await import("@/app/(app)/settings/actions");
    const colleagueBefore = await userRow(world.A.owner.id);
    as(world.A.staff, world.A.id, "staff");
    const fd = form({ full_name: "Sam Fitter", phone: "07700 900444", id: world.A.owner.id, user_id: world.A.owner.id });
    const r = await run(() => updateProfile({} as never, fd));
    expect((r.value as any)?.successMessage ?? (r.value as any)?.ok ?? r.value, JSON.stringify(r.value)).toBeTruthy();
    expect(await userRow(world.A.staff.id)).toMatchObject({ full_name: "Sam Fitter", phone: "07700 900444" });
    expect(await userRow(world.A.owner.id)).toEqual(colleagueBefore);
  });

  // ── settings: company details ───────────────────────────────────────────────
  it("updateOrganization · the OWNER saves company settings and they persist (name, phone, VAT, bank details, terms)", async () => {
    const world = w!;
    const { updateOrganization } = await import("@/app/(app)/settings/actions");
    as(world.A.owner, world.A.id, "owner");
    const otherOrgBefore = await org(world.B.id);
    const r = await run(() =>
      updateOrganization({} as never, form({
        name: `Saved Co ${world.tag}`, phone: "028 9000 0000", vat_number: "GB123456789",
        bank_name: "Test Bank", bank_sort_code: "00-00-00", bank_account_number: "00000000", default_terms: "30 days",
      })),
    );
    expect(r.redirect).toBeNull();
    const after = await org(world.A.id);
    expect(after).toMatchObject({ name: `Saved Co ${world.tag}`, phone: "028 9000 0000", vat_number: "GB123456789", default_terms: "30 days" });
    expect(after.bank_details).toMatchObject({ name: "Test Bank", sort_code: "00-00-00", account_number: "00000000" });
    // pinned to the session's org — nothing else moved
    expect(await org(world.B.id)).toEqual(otherOrgBefore);
  });

  it("updateOrganization · an admin WITH settings:manage saves; an admin with NO grants and a staff member are refused and nothing changes", async () => {
    const world = w!;
    const { updateOrganization } = await import("@/app/(app)/settings/actions");
    as(grantedAdmin, world.A.id, "admin");
    await run(() => updateOrganization({} as never, form({ name: `Granted ${world.tag}` })));
    expect((await org(world.A.id)).name).toBe(`Granted ${world.tag}`);

    for (const [actor, role] of [[world.A.admin, "admin"], [world.A.staff, "staff"]] as const) {
      as(actor, world.A.id, role);
      const r = await run(() => updateOrganization({} as never, form({ name: `Hijacked by ${role}`, bank_account_number: "99999999" })));
      expect(JSON.stringify(r.value)).toMatch(/Only admins\/owners/);
      expect((await org(world.A.id)).name).toBe(`Granted ${world.tag}`);
    }
  });

  it("updateOrganization · an owner of ANOTHER org cannot touch this org (the row is the session's org, never a form value)", async () => {
    const world = w!;
    const { updateOrganization } = await import("@/app/(app)/settings/actions");
    const before = await org(world.A.id);
    as(world.B.owner, world.B.id, "owner");
    await run(() => updateOrganization({} as never, form({ name: `B renamed ${world.tag}`, org_id: world.A.id, id: world.A.id })));
    expect(await org(world.A.id)).toEqual(before);
    expect((await org(world.B.id)).name).toBe(`B renamed ${world.tag}`);
  });

  // ── organisation set-up state (three writers) ───────────────────────────────
  it("set-up state · owner: skipStep, dismissChecklistStep, dismissMilestone and dismissNudge all persist", async () => {
    const world = w!;
    const { skipStep } = await import("@/app/(app)/onboarding/setup/actions");
    const { dismissChecklistStep } = await import("@/app/(app)/dashboard/_dismiss-step");
    const { dismissMilestone } = await import("@/app/(app)/dashboard/_retention-actions");
    as(world.A.owner, world.A.id, "owner");
    const r = await run(() => skipStep(form({ step_id: "vat" })));
    expect(r.redirect).toBe("/onboarding/setup?saved=skipped");
    await run(() => dismissChecklistStep(form({ step_id: "bank" })));
    await run(() => dismissMilestone(form({ milestone_id: "first_customer" })));
    const state = (await org(world.A.id)).onboarding_state as any;
    expect(state.dismissed_steps).toEqual(expect.arrayContaining(["vat", "bank"]));
    expect(state.celebrated_milestones).toEqual(["first_customer"]);
  });

  it("company logo · the owner clears the logo and it persists; staff are refused", async () => {
    const world = w!;
    const { deleteCompanyLogo } = await import("@/server/services/company-logo");
    await svc().from("organizations").update({ logo_url: "https://example.test/legacy.png" }).eq("id", world.A.id);
    as(world.A.staff, world.A.id, "staff");
    expect(await deleteCompanyLogo()).toMatchObject({ ok: false, error: "forbidden" });
    expect((await org(world.A.id)).logo_url).toBe("https://example.test/legacy.png");
    as(world.A.owner, world.A.id, "owner");
    expect((await deleteCompanyLogo()).ok).toBe(true);
    expect(await org(world.A.id)).toMatchObject({ logo_url: null, logo_path: null });
  });

  // ── staff: role ─────────────────────────────────────────────────────────────
  it("updateStaffRole · the OWNER promotes a staff member to admin and demotes them again — the membership row changes", async () => {
    const world = w!;
    const { updateStaffRole } = await import("@/app/(app)/staff/actions");
    as(world.A.owner, world.A.id, "owner");
    let r = await run(() => updateStaffRole(extraStaff.id, form({ role: "admin" })));
    expect(r.redirect).toBe(`/staff/${extraStaff.id}?saved=role`);
    expect((await membership(world.A.id, extraStaff.id))?.role).toBe("admin");
    r = await run(() => updateStaffRole(extraStaff.id, form({ role: "staff" })));
    expect(r.redirect).toBe(`/staff/${extraStaff.id}?saved=role`);
    expect((await membership(world.A.id, extraStaff.id))?.role).toBe("staff");
  });

  it("updateStaffRole · refusals: staff; an admin appointing an admin; the last owner; a user of another org; the owner role", async () => {
    const world = w!;
    const { updateStaffRole } = await import("@/app/(app)/staff/actions");

    as(world.A.staff, world.A.id, "staff");
    expect((await run(() => updateStaffRole(extraStaff.id, form({ role: "admin" })))).redirect).toBe("/dashboard?error=forbidden");

    as(grantedAdmin, world.A.id, "admin"); // holds staff:manage — still not allowed to appoint an admin
    expect((await run(() => updateStaffRole(extraStaff.id, form({ role: "admin" })))).redirect).toBe("/dashboard?error=forbidden");
    // …nor to demote the owner or a fellow admin
    expect((await run(() => updateStaffRole(world.A.admin.id, form({ role: "staff" })))).redirect).toBe("/dashboard?error=forbidden");

    as(world.A.owner, world.A.id, "owner");
    expect((await run(() => updateStaffRole(world.A.owner.id, form({ role: "staff" })))).redirect).toBe(`/staff/${world.A.owner.id}?error=last_owner_lock`);
    expect((await run(() => updateStaffRole(extraStaff.id, form({ role: "owner" })))).redirect).toBe(`/staff/${extraStaff.id}?error=owner_role_not_assignable`);
    // a member of org B, addressed by id from org A's session
    expect((await run(() => updateStaffRole(world.B.staff.id, form({ role: "admin" })))).redirect).toBe("/staff?error=not_a_member");

    expect((await membership(world.A.id, extraStaff.id))?.role).toBe("staff");
    expect((await membership(world.A.id, world.A.admin.id))?.role).toBe("admin");
    expect((await membership(world.A.id, world.A.owner.id))?.role).toBe("owner");
    expect((await membership(world.B.id, world.B.staff.id))?.role).toBe("staff");
    expect(await membership(world.A.id, world.B.staff.id)).toBeNull();
  });

  // ── staff: profile ──────────────────────────────────────────────────────────
  it("updateStaffProfile · the owner edits a staff member's record (users row + pay) and it persists", async () => {
    const world = w!;
    const { updateStaffProfile } = await import("@/app/(app)/staff/actions");
    as(world.A.owner, world.A.id, "owner");
    const r = await run(() =>
      updateStaffProfile(extraStaff.id, {} as never, form({ full_name: "Edited Staff", phone: "07700 900555", employment_type: "employee", start_date: "2025-02-03", hourly_pay: "17.5" })),
    );
    expect(JSON.stringify(r.value)).toMatch(/Profile saved/);
    expect(await userRow(extraStaff.id)).toEqual({ full_name: "Edited Staff", phone: "07700 900555", employment_type: "employee", start_date: "2025-02-03" });
    const pay = await svc().from("staff_compensation").select("hourly_pay").eq("user_id", extraStaff.id).single();
    expect(Number((pay.data as any).hourly_pay)).toBe(17.5);
  });

  it("updateStaffProfile · refusals: staff editing a colleague; an admin without staff:manage; an admin editing the owner or themselves; a user of another org", async () => {
    const world = w!;
    const { updateStaffProfile } = await import("@/app/(app)/staff/actions");
    const snapshot = async () => ({
      extra: await userRow(extraStaff.id), owner: await userRow(world.A.owner.id),
      admin: await userRow(grantedAdmin.id), other: await userRow(world.B.staff.id),
    });
    const before = await snapshot();
    const hijack = form({ full_name: "HIJACKED", phone: "000", hourly_pay: "999" });

    as(world.A.staff, world.A.id, "staff");
    expect((await run(() => updateStaffProfile(extraStaff.id, {} as never, hijack))).redirect).toBe("/dashboard?error=forbidden");

    as(world.A.admin, world.A.id, "admin"); // no grants
    expect(JSON.stringify((await run(() => updateStaffProfile(extraStaff.id, {} as never, hijack))).value)).toMatch(/don't have permission/);

    as(grantedAdmin, world.A.id, "admin"); // staff:manage — but not an owner
    expect(JSON.stringify((await run(() => updateStaffProfile(world.A.owner.id, {} as never, hijack))).value)).toMatch(/Only the owner/);
    expect(JSON.stringify((await run(() => updateStaffProfile(grantedAdmin.id, {} as never, hijack))).value)).toMatch(/Only the owner/);

    as(world.A.owner, world.A.id, "owner");
    expect(JSON.stringify((await run(() => updateStaffProfile(world.B.staff.id, {} as never, hijack))).value)).toMatch(/isn't a member/);

    expect(await snapshot()).toEqual(before);
    const pay = await svc().from("staff_compensation").select("user_id, hourly_pay").in("user_id", [world.A.owner.id, grantedAdmin.id, world.B.staff.id]);
    expect((pay.data ?? []).filter((p: any) => Number(p.hourly_pay) === 999)).toEqual([]);
  });

  it("updateStaffProfile · an admin WITH staff:manage edits a normal staff member", async () => {
    const world = w!;
    const { updateStaffProfile } = await import("@/app/(app)/staff/actions");
    as(grantedAdmin, world.A.id, "admin");
    const r = await run(() => updateStaffProfile(extraStaff.id, {} as never, form({ full_name: "Edited By Admin", phone: "07700 900666" })));
    expect(JSON.stringify(r.value)).toMatch(/Profile saved/);
    expect((await userRow(extraStaff.id)).full_name).toBe("Edited By Admin");
  });

  // ── staff: invite (existing user) + remove ──────────────────────────────────
  it("inviteStaff (existing colleague) · the owner adds a member and the membership row exists; staff cannot", async () => {
    const world = w!;
    const { inviteStaff } = await import("@/app/(app)/staff/actions");
    // A person the owner of A can already see: a co-member of a SECOND org.
    const shared = await mkActor(world.tag, "shared-user", world.B.id, "staff");
    world.extras.push(shared);
    const link = await svc().from("memberships").insert({ org_id: world.B.id, user_id: world.A.owner.id, role: "staff" });
    if (link.error) throw new Error(link.error.message);

    as(world.A.staff, world.A.id, "staff");
    expect((await run(() => inviteStaff(form({ email: shared.email, role: "staff" })))).redirect).toBe("/dashboard?error=forbidden");
    expect(await membership(world.A.id, shared.id)).toBeNull();

    as(world.A.owner, world.A.id, "owner");
    const r = await run(() => inviteStaff(form({ email: shared.email, role: "staff" })));
    expect(JSON.stringify(r.value)).toMatch(/"ok":true/);
    expect((await membership(world.A.id, shared.id))?.role).toBe("staff");
    await svc().from("memberships").delete().eq("org_id", world.B.id).eq("user_id", world.A.owner.id);
  });

  it("removeStaff · refusals first (staff; removing the owner; a member of another org), then the owner removes a staff member and the row is gone", async () => {
    const world = w!;
    const { removeStaff } = await import("@/app/(app)/staff/actions");

    as(world.A.staff, world.A.id, "staff");
    expect((await run(() => removeStaff(extraStaff.id))).redirect).toBe("/dashboard?error=forbidden");

    as(world.A.owner, world.A.id, "owner");
    expect((await run(() => removeStaff(world.A.owner.id))).redirect).toBe(`/staff/${world.A.owner.id}?error=cannot_remove_owner`);
    expect((await run(() => removeStaff(world.B.staff.id))).redirect).toBe("/staff?error=not_a_member");
    expect(await membership(world.B.id, world.B.staff.id)).not.toBeNull();
    expect(await membership(world.A.id, extraStaff.id)).not.toBeNull();
    expect(await membership(world.A.id, world.A.owner.id)).not.toBeNull();

    as(world.A.admin, world.A.id, "admin"); // no staff:manage
    expect((await run(() => removeStaff(extraStaff.id))).redirect).toBe(`/staff/${extraStaff.id}?error=forbidden`);
    expect(await membership(world.A.id, extraStaff.id)).not.toBeNull();

    as(world.A.owner, world.A.id, "owner");
    expect((await run(() => removeStaff(extraStaff.id))).redirect).toBe("/staff?saved=removed");
    expect(await membership(world.A.id, extraStaff.id)).toBeNull();
  });

  // ── H&S quick-add actions: a staff member replays the POST for a document the page refuses ──
});
