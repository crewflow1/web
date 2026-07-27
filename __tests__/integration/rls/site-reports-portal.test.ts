import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { isPortalVisible } from "@/lib/site-reports/portal";

/**
 * Site Reports — customer-portal access proof (increment 3, real Postgres).
 *
 * The portal has no customer JWT — the URL token resolves to a customer on the
 * service-role admin client, and every report read is filtered IN CODE by that
 * customer_id + org_id + the visibility rule. This test replicates that exact
 * query (service_role == the admin client the portal uses) + the isPortalVisible
 * predicate, and proves the access model against a live database:
 *
 *   - customer isolation: customer A1 never sees A2's reports, and guessing A2's
 *     report id returns nothing;
 *   - tenant isolation: org B's report is never reachable through org A's filter;
 *   - status enforcement: draft / approved / issued-but-unpublished / withdrawn
 *     reports are invisible; issued-published + superseded-published are visible;
 *   - snapshot: the visible report exposes its FROZEN snapshot.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
  in(k: string, v: unknown[]): Q;
  not(k: string, op: string, v: unknown): Q;
  is(k: string, v: unknown): Q;
  order(k: string, o: { ascending: boolean }): Q;
  maybeSingle(): PromiseLike<Res<Row>>;
  single(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(k: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Q;
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (c: unknown) => c as unknown as { from(t: string): Table };

const TOKEN = `it-srp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Replicates listPortalReports/loadPortalReport (the portal read helper).
async function portalLoad(customerId: string, orgId: string, reportId: string) {
  const { data } = await db(serviceClient())
    .from("site_reports")
    .select("id, status, snapshot, portal_published_at, portal_withdrawn_at")
    .eq("id", reportId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return null;
  if (
    !isPortalVisible({
      status: data.status as string,
      portal_published_at: (data.portal_published_at as string) ?? null,
      portal_withdrawn_at: (data.portal_withdrawn_at as string) ?? null,
    })
  ) {
    return null;
  }
  return data;
}

async function portalList(customerId: string, orgId: string) {
  const { data } = await db(serviceClient())
    .from("site_reports")
    .select("id, status, portal_published_at, portal_withdrawn_at")
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .in("status", ["issued", "superseded"])
    .not("portal_published_at", "is", null)
    .is("portal_withdrawn_at", null)
    .order("portal_published_at", { ascending: false });
  return (data ?? []).filter((r) =>
    isPortalVisible({
      status: r.status as string,
      portal_published_at: (r.portal_published_at as string) ?? null,
      portal_withdrawn_at: null,
    }),
  );
}

describeIntegration("site_reports · customer-portal access", () => {
  let orgA = "";
  let orgB = "";
  let custA1 = "";
  let custA2 = "";
  const ids: Record<string, string> = {};

  async function makeReport(
    org: string,
    customer: string,
    status: string,
    opts: { published?: boolean; withdrawn?: boolean; snapshot?: Row } = {},
  ) {
    const now = "2026-07-08T09:00:00.000Z";
    const r = await db(serviceClient())
      .from("site_reports")
      .insert({
        org_id: org,
        customer_id: customer,
        title: `${status} report`,
        period_start: "2026-07-01",
        period_end: "2026-07-07",
        status,
        portal_published_at: opts.published ? now : null,
        portal_withdrawn_at: opts.withdrawn ? now : null,
        snapshot: opts.snapshot ?? null,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = async (slug: string) => {
      const { data, error } = await svc
        .from("organizations")
        .insert({ name: `SRP ${slug}`, slug })
        .select("id")
        .single();
      expect(error, error?.message).toBeNull();
      return String(data?.id ?? "");
    };
    orgA = await org(`${TOKEN}-a`);
    orgB = await org(`${TOKEN}-b`);

    const cust = async (org: string, name: string) => {
      const { data, error } = await svc
        .from("customers")
        .insert({ org_id: org, name })
        .select("id")
        .single();
      expect(error, error?.message).toBeNull();
      return String(data?.id ?? "");
    };
    custA1 = await cust(orgA, "Customer A1");
    custA2 = await cust(orgA, "Customer A2");
    const custB = await cust(orgB, "Customer B");

    ids.draft = await makeReport(orgA, custA1, "draft");
    ids.approved = await makeReport(orgA, custA1, "approved");
    ids.issuedUnpub = await makeReport(orgA, custA1, "issued", { snapshot: { frozen: true } });
    ids.published = await makeReport(orgA, custA1, "issued", { published: true, snapshot: { frozen: true, k: "v" } });
    ids.superseded = await makeReport(orgA, custA1, "superseded", { published: true, snapshot: { frozen: true } });
    ids.withdrawn = await makeReport(orgA, custA1, "issued", { published: true, withdrawn: true, snapshot: { frozen: true } });
    ids.otherCust = await makeReport(orgA, custA2, "issued", { published: true, snapshot: { frozen: true } });
    ids.otherOrg = await makeReport(orgB, custB, "issued", { published: true, snapshot: { frozen: true } });
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("lists only A1's published, non-withdrawn issued/superseded reports", async () => {
    const list = await portalList(custA1, orgA);
    const listedIds = list.map((r) => r.id as string).sort();
    expect(listedIds).toEqual([ids.published, ids.superseded].sort());
  });

  it("status enforcement: draft/approved/unpublished/withdrawn are invisible", async () => {
    for (const key of ["draft", "approved", "issuedUnpub", "withdrawn"]) {
      expect(await portalLoad(custA1, orgA, ids[key]!), key).toBeNull();
    }
  });

  it("exposes the frozen snapshot of a published report", async () => {
    const r = await portalLoad(custA1, orgA, ids.published!);
    expect(r).not.toBeNull();
    expect((r?.snapshot as { k?: string })?.k).toBe("v");
  });

  it("customer isolation: A1 cannot load A2's report by id", async () => {
    expect(await portalLoad(custA1, orgA, ids.otherCust!)).toBeNull();
    // ...but A2 legitimately can.
    expect(await portalLoad(custA2, orgA, ids.otherCust!)).not.toBeNull();
  });

  it("tenant isolation: org A's customer cannot reach org B's report", async () => {
    expect(await portalLoad(custA1, orgA, ids.otherOrg!)).toBeNull();
    expect(await portalLoad(custA1, orgB, ids.otherOrg!)).toBeNull();
  });
});
