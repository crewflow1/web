import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * The PGRST201 incident, proven against real PostgREST (not just source pins).
 *
 * `asset_assignments` carries TWO FKs to `assets` (`asset_id` +
 * `vehicle_asset_id`), so a BARE `assets(...)` embed has two candidate
 * relationships and PostgREST rejects the whole query — which
 * /assets/holdings and the job hub assets panel then rendered as their empty
 * states for weeks (`const { data } = …; data ?? []`).
 *
 * Embeds resolve at QUERY time against PostgREST's schema cache, so neither
 * migrations applying nor unit tests can prove them (the
 * invoice-customer-denormalisation suite set this precedent). This suite
 * pins BOTH halves of the incident mechanism live:
 *
 *   1. the exact HINTED embed shape the fixed pages use resolves;
 *   2. the exact BARE embed shape that shipped broken still fails PGRST201 —
 *      if this ever starts passing (e.g. an FK was dropped), the hint
 *      requirement changed and __tests__/security/postgrest-embed-ambiguity
 *      .test.ts's reviewed list must be revisited.
 */

type Row = Record<string, unknown>;
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{ data: Row | null; error: { message: string } | null }>;
      };
    };
    select: (
      c: string,
    ) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }>;
      };
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-aaembed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("asset_assignments · assets embed disambiguation (PGRST201)", () => {
  let org = "";
  let assetId = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const o = await svc
      .from("organizations")
      .insert({ name: `AAEmbed ${TOKEN}`, slug: TOKEN })
      .select("id")
      .single();
    expect(o.error, o.error?.message).toBeNull();
    org = o.data?.id as string;

    const a = await svc
      .from("assets")
      .insert({ org_id: org, name: `${TOKEN}-digger` }) // status defaults 'active'
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    assetId = a.data?.id as string;

    // Open depot custody — satisfies the guard (active asset, no job/assignee).
    const asn = await svc
      .from("asset_assignments")
      .insert({
        org_id: org,
        asset_id: assetId,
        assignment_type: "stored_at_depot",
        location: "Main yard",
      })
      .select("id")
      .single();
    expect(asn.error, asn.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (org) await db(serviceClient()).from("organizations").delete().eq("id", org);
  });

  it("the HINTED embed the fixed pages use resolves to the asset", async () => {
    // The exact shape /assets/holdings ships (assignee join omitted — no member).
    const res = await db(serviceClient())
      .from("asset_assignments")
      .select(
        "id, asset_id, assignment_type, location, assigned_at, expected_return_at, assignee_id, job_id, assets!asset_assignments_asset_id_fkey(id, name)",
      )
      .eq("org_id", org)
      .eq("status", "open");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toHaveLength(1);
    const embedded = (res.data?.[0] as { assets?: { id: string; name: string } | null }).assets;
    expect(embedded?.id).toBe(assetId);
    expect(embedded?.name).toBe(`${TOKEN}-digger`);
  });

  it("the job-hub panel's hinted shape resolves too", async () => {
    const res = await db(serviceClient())
      .from("asset_assignments")
      .select(
        "id, asset_id, assigned_at, expected_return_at, assets!asset_assignments_asset_id_fkey(id, name, status)",
      )
      .eq("org_id", org)
      .eq("status", "open");
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toHaveLength(1);
  });

  it("the BARE embed that shipped broken still fails with PGRST201 (the incident mechanism)", async () => {
    const res = await db(serviceClient())
      .from("asset_assignments")
      .select("id, asset_id, assets(id, name)")
      .eq("org_id", org)
      .eq("status", "open");
    expect(res.data).toBeNull();
    expect(res.error?.code).toBe("PGRST201");
  });
});
