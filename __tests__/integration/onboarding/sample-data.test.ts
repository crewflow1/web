import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { seedSampleData } from "@/server/services/sample-data";

/**
 * First-impression sample data — real Postgres. Proves the seeder creates a coherent, self-labelled
 * demo set for a fresh org, is idempotent + safe (never touches an org that already has data), and
 * that a failure would be reported, not thrown.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => PromiseLike<{ error: { message: string } | null }> & {
      select: (c: string) => { single: () => PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> };
  };
};
const db = (): Db => serviceClient() as unknown as Db;
const TOKEN = `it-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const orgs: string[] = [];

async function freshOrg(label: string): Promise<string> {
  const res = await db().from("organizations").insert({ name: `Seed ${label}`, slug: `${TOKEN}-${label}` }).select("id").single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  orgs.push(id);
  return id;
}
async function rows(table: string, orgId: string): Promise<unknown[]> {
  const res = await db().from(table).select("id").eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

describeIntegration("onboarding · sample data seeder", () => {
  afterAll(async () => {
    for (const id of orgs) await db().from("organizations").delete().eq("id", id);
  });

  it("seeds a coherent demo set (customer + draft quote + line items + job) for a fresh org", async () => {
    const orgId = await freshOrg("fresh");
    const result = await seedSampleData(orgId);
    expect(result.seeded, JSON.stringify(result)).toBe(true);
    if (!result.seeded) throw new Error("unreachable");

    expect(await rows("customers", orgId)).toHaveLength(1);
    const quotes = await rows("quotes", orgId);
    expect(quotes).toHaveLength(1);
    expect(await rows("quote_line_items", orgId)).toHaveLength(3);
    expect(await rows("jobs", orgId)).toHaveLength(1);

    // The quote is a draft with a non-colliding SAMPLE number and a real total.
    const q = await serviceClient().from("quotes").select("status, number, total, customer_id").eq("org_id", orgId);
    const quote = ((q as { data: Array<Record<string, unknown>> | null }).data ?? [])[0];
    expect(quote?.status).toBe("draft");
    expect(String(quote?.number)).toMatch(/^SAMPLE-/);
    expect(Number(quote?.total)).toBe(14400);
    expect(quote?.customer_id).toBe(result.customerId);
  });

  it("is IDEMPOTENT — a second call is a no-op, never duplicates", async () => {
    const orgId = await freshOrg("idem");
    const first = await seedSampleData(orgId);
    expect(first.seeded).toBe(true);
    const second = await seedSampleData(orgId);
    expect(second.seeded).toBe(false);
    if (!second.seeded) expect(second.reason).toBe("org_not_empty");
    // Still exactly one customer (no duplication).
    expect(await rows("customers", orgId)).toHaveLength(1);
  });

  it("is SAFE — never seeds an org that already holds real customer data", async () => {
    const orgId = await freshOrg("real");
    // Pre-existing real customer.
    const c = await db().from("customers").insert({ org_id: orgId, name: "Real Customer Ltd" });
    expect(c.error, c.error?.message).toBeNull();

    const result = await seedSampleData(orgId);
    expect(result.seeded).toBe(false);
    if (!result.seeded) expect(result.reason).toBe("org_not_empty");
    // Untouched: still just the one real customer, no sample quote/job.
    expect(await rows("customers", orgId)).toHaveLength(1);
    expect(await rows("quotes", orgId)).toHaveLength(0);
  });
});
