import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Tenant teardown — `delete from organizations` must actually succeed (20261052).
 *
 * REGRESSION: before 20261052_activity_cascade_guard, deleting an org that held
 * a row in any table with BOTH an AFTER-DELETE activity trigger AND
 * `on delete cascade` to organizations failed outright:
 *
 *   ERROR: insert or update on table "activity_log" violates foreign key
 *          constraint "activity_log_org_id_fkey"
 *
 * The cascade removes the org row first, then each cascaded child DELETE fires
 * its `_tg_*_activity` trigger → `_record_activity()` → INSERT into
 * activity_log, whose own org_id FK points at the org the cascade just removed.
 * Guaranteed failure, not a race. Since every real org records expenses
 * (finances), this blocked tenant teardown and GDPR erasure for every tenant.
 *
 * This suite covers ALL SIX tables that reach that path — customers, finances,
 * invoice_payments, jobs, leads, rota_entries — because the fix is one guard in
 * the shared `_record_activity` chokepoint, so a per-table regression would go
 * unnoticed if only finances were exercised.
 *
 * Service-role throughout: teardown is a service-role/admin operation, and a
 * cascade that fails for the RLS-bypassing client fails for every caller.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res> {
  eq(c: string, v: unknown): Sel;
  select(c: string): Sel;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Sel;
      insert(r: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }> & {
        select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> };
      };
      delete(): { eq(c: string, v: unknown): PromiseLike<Res> };
    };
  };

const T = `it-teardown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Every table that cascades from organizations AND logs activity on DELETE. */
const CASCADE_TABLES = [
  "customers",
  "finances",
  "invoice_payments",
  "jobs",
  "leads",
  "rota_entries",
] as const;

describeIntegration("tenant teardown · org delete cascade (20261052)", () => {
  const svc = () => db(serviceClient());
  let orgA = ""; // fully populated — the org under test
  let orgB = ""; // survivor — proves the cascade is scoped to orgA
  let member = { id: "", token: "" };
  let bystanderFinance = "";

  const mkOrg = async (label: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name: `Teardown ${label}`, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    return String(r.data?.id);
  };

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");

    // rota_entries requires a real user; create one and put them in org A.
    const email = `${T}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    const id = created.data.user?.id ?? "";
    // Assert here: without it a failed createUser surfaces far downstream as an
    // opaque `invalid input syntax for type uuid: ""` on the rota_entries insert.
    expect(id, `admin.createUser failed: ${JSON.stringify(created.error)}`).not.toBe("");
    await svc().from("users").insert({ id, email, full_name: "Teardown Probe" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: id, role: "admin" });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    member = { id, token: s.data.session?.access_token ?? "" };

    // One row in each of the six cascade+activity tables, all in org A.
    const cust = await svc().from("customers").insert({ org_id: orgA, name: "Teardown Customer" }).select("id").single();
    const job = await svc().from("jobs").insert({ org_id: orgA, status: "new", customer_id: cust.data?.id }).select("id").single();
    const inv = await svc().from("invoices").insert({ org_id: orgA, number: `${T}-INV`, amount: 1000, vat_total: 200, status: "sent" }).select("id").single();

    const seeded = await Promise.all([
      svc().from("finances").insert({ org_id: orgA, amount: 100, vat_rate: 20, category: "Materials" }),
      svc().from("leads").insert({ org_id: orgA, source: "web" }),
      svc().from("invoice_payments").insert({ org_id: orgA, invoice_id: inv.data?.id, amount: 500, paid_at: "2026-07-20" }),
      svc().from("rota_entries").insert({
        org_id: orgA,
        user_id: member.id,
        starts_at: new Date("2026-07-20T09:00:00Z").toISOString(),
        ends_at: new Date("2026-07-20T17:00:00Z").toISOString(),
      }),
    ]);
    for (const r of [cust, job, inv, ...seeded]) {
      expect(r.error, JSON.stringify(r.error)).toBeNull();
    }

    // A bystander cost in org B, to prove teardown of A leaves B untouched.
    const bf = await svc().from("finances").insert({ org_id: orgB, amount: 42, vat_rate: 0, category: "Fuel" }).select("id").single();
    expect(bf.error, JSON.stringify(bf.error)).toBeNull();
    bystanderFinance = String(bf.data?.id);
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      if (id) await svc().from("organizations").delete().eq("id", id);
    }
    if (member.id) await serviceClient().auth.admin.deleteUser(member.id);
  });

  it("seeded org A with activity rows across every cascade-logged table", async () => {
    // Guards the guard: if the INSERTs stopped writing activity_log, the delete
    // below would pass vacuously and this suite would prove nothing.
    const log = await svc().from("activity_log").select("action").eq("org_id", orgA);
    expect(log.error, JSON.stringify(log.error)).toBeNull();
    expect((log.data ?? []).length).toBeGreaterThanOrEqual(CASCADE_TABLES.length);
  });

  it("DELETES an org holding finances + activity-logged rows (the P1 regression)", async () => {
    const del = await svc().from("organizations").delete().eq("id", orgA);

    // Before 20261052 this failed with activity_log_org_id_fkey.
    expect(del.error && del.error.message, JSON.stringify(del.error)).toBeNull();

    const gone = await svc().from("organizations").select("id").eq("id", orgA);
    expect(gone.data ?? []).toHaveLength(0);
  });

  it("leaves NO residue in any cascade table, activity_log included", async () => {
    for (const table of [...CASCADE_TABLES, "activity_log"]) {
      const r = await svc().from(table).select("id").eq("org_id", orgA);
      expect(r.error, `${table}: ${JSON.stringify(r.error)}`).toBeNull();
      expect(r.data ?? [], `${table} still holds rows for the deleted org`).toHaveLength(0);
    }
  });

  it("leaves the other org untouched (cascade is tenant-scoped)", async () => {
    const survivor = await svc().from("finances").select("id").eq("id", bystanderFinance);
    expect(survivor.data ?? []).toHaveLength(1);
  });

  it("still logs finance.deleted for an ordinary delete (guard is not a blanket mute)", async () => {
    // The guard must fire ONLY when the org is gone. With org B alive, deleting
    // one cost must still record its activity row exactly as before.
    const f = await svc().from("finances").insert({ org_id: orgB, amount: 7, vat_rate: 0, category: "Sundries" }).select("id").single();
    expect(f.error, JSON.stringify(f.error)).toBeNull();
    const id = String(f.data?.id);

    const del = await svc().from("finances").delete().eq("id", id);
    expect(del.error, JSON.stringify(del.error)).toBeNull();

    const log = await svc().from("activity_log").select("action, target_id").eq("target_id", id);
    expect(log.error, JSON.stringify(log.error)).toBeNull();
    const actions = (log.data ?? []).map((r) => r.action);
    expect(actions).toContain("finance.deleted");
    expect(actions).toContain("finance.created");
  });
});
