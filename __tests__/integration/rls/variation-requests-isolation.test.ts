import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * VARIATION REQUESTS against real Postgres (G2, migration 20261221000000).
 *
 * Two boundaries are proved here, because the table has two:
 *
 * TENANT (RLS): variation_requests is a new tenant surface — SELECT/INSERT
 * member-scoped via current_org_ids(), UPDATE admin-only via is_org_admin(),
 * and the authenticated INSERT path is STAFF-AS-SELF only (requester_type
 * 'staff' + requested_by = auth.uid()), so a signed-in user can neither read
 * nor file into an org they don't belong to, can't forge a portal
 * ('customer'/'worker_token') request, and can't pin a colleague as requester.
 *
 * STATE MACHINE (trigger, ALL roles including service_role):
 * tg_variation_requests_guard enforces requested → reviewing → accepted /
 * rejected, accepted → converted, converted-needs-quote-id, born-'requested'.
 * The TS mirror of this matrix is pinned pair-by-pair in
 * __tests__/variation-requests/schema.test.ts; this file proves the DB side.
 *
 * MUTATION PROOF (described, not automated): drop the trigger
 * (`drop trigger variation_requests_guard on public.variation_requests`) and
 * the transition/born-requested cases flip green; drop the UPDATE policy and
 * the staff-review case flips green. Each arm is load-bearing.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): {
    single(): PromiseLike<Res<Row>>;
    maybeSingle(): PromiseLike<Res<Row>>;
  };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-vreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("variation requests · tenant isolation + state machine", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let customerA = "";
  let adminId = "";
  let adminToken = "";
  let staffId = "";
  let staffToken = "";

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
      .insert({ id, email, full_name: `VReq ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  /** Seed a request in org A via service_role (portal-style intake path). */
  async function seedRequest(overrides: Row = {}): Promise<string> {
    const r = await svc()
      .from("variation_requests")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} probe request`,
        requester_type: "customer",
        requester_name: "Portal Probe",
        ...overrides,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function statusOf(id: string): Promise<string> {
    const r = await svc()
      .from("variation_requests")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.status ?? "");
  }

  beforeAll(async () => {
    for (const [name, setter] of [
      ["A", (id: string) => (orgA = id)],
      ["B", (id: string) => (orgB = id)],
    ] as const) {
      const org = await svc()
        .from("organizations")
        .insert({ name: `VReq Probe ${name}`, slug: `${TOKEN}-${name.toLowerCase()}` })
        .select("id")
        .single();
      expect(org.error, org.error?.message).toBeNull();
      setter(String(org.data?.id ?? ""));
    }

    const jA = await svc()
      .from("jobs")
      .insert({ org_id: orgA, status: "new" })
      .select("id")
      .single();
    expect(jA.error, jA.error?.message).toBeNull();
    jobA = String(jA.data?.id ?? "");
    const jB = await svc()
      .from("jobs")
      .insert({ org_id: orgB, status: "new" })
      .select("id")
      .single();
    expect(jB.error, jB.error?.message).toBeNull();
    jobB = String(jB.data?.id ?? "");

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: "VReq Customer" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    customerA = String(cust.data?.id ?? "");

    const admin = await makeUser("admin");
    adminId = admin.id;
    adminToken = admin.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    // Both are members of org A ONLY — org B has no members, so any visibility
    // of org B rows is a leak, not a fixture accident.
    const am = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: adminId, role: "admin" })
      .select("user_id")
      .single();
    expect(am.error, am.error?.message).toBeNull();
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    // Org delete cascades to jobs → variation_requests (composite FK) and to
    // customers/quotes/memberships.
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
    for (const id of [adminId, staffId]) {
      if (id) {
        await svc().from("users").delete().eq("id", id);
        await serviceClient().auth.admin.deleteUser(id);
      }
    }
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  it("anon sees nothing; a member sees the org's request; org B rows are invisible", async () => {
    const reqA = await seedRequest();
    const reqB = await svc()
      .from("variation_requests")
      .insert({
        org_id: orgB,
        job_id: jobB,
        title: `${TOKEN} other-tenant request`,
        requester_type: "customer",
      })
      .select("id")
      .single();
    expect(reqB.error, reqB.error?.message).toBeNull();
    const reqBId = String(reqB.data?.id ?? "");

    const anon = await db(anonClient())
      .from("variation_requests")
      .select("id")
      .eq("id", reqA);
    expect(anon.error, anon.error?.message).toBeNull();
    expect(anon.data ?? []).toHaveLength(0);

    const own = await db(userClient(staffToken))
      .from("variation_requests")
      .select("id")
      .eq("id", reqA);
    expect(own.error, own.error?.message).toBeNull();
    expect(own.data ?? []).toHaveLength(1);

    const cross = await db(userClient(staffToken))
      .from("variation_requests")
      .select("id")
      .eq("id", reqBId);
    expect(cross.error, cross.error?.message).toBeNull();
    expect(cross.data ?? []).toHaveLength(0);
  });

  it("a member can file a request in their own org, as themselves", async () => {
    const r = await db(userClient(staffToken))
      .from("variation_requests")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} staff intake`,
        requester_type: "staff",
        requested_by: staffId,
      })
      .select("id, status")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    expect(String(r.data?.status ?? "")).toBe("requested");
  });

  it("cross-org INSERT is refused (member of A cannot file into B)", async () => {
    const r = await db(userClient(staffToken))
      .from("variation_requests")
      .insert({
        org_id: orgB,
        job_id: jobB,
        title: `${TOKEN} cross-org intake`,
        requester_type: "staff",
        requested_by: staffId,
      })
      .select("id")
      .maybeSingle();
    expect(r.error).not.toBeNull();
  });

  it("an authenticated user cannot forge a portal request or another requester", async () => {
    // requester_type != 'staff' → refused by the INSERT policy.
    const forgedType = await db(userClient(staffToken))
      .from("variation_requests")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} forged customer request`,
        requester_type: "customer",
        requester_name: "Not A Customer",
      })
      .select("id")
      .maybeSingle();
    expect(forgedType.error).not.toBeNull();

    // requested_by != auth.uid() → refused by the INSERT policy.
    const forgedWho = await db(userClient(staffToken))
      .from("variation_requests")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} forged requester`,
        requester_type: "staff",
        requested_by: adminId,
      })
      .select("id")
      .maybeSingle();
    expect(forgedWho.error).not.toBeNull();
  });

  // ── Review authority ───────────────────────────────────────────────────────

  it("staff cannot move status (admin-only UPDATE policy); admin can", async () => {
    const reqId = await seedRequest();

    // Staff: RLS filters the row out of the UPDATE — zero rows touched.
    const staffTry = await db(userClient(staffToken))
      .from("variation_requests")
      .update({ status: "reviewing" })
      .eq("id", reqId)
      .select("id");
    expect(staffTry.error, staffTry.error?.message).toBeNull();
    expect(staffTry.data ?? []).toHaveLength(0);
    expect(await statusOf(reqId)).toBe("requested");

    // Admin: the same transition succeeds.
    const adminTry = await db(userClient(adminToken))
      .from("variation_requests")
      .update({ status: "reviewing", review_note: "Looking at it" })
      .eq("id", reqId)
      .select("id");
    expect(adminTry.error, adminTry.error?.message).toBeNull();
    expect(adminTry.data ?? []).toHaveLength(1);
    expect(await statusOf(reqId)).toBe("reviewing");
  });

  // ── State machine (trigger — binds service_role too) ──────────────────────

  it("rows are born 'requested' — inserting straight into a decided state is refused", async () => {
    const r = await svc()
      .from("variation_requests")
      .insert({
        org_id: orgA,
        job_id: jobA,
        title: `${TOKEN} born accepted`,
        requester_type: "customer",
        status: "accepted",
      })
      .select("id")
      .maybeSingle();
    expect(r.error).not.toBeNull();
    expect(r.error?.message ?? "").toContain("requested");
  });

  it("illegal transitions are rejected by the trigger (backwards + skip)", async () => {
    const reqId = await seedRequest();
    // requested → converted (skips accept) — refused.
    const skip = await svc()
      .from("variation_requests")
      .update({ status: "converted" })
      .eq("id", reqId)
      .select("id");
    expect(skip.error).not.toBeNull();

    // Walk it forward legally, then try to go back.
    for (const next of ["reviewing", "accepted"]) {
      const step = await svc()
        .from("variation_requests")
        .update({ status: next })
        .eq("id", reqId)
        .select("id");
      expect(step.error, `${next}: ${step.error?.message}`).toBeNull();
    }
    const back = await svc()
      .from("variation_requests")
      .update({ status: "requested" })
      .eq("id", reqId)
      .select("id");
    expect(back.error).not.toBeNull();
    expect(back.error?.message ?? "").toContain("illegal status transition");
    expect(await statusOf(reqId)).toBe("accepted");

    // rejected is terminal.
    const reqId2 = await seedRequest();
    const reject = await svc()
      .from("variation_requests")
      .update({ status: "rejected", review_note: "no" })
      .eq("id", reqId2)
      .select("id");
    expect(reject.error, reject.error?.message).toBeNull();
    const resurrect = await svc()
      .from("variation_requests")
      .update({ status: "reviewing" })
      .eq("id", reqId2)
      .select("id");
    expect(resurrect.error).not.toBeNull();
  });

  it("'converted' requires a variation_quote_id, and the quote must be same-org", async () => {
    const reqId = await seedRequest();
    for (const next of ["reviewing", "accepted"]) {
      const step = await svc()
        .from("variation_requests")
        .update({ status: next })
        .eq("id", reqId)
        .select("id");
      expect(step.error, step.error?.message).toBeNull();
    }

    // No quote id → trigger refuses.
    const bare = await svc()
      .from("variation_requests")
      .update({ status: "converted" })
      .eq("id", reqId)
      .select("id");
    expect(bare.error).not.toBeNull();
    expect(bare.error?.message ?? "").toContain("variation_quote_id");

    // With a same-org quote → converts.
    const quote = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        number: `${TOKEN}-Q1`,
        status: "draft",
      })
      .select("id")
      .single();
    expect(quote.error, quote.error?.message).toBeNull();
    const quoteId = String(quote.data?.id ?? "");

    const done = await svc()
      .from("variation_requests")
      .update({ status: "converted", variation_quote_id: quoteId })
      .eq("id", reqId)
      .select("id");
    expect(done.error, done.error?.message).toBeNull();
    expect(await statusOf(reqId)).toBe("converted");

    // A quote from ANOTHER org can never be stamped — composite FK
    // (variation_quote_id, org_id) → quotes (id, org_id).
    const reqId2 = await seedRequest();
    for (const next of ["reviewing", "accepted"]) {
      await svc()
        .from("variation_requests")
        .update({ status: next })
        .eq("id", reqId2)
        .select("id");
    }
    const custB = await svc()
      .from("customers")
      .insert({ org_id: orgB, name: "VReq Customer B" })
      .select("id")
      .single();
    expect(custB.error, custB.error?.message).toBeNull();
    const quoteB = await svc()
      .from("quotes")
      .insert({
        org_id: orgB,
        customer_id: String(custB.data?.id ?? ""),
        number: `${TOKEN}-QB1`,
        status: "draft",
      })
      .select("id")
      .single();
    expect(quoteB.error, quoteB.error?.message).toBeNull();

    const crossOrg = await svc()
      .from("variation_requests")
      .update({
        status: "converted",
        variation_quote_id: String(quoteB.data?.id ?? ""),
      })
      .eq("id", reqId2)
      .select("id");
    expect(crossOrg.error).not.toBeNull();
  });

  // ── Attachments pipeline ───────────────────────────────────────────────────

  it("tenant_attachments accepts target_table='variation_requests' (CHECK widened) and still rejects unknowns", async () => {
    const reqId = await seedRequest();
    const ok = await svc().from("tenant_attachments").insert({
      org_id: orgA,
      target_table: "variation_requests",
      target_id: reqId,
      filename: "site-photo.jpg",
      storage_path: `${orgA}/variation_requests/${reqId}/probe.jpg`,
    });
    expect(ok.error, ok.error?.message).toBeNull();

    const bogus = await svc().from("tenant_attachments").insert({
      org_id: orgA,
      target_table: "not_a_real_table",
      target_id: reqId,
      filename: "x.jpg",
      storage_path: `${orgA}/x/probe.jpg`,
    });
    expect(bogus.error).not.toBeNull();
  });
});
