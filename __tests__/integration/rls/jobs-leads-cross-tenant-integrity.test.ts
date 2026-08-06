import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, anonClient } from "../_harness";

/**
 * Tenant integrity — a job/lead may reference only a customer in the SAME org,
 * and may be assigned only to a MEMBER of that org. Proved against real Postgres.
 *
 * The defect (hostile-audit 🔴): jobs/leads.customer_id were BARE FKs to the
 * global customers(id), and assigned_to bare FKs to the global users(id). The
 * only write guard was `.eq("org_id", ctx.org.id)` on the ROW — which constrains
 * the org_id the caller supplies, never the customer/user the row POINTS AT. So a
 * caller in org A could attach org B's customer, or a non-member, to an org A
 * job/lead. RLS cannot express this. Migration 20261112000000 closes it at the
 * database: a COMPOSITE FK (customer_id, org_id) → customers(id, org_id) and a
 * BEFORE INSERT OR UPDATE membership trigger on assigned_to.
 *
 * The whole suite runs on the SERVICE-ROLE client, deliberately (the
 * invoice-payments-org-integrity idiom). That client BYPASSES RLS — it is the
 * most privileged writer the application has (portal + every admin path use it).
 * If the constraint + trigger hold against it, no application writer can bypass
 * the invariant, because none has more authority. A test that proved it only for
 * a tenant JWT would prove the easy half.
 *
 * Fixtures are created and torn down per-run; org deletion cascades to
 * customers/jobs/leads, and auth-user deletion cascades to public.users +
 * memberships.
 */

type InsertResult = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => { single: () => Promise<InsertResult> };
    } & Promise<{ error: { message: string; code?: string } | null }>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<InsertResult>;
        eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string; code?: string } | null }>;
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-jlxt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkOrg(label: string): Promise<string> {
  const res = await db(serviceClient())
    .from("organizations")
    .insert({ name: `JLXT Org ${label}`, slug: `${TOKEN}-${label.toLowerCase()}` })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  const id = res.data?.id as string;
  if (!id) throw new Error(`failed to create org ${label}`);
  return id;
}

/** Create an auth user, mirror to public.users, and make them a member of `orgIds`. */
async function mkMember(suffix: string, orgIds: string[]): Promise<string> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password: `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  if (!id) throw new Error(`failed to create user ${suffix}`);
  const u = await db(serviceClient()).from("users").insert({ id, email, full_name: `${TOKEN} ${suffix}` });
  expect(u.error, u.error?.message).toBeNull();
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "staff" });
    expect(m.error, m.error?.message).toBeNull();
  }
  return id;
}

describeIntegration("jobs + leads · cross-tenant reference integrity (composite FK + membership trigger)", () => {
  let orgA = "";
  let orgB = "";
  let customerA = "";
  let customerB = "";
  let memberA = ""; // member of org A only
  let memberB = ""; // member of org B only

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgA = await mkOrg("A");
    orgB = await mkOrg("B");

    for (const [org, ref] of [
      [orgA, "A"],
      [orgB, "B"],
    ] as const) {
      const c = await svc
        .from("customers")
        .insert({ org_id: org, name: `${TOKEN} Customer ${ref}` })
        .select("id")
        .single();
      expect(c.error, c.error?.message).toBeNull();
      if (ref === "A") customerA = c.data?.id as string;
      else customerB = c.data?.id as string;
    }

    memberA = await mkMember("member-a", [orgA]);
    memberB = await mkMember("member-b", [orgB]);
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    // Org delete cascades to customers/jobs/leads; auth-user delete cascades to
    // public.users + memberships. Both ASSERTED — a swallowed teardown error is
    // exactly what leaks fixtures into the shared database.
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc.from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
    for (const id of [memberA, memberB]) {
      if (!id) continue;
      const del = await serviceClient().auth.admin.deleteUser(id);
      expect(del.error, `user teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
  });

  // ── customer_id — composite FK ─────────────────────────────────────────────

  it("REJECTS an org-A job pointing at org B's customer (composite FK, service role)", async () => {
    const res = await db(serviceClient())
      .from("jobs")
      .insert({ org_id: orgA, customer_id: customerB, status: "new" });
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("jobs_customer_org_fkey");
  });

  it("REJECTS an org-A lead pointing at org B's customer (composite FK, service role)", async () => {
    const res = await db(serviceClient())
      .from("leads")
      .insert({ org_id: orgA, customer_id: customerB, source: "phone", status: "new" });
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("leads_customer_org_fkey");
  });

  // ── assigned_to — membership trigger ───────────────────────────────────────

  it("REJECTS an org-A job assigned to a non-member (membership trigger, service role)", async () => {
    const res = await db(serviceClient())
      .from("jobs")
      .insert({ org_id: orgA, assigned_to: memberB, status: "new" });
    expect(res.error).not.toBeNull();
    expect(res.error?.message ?? "").toContain("not a member of org");
  });

  it("REJECTS an org-A lead assigned to a non-member (membership trigger, service role)", async () => {
    const res = await db(serviceClient())
      .from("leads")
      .insert({ org_id: orgA, assigned_to: memberB, source: "phone", status: "new" });
    expect(res.error).not.toBeNull();
    expect(res.error?.message ?? "").toContain("not a member of org");
  });

  it("REJECTS reassigning an org-A job to a non-member via UPDATE (the drag-drop / updateJob path)", async () => {
    const svc = db(serviceClient());
    const created = await svc
      .from("jobs")
      .insert({ org_id: orgA, assigned_to: memberA, status: "new" })
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const jobId = created.data?.id as string;

    const upd = await svc.from("jobs").update({ assigned_to: memberB }).eq("id", jobId);
    expect(upd.error).not.toBeNull();
    expect(upd.error?.message ?? "").toContain("not a member of org");
  });

  // ── positive paths — ordinary writes are unchanged ─────────────────────────

  it("ACCEPTS a same-org customer + member assignee on a job", async () => {
    const res = await db(serviceClient())
      .from("jobs")
      .insert({ org_id: orgA, customer_id: customerA, assigned_to: memberA, status: "new" })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  it("ACCEPTS a same-org customer + member assignee on a lead", async () => {
    const res = await db(serviceClient())
      .from("leads")
      .insert({ org_id: orgA, customer_id: customerA, assigned_to: memberA, source: "web", status: "new" })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  it("ACCEPTS a job with NO customer and NO assignee (both nullable; composite FK is MATCH SIMPLE)", async () => {
    const res = await db(serviceClient())
      .from("jobs")
      .insert({ org_id: orgA, status: "new" })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  it("ACCEPTS an unrelated UPDATE on a job whose assignee is valid (trigger only re-checks on change)", async () => {
    const svc = db(serviceClient());
    const created = await svc
      .from("jobs")
      .insert({ org_id: orgA, assigned_to: memberA, status: "new" })
      .select("id")
      .single();
    expect(created.error, created.error?.message).toBeNull();
    const jobId = created.data?.id as string;
    // Touch a column other than assigned_to — must not re-validate the assignee.
    const upd = await svc.from("jobs").update({ status: "in-progress" }).eq("id", jobId);
    expect(upd.error, upd.error?.message).toBeNull();
  });

  // ── ON DELETE semantics preserved (SET NULL on customer_id, org_id survives) ─

  it("deleting a customer NULLs the job's customer_id but keeps the row + org_id", async () => {
    const svc = db(serviceClient());
    // A throwaway customer in org B + a job that references it.
    const c = await svc
      .from("customers")
      .insert({ org_id: orgB, name: `${TOKEN} Throwaway` })
      .select("id")
      .single();
    expect(c.error, c.error?.message).toBeNull();
    const throwawayCustomer = c.data?.id as string;

    const j = await svc
      .from("jobs")
      .insert({ org_id: orgB, customer_id: throwawayCustomer, status: "new" })
      .select("id")
      .single();
    expect(j.error, j.error?.message).toBeNull();
    const jobId = j.data?.id as string;

    const del = await svc.from("customers").delete().eq("id", throwawayCustomer);
    expect(del.error, del.error?.message).toBeNull();

    // The job survives (SET NULL, not CASCADE) with customer_id nulled and its
    // NOT NULL org_id intact — proving the column-list SET NULL form.
    const after = await svc.from("jobs").select("customer_id, org_id").eq("id", jobId).maybeSingle();
    expect(after.error, after.error?.message).toBeNull();
    expect(after.data).not.toBeNull();
    expect(after.data?.customer_id).toBeNull();
    expect(after.data?.org_id).toBe(orgB);
  });

  it("the anon (RLS) client is still denied a cross-org read — the outer boundary is intact", async () => {
    // A sanity pin that this migration changed integrity, not visibility.
    const res = await db(anonClient()).from("jobs").select("id").eq("org_id", orgA).eq("org_id", orgA);
    // anon sees nothing (no rows) or an RLS error — never org A's jobs.
    expect(res.data ?? []).toHaveLength(0);
  });
});
