import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { resolveScannedAssetForOrg } from "@/lib/assets/scan";

/**
 * QR scan resolver — real-Postgres proof of the token→asset path (M3b).
 *
 * Drives the REAL resolver (`resolveScannedAssetForOrg`, lib/assets/scan.ts) on
 * the SERVICE-ROLE client. Because service_role bypasses RLS entirely, this
 * suite isolates the APPLICATION-LAYER predicate: it proves the resolver's own
 * org filter denies revoked / unknown / cross-tenant tokens even with the
 * database's outer boundary switched off. The RLS half — and the dual-org
 * active-org case, which RLS deliberately permits — is proven with real user
 * JWTs in `asset-qr-active-org.test.ts`.
 *
 * HISTORY — why this file is written this way. It previously REPLICATED the
 * resolver inline, adding an `.eq("org_id", …)` that the shipped code did not
 * have. It therefore proved a resolver shape that did not exist and stayed
 * green while `_scan.ts` resolved tokens by RLS alone (which blends orgs for a
 * dual-org user). Driving the real export is what stops that drift recurring —
 * do not reintroduce a local copy of the query.
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

/** The real resolver, driven on the RLS-bypassing service-role client. */
async function resolve(token: string, orgId: string): Promise<string | null> {
  const scanned = await resolveScannedAssetForOrg(serviceClient(), token, orgId);
  return scanned?.id ?? null;
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
