import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Customer-data isolation — real Postgres, real JWTs (migration 20261276000000).
 *
 * A direct staff-JWT probe showed `customers` had an org-member-wide SELECT
 * policy, so a restricted `staff` member could read the WHOLE org's CRM (names,
 * emails, phones, addresses) via the API — even though /customers is not in the
 * staff nav. The migration scopes staff SELECT to the customers on their
 * ASSIGNED jobs (the one legitimate need — the job Overview shows the customer),
 * keeps owner/admin on full access, and moves writes to admin-only.
 */

type Res = { data: unknown[] | null; error: { code?: string; message: string } | null };
type Row = Record<string, unknown>;
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Row): { select(c?: string): { single(): PromiseLike<{ data: Row | null; error: { code?: string; message: string } | null }> } } & PromiseLike<{ error: { code?: string; message: string } | null }>;
      select(c?: string): { eq(k: string, v: unknown): PromiseLike<Res> };
      delete(): { eq(k: string, v: unknown): PromiseLike<Res> };
    };
  };

const TOKEN = `it-cust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PW = `Pw-${TOKEN}`;

async function mkUser(email: string, role: string, orgId: string): Promise<{ id: string; token: string }> {
  const created = await serviceClient().auth.admin.createUser({ email, password: PW, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role });
  const token = (await anonClient().auth.signInWithPassword({ email, password: PW })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${email}`);
  return { id, token };
}

describeIntegration("customers · assigned-job-scoped isolation", () => {
  const svc = db(serviceClient());
  let orgA = "", orgB = "";
  let assignedCustomer = "", unrelatedCustomer = "", job = "";
  let owner = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  const insId = async (table: string, row: Row): Promise<string> =>
    String((await svc.from(table).insert(row).select("id").single()).data?.id ?? "");

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "Cust A", slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: "Cust B", slug: `${TOKEN}-b` });
    owner = await mkUser(`${TOKEN}-owner@example.test`, "owner", orgA);
    staff = await mkUser(`${TOKEN}-staff@example.test`, "staff", orgA);
    outsider = await mkUser(`${TOKEN}-out@example.test`, "owner", orgB);

    assignedCustomer = await insId("customers", { org_id: orgA, name: "Assigned Customer" });
    unrelatedCustomer = await insId("customers", { org_id: orgA, name: "Unrelated Customer" });
    job = await insId("jobs", { org_id: orgA, status: "in-progress", customer_id: assignedCustomer });
    if (!assignedCustomer || !unrelatedCustomer || !job) throw new Error("fixture failed");
    await svc.from("job_assignments").insert({ org_id: orgA, job_id: job, user_id: staff.id });
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
    for (const u of [owner.id, staff.id, outsider.id]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const ids = async (token: string): Promise<string[]> => {
    const r = await db(userClient(token)).from("customers").select("id").eq("org_id", orgA);
    return (r.data ?? []).map((x) => String((x as Row).id));
  };

  it("OWNER sees every customer in the org", async () => {
    const seen = await ids(owner.token);
    expect(seen).toContain(assignedCustomer);
    expect(seen).toContain(unrelatedCustomer);
  });

  it("STAFF sees ONLY their assigned job's customer", async () => {
    const seen = await ids(staff.token);
    expect(seen, "assigned-job customer is visible (legit need preserved)").toContain(assignedCustomer);
    expect(seen, "unrelated customer must be hidden").not.toContain(unrelatedCustomer);
  });

  it("cross-org OUTSIDER sees no org-A customers", async () => {
    expect(await ids(outsider.token)).toHaveLength(0);
  });

  it("STAFF cannot INSERT a customer (admin-only write)", async () => {
    const r = await db(userClient(staff.token)).from("customers").insert({ org_id: orgA, name: "Sneaky" });
    expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  });

  it("OWNER can INSERT a customer (legit flow preserved)", async () => {
    const r = await db(userClient(owner.token)).from("customers").insert({ org_id: orgA, name: "Owner Cust" }).select("id").single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  });

  it("a STAFF member unassigned from the job loses customer visibility", async () => {
    await svc.from("job_assignments").delete().eq("user_id", staff.id);
    // (job.assigned_to is null for this fixture, so unassigning removes the only
    // path; no need to delete the job — its activity trigger is left untouched.)
    const seen = await ids(staff.token);
    expect(seen).not.toContain(assignedCustomer);
  });
});
