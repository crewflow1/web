/* eslint-disable @typescript-eslint/no-explicit-any -- raw rows + a structural OrgContext; see _fixture.ts */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, userClient } from "../_harness";
import { as, createWorld, destroyWorld, mkActor, svc, type Actor, type World } from "./_fixture";

/**
 * D-17 — JOB CREATION IS RESTRICTED: owners / admins, or a member explicitly granted
 * `jobs:create`. Plain staff are refused at every layer.
 *
 * Proved with REAL GoTrue sessions against the local stack, at the two layers a job can
 * be written from a user session:
 *
 *   1. the Data API (PostgREST with the member's own JWT) — the `public.jobs` INSERT policy;
 *   2. the `createJob` server action — `@/lib/supabase/server` hands it the member's REAL
 *      user-JWT client (RLS + grants apply exactly as in production); only the Next.js
 *      cookie → session lookup, `redirect` and `revalidatePath` are replaced.
 *
 * Plus the paths that must KEEP working: owner / admin creation, an admin holding the
 * grant through the server action, and the accepted-quote → job step (SECURITY INVOKER
 * `ensure_accepted_quote_artifacts`, called with the owner's JWT and by the service role
 * on the public-link path).
 *
 * Ground truth is always read back with the service role, never the caller's return value.
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
  return { ...actual, requireOrgContext, requireUser: async () => (await requireOrgContext()).user };
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

describeIntegration("D-17 · job creation requires jobs:create (owner / admin / explicitly granted) — real sessions", () => {
  let w: World | null = null;
  let grantedAdmin: Actor; // an admin of A holding jobs:create
  let grantedStaff: Actor; // a staff member of A with a STRAY jobs:create row (must be ignored)
  let customerA = "";

  const actAs = (actor: Actor, orgId: string, role: string) => {
    session.token = actor.token;
    session.current = {
      user: { id: actor.id, email: actor.email },
      ctx: {
        membership: { org_id: orgId, role },
        org: { id: orgId, name: "x", slug: "x", status: "active", plan: "x", trial_ends_at: null, created_at: "", onboarding_state: {}, require_mfa: false, i18n: {} },
      },
    };
  };
  const jobsWithNote = async (note: string) =>
    (await svc().from("jobs").select("id, org_id").eq("notes", note)).data ?? [];
  const membershipId = async (orgId: string, userId: string) =>
    ((await svc().from("memberships").select("id").eq("org_id", orgId).eq("user_id", userId).single()).data as { id: string }).id;

  beforeAll(async () => {
    w = await createWorld("jobcap");
    grantedAdmin = await mkActor(w.tag, "granted-admin", w.A.id, "admin");
    grantedStaff = await mkActor(w.tag, "granted-staff", w.A.id, "staff");
    w.extras.push(grantedAdmin, grantedStaff);
    const g = await svc().from("membership_permissions").insert([
      { org_id: w.A.id, membership_id: await membershipId(w.A.id, grantedAdmin.id), module: "jobs", action: "create" },
      { org_id: w.A.id, membership_id: await membershipId(w.A.id, grantedStaff.id), module: "jobs", action: "create" },
    ]);
    if (g.error) throw new Error(`grant seed: ${g.error.message}`);
    const c = await svc().from("customers").insert({ org_id: w.A.id, name: `jobcap customer ${w.tag}` }).select("id").single();
    if (c.error) throw new Error(`customer seed: ${c.error.message}`);
    customerA = (c.data as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 180_000);

  beforeEach(() => {
    session.current = null;
    session.token = "";
  });

  // ── 1. Data API ─────────────────────────────────────────────────────────────
  it("Data API · plain staff (and staff holding a stray jobs:create row) cannot INSERT a job into their own company", async () => {
    const world = w!;
    for (const actor of [world.A.staff, grantedStaff]) {
      const note = `jobcap staff api ${actor.id} ${world.tag}`;
      const r = await as(actor.token).from("jobs").insert({ org_id: world.A.id, status: "new", notes: note });
      expect(r.error, `staff ${actor.email} job insert must be refused`).not.toBeNull();
      expect(await jobsWithNote(note)).toHaveLength(0);
    }
  });

  it("Data API · the owner and an admin of the company CAN insert a job (legitimate path kept)", async () => {
    const world = w!;
    for (const actor of [world.A.owner, world.A.admin, grantedAdmin]) {
      const note = `jobcap mgmt api ${actor.id} ${world.tag}`;
      const r = await as(actor.token).from("jobs").insert({ org_id: world.A.id, status: "new", notes: note });
      expect(r.error, `${actor.email}: ${r.error?.message}`).toBeNull();
      expect(await jobsWithNote(note)).toHaveLength(1);
    }
  });

  it("Data API · an owner / admin of company B still cannot insert a job into company A", async () => {
    const world = w!;
    for (const actor of [world.B.owner, world.B.admin, world.B.staff]) {
      const note = `jobcap cross ${actor.id} ${world.tag}`;
      const r = await as(actor.token).from("jobs").insert({ org_id: world.A.id, status: "new", notes: note });
      expect(r.error, `${actor.email} cross-tenant insert must be refused`).not.toBeNull();
      expect(await jobsWithNote(note)).toHaveLength(0);
    }
  });

  // ── 2. createJob server action ──────────────────────────────────────────────
  it("createJob · plain staff get a clear refusal and NO job is written", async () => {
    const world = w!;
    const { createJob } = await import("@/app/(app)/jobs/actions");
    for (const actor of [world.A.staff, grantedStaff]) {
      const note = `jobcap staff action ${actor.id} ${world.tag}`;
      actAs(actor, world.A.id, "staff");
      // No customer: staff cannot read customers, so a customer id would be refused by the
      // reference check first — the bare job is the path that reached the INSERT.
      const r = await run(() => createJob({} as never, form({ status: "new", notes: note })));
      expect(r.redirect).toBeNull();
      expect((r.value as any)?.ok, JSON.stringify(r.value)).toBe(false);
      expect(await jobsWithNote(note)).toHaveLength(0);
      expect(String((r.value as any)?.error ?? "")).toMatch(/only owners or admins can create jobs/i);
    }
  });

  it("createJob · an admin WITHOUT the jobs:create grant is refused (default-deny admin model)", async () => {
    const world = w!;
    const { createJob } = await import("@/app/(app)/jobs/actions");
    const note = `jobcap plain admin action ${world.tag}`;
    actAs(world.A.admin, world.A.id, "admin");
    const r = await run(() => createJob({} as never, form({ status: "new", notes: note })));
    expect((r.value as any)?.ok, JSON.stringify(r.value)).toBe(false);
    expect(await jobsWithNote(note)).toHaveLength(0);
  });

  it("createJob · the owner and an admin holding jobs:create create the job (legitimate path kept)", async () => {
    const world = w!;
    const { createJob } = await import("@/app/(app)/jobs/actions");
    for (const [actor, role] of [[world.A.owner, "owner"], [grantedAdmin, "admin"]] as const) {
      const note = `jobcap mgmt action ${actor.id} ${world.tag}`;
      actAs(actor, world.A.id, role);
      const r = await run(() => createJob({} as never, form({ status: "new", notes: note, customer_id: customerA })));
      expect((r.value as any)?.ok, JSON.stringify(r.value)).toBe(true);
      const rows = await jobsWithNote(note);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.org_id).toBe(world.A.id);
    }
  });

  // ── 3. accepted quote → job (must keep working) ─────────────────────────────
  it("accepted quote → job · the owner's JWT and the service role (public link) still create the job; staff cannot use the RPC to create one", async () => {
    const world = w!;
    const mkAcceptedQuote = async (n: string) => {
      const q = await svc()
        .from("quotes")
        .insert({ org_id: world.A.id, customer_id: customerA, number: `JC-${n}-${world.tag}`.slice(0, 60), status: "accepted", subtotal: 100, vat_total: 20 })
        .select("id")
        .single();
      if (q.error) throw new Error(`quote seed: ${q.error.message}`);
      return (q.data as { id: string }).id;
    };
    const jobOf = async (quoteId: string) =>
      ((await svc().from("quotes").select("job_id").eq("id", quoteId).single()).data as { job_id: string | null }).job_id;

    // staff: refused (the function is SECURITY INVOKER, so the jobs INSERT policy applies)
    const qStaff = await mkAcceptedQuote("s");
    const rs = await as(world.A.staff.token).rpc("ensure_accepted_quote_artifacts", { p_org_id: world.A.id, p_quote_id: qStaff });
    expect(rs.error, "staff must not create a job through the accept RPC").not.toBeNull();
    expect(await jobOf(qStaff)).toBeNull();

    // owner (in-app accept on the customer's behalf)
    const qOwner = await mkAcceptedQuote("o");
    const ro = await as(world.A.owner.token).rpc("ensure_accepted_quote_artifacts", { p_org_id: world.A.id, p_quote_id: qOwner });
    expect(ro.error, ro.error?.message).toBeNull();
    expect((ro.data as any)?.created_job).toBe(true);
    expect(await jobOf(qOwner)).not.toBeNull();

    // service role (public token accept path)
    const qPublic = await mkAcceptedQuote("p");
    const rp = await svc().rpc("ensure_accepted_quote_artifacts", { p_org_id: world.A.id, p_quote_id: qPublic });
    expect(rp.error, rp.error?.message).toBeNull();
    expect((rp.data as any)?.created_job).toBe(true);
    expect(await jobOf(qPublic)).not.toBeNull();
  });
});
