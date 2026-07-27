import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * QR scan resolver — real-Postgres proof of the token→asset path (M3b).
 *
 * Replicates resolveScannedAsset (app/(app)/assets/_scan.ts): find the ACTIVE
 * identity by token scoped to the caller's org, then load that asset scoped to
 * the same org. Proves the scan route resolves an asset ONLY for a valid, active,
 * same-org token — and denies revoked / unknown / cross-tenant identically
 * (null). (The tenant scope the route gets from RLS is modelled here with an
 * explicit org filter, since service_role bypasses RLS.)
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
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

const TOKEN = `it-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;
const tok = () => `${TOKEN}-${seq++}`;

// Replicates the resolver's two-step, org-scoped lookup.
async function resolve(token: string, orgId: string): Promise<string | null> {
  const svc = db(serviceClient());
  const { data: id } = await svc
    .from("asset_qr_identities")
    .select("asset_id")
    .eq("token", token)
    .eq("active", true)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!id?.asset_id) return null;
  const { data: asset } = await svc
    .from("assets")
    .select("id")
    .eq("id", id.asset_id as string)
    .eq("org_id", orgId)
    .maybeSingle();
  return (asset?.id as string) ?? null;
}

describeIntegration("qr scan resolver · token→asset security", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let tokenActive = "";
  let tokenRevoked = "";
  let tokenB = "";

  async function mkOrg(slug: string) {
    const { data, error } = await db(serviceClient())
      .from("organizations").insert({ name: `SCAN ${slug}`, slug }).select("id").single();
    expect(error, error?.message).toBeNull();
    return String(data?.id ?? "");
  }
  async function mkAsset(org: string) {
    const { data, error } = await db(serviceClient())
      .from("assets").insert({ org_id: org, name: "scan asset" }).select("id").single();
    expect(error, error?.message).toBeNull();
    return String(data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await mkOrg(`${TOKEN}-a`);
    orgB = await mkOrg(`${TOKEN}-b`);
    assetA = await mkAsset(orgA);
    const assetA2 = await mkAsset(orgA);
    const assetB = await mkAsset(orgB);

    tokenActive = tok();
    tokenRevoked = tok();
    tokenB = tok();
    const rows = [
      { org_id: orgA, asset_id: assetA, token: tokenActive, active: true },
      { org_id: orgA, asset_id: assetA2, token: tokenRevoked, active: false, revoked_at: new Date("2026-07-01").toISOString() },
      { org_id: orgB, asset_id: assetB, token: tokenB, active: true },
    ];
    for (const r of rows) {
      const { error } = await db(serviceClient()).from("asset_qr_identities").insert(r);
      expect(error, error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("resolves an active same-org token to the correct asset", async () => {
    expect(await resolve(tokenActive, orgA)).toBe(assetA);
  });

  it("denies a revoked token (null)", async () => {
    expect(await resolve(tokenRevoked, orgA)).toBeNull();
  });

  it("denies a cross-tenant token (null) — but the owning org resolves it", async () => {
    expect(await resolve(tokenB, orgA)).toBeNull();
    expect(await resolve(tokenB, orgB)).not.toBeNull();
  });

  it("denies an unknown token (null)", async () => {
    expect(await resolve("it-scan-nonexistent-token", orgA)).toBeNull();
  });
});
