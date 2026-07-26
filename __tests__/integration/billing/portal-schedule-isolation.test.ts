import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * H2-CASH M3 — the customer portal payment schedule reads job_billing_stages,
 * which have NO customer_id, on the RLS-BYPASSING admin (service-role) client.
 * So the ONLY thing stopping customer B from reading customer A's stages is the
 * app-level filter: resolve the customer's OWN jobs first, then read stages
 * `.in("job_id", customerJobIds)`.
 *
 * This proves that filter is load-bearing: without it (a bare org-wide read) the
 * service-role client sees BOTH customers' stages; with it, customer B's job set
 * excludes customer A's job, so A's stages are unreachable.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Sel extends PromiseLike<Res> {
  eq(c: string, v: unknown): Sel;
  in(c: string, v: unknown[]): Sel;
  select(c: string): Sel;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Sel;
      insert(r: Record<string, unknown>): { select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> } };
      delete(): { eq(c: string, v: unknown): PromiseLike<Res> };
    };
  };
const T = `it-portsched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H2-CASH portal schedule isolation (real Postgres)", () => {
  let org = "", custA = "", custB = "", jobA = "", jobB = "", planA = "";
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    org = String((await svc().from("organizations").insert({ name: "PS Org", slug: `${T}-o` }).select("id").single()).data?.id);
    custA = String((await svc().from("customers").insert({ org_id: org, name: "Customer A" }).select("id").single()).data?.id);
    custB = String((await svc().from("customers").insert({ org_id: org, name: "Customer B" }).select("id").single()).data?.id);
    jobA = String((await svc().from("jobs").insert({ org_id: org, status: "new", customer_id: custA }).select("id").single()).data?.id);
    jobB = String((await svc().from("jobs").insert({ org_id: org, status: "new", customer_id: custB }).select("id").single()).data?.id);
    // Customer A's job carries the billing plan + a stage (A's private payment schedule).
    planA = String((await svc().from("job_billing_plans").insert({ org_id: org, job_id: jobA, structure: "staged", basis_amount: 20_000, status: "active" }).select("id").single()).data?.id);
    await svc().from("job_billing_stages").insert({ org_id: org, plan_id: planA, job_id: jobA, sequence: 0, name: "Deposit", kind: "deposit", basis: "fixed", amount: 4000, vat_rate: 20 });
  });
  afterAll(async () => {
    if (org) await svc().from("organizations").delete().eq("id", org);
  });

  it("customer B's job set EXCLUDES customer A's job (the filter's foundation)", async () => {
    const bJobs = (await svc().from("jobs").select("id").eq("org_id", org).eq("customer_id", custB)).data ?? [];
    const bJobIds = bJobs.map((j) => String(j.id));
    expect(bJobIds).toContain(jobB);
    expect(bJobIds).not.toContain(jobA); // A's job is never in B's set
  });

  it("stages filtered by customer B's jobs return NONE of customer A's stages", async () => {
    const bJobIds = ((await svc().from("jobs").select("id").eq("org_id", org).eq("customer_id", custB)).data ?? []).map((j) => String(j.id));
    // The exact read loadPortalSchedule performs for customer B.
    const stages = bJobIds.length
      ? (await svc().from("job_billing_stages").select("id, name").eq("org_id", org).in("job_id", bJobIds)).data ?? []
      : [];
    expect(stages).toHaveLength(0);
  });

  it("customer A's OWN job filter returns A's stage (data exists — proving the filter, not emptiness)", async () => {
    const aJobIds = ((await svc().from("jobs").select("id").eq("org_id", org).eq("customer_id", custA)).data ?? []).map((j) => String(j.id));
    const stages = (await svc().from("job_billing_stages").select("id, name").eq("org_id", org).in("job_id", aJobIds)).data ?? [];
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.some((s) => s.name === "Deposit")).toBe(true);
  });

  it("[load-bearing] a bare org-wide read (no job filter) DOES see A's stage — so the filter is what isolates", async () => {
    const all = (await svc().from("job_billing_stages").select("id, job_id").eq("org_id", org)).data ?? [];
    expect(all.some((s) => String(s.job_id) === jobA)).toBe(true);
  });
});
