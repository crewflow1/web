import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { isResolvable } from "@/lib/assets/qr";

/**
 * Asset QR identities — real-Postgres security proof (20260926000000).
 *
 * Proves the identity invariants against a live database:
 *   - ONE ACTIVE IDENTITY per asset (partial unique index); a second active
 *     insert fails, and concurrent generation yields exactly one active;
 *   - the rotate RPC atomically revokes the old + inserts the new (one active,
 *     lineage recorded); a revoked identity is no longer resolvable;
 *   - a scan resolves ONLY within the token's own org (cross-tenant denied) and
 *     only while active (revoked/unknown denied);
 *   - the same-org guard rejects an identity whose asset is another org's;
 *   - anon cannot read identities.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
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
interface Client {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
}
const db = (c: unknown) => c as unknown as Client;

const TOKEN = `it-qr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;
const tok = () => `${TOKEN}-tok-${seq++}`;

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `QR ${slug}`, slug }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "qr asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function insertActive(org: string, asset: string, token = tok()) {
  return db(serviceClient())
    .from("asset_qr_identities")
    .insert({ org_id: org, asset_id: asset, token, active: true });
}
// Replicates the scan resolver: token + active, scoped to the caller's org.
async function resolve(token: string, orgId: string) {
  const { data } = await db(serviceClient())
    .from("asset_qr_identities")
    .select("id, asset_id, active, org_id")
    .eq("token", token)
    .eq("active", true)
    .eq("org_id", orgId)
    .maybeSingle();
  return data && isResolvable({ active: data.active as boolean }) ? data : null;
}

describeIntegration("asset_qr_identities · identity invariants", () => {
  let orgA = "";
  let orgB = "";

  beforeAll(async () => {
    orgA = await mkOrg(`${TOKEN}-a`);
    orgB = await mkOrg(`${TOKEN}-b`);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("admits one active identity per asset and rejects a second", async () => {
    const asset = await mkAsset(orgA);
    expect((await insertActive(orgA, asset)).error).toBeNull();
    const second = await insertActive(orgA, asset);
    expect(second.error?.code).toBe("23505");
  });

  it("two concurrent generations yield exactly one active", async () => {
    const asset = await mkAsset(orgA);
    const results = await Promise.all([insertActive(orgA, asset), insertActive(orgA, asset)]);
    expect(results.filter((r) => r.error == null)).toHaveLength(1);
    const { data } = await db(serviceClient())
      .from("asset_qr_identities").select("id").eq("asset_id", asset).eq("active", true);
    expect(data ?? []).toHaveLength(1);
  });

  it("rotate atomically revokes the old identity and activates the new", async () => {
    const asset = await mkAsset(orgA);
    const t1 = tok();
    expect((await insertActive(orgA, asset, t1)).error).toBeNull();
    const t2 = tok();
    const r = await db(serviceClient()).rpc("rotate_asset_qr_identity", {
      p_asset_id: asset, p_org_id: orgA, p_token: t2, p_generated_by: null,
    });
    expect(r.error, r.error?.message).toBeNull();
    // Exactly one active, and it's the new token.
    const active = await db(serviceClient())
      .from("asset_qr_identities").select("token").eq("asset_id", asset).eq("active", true);
    expect(active.data ?? []).toHaveLength(1);
    expect((active.data?.[0]?.token as string) ?? "").toBe(t2);
    // Old token no longer resolves; new one does.
    expect(await resolve(t1, orgA)).toBeNull();
    expect(await resolve(t2, orgA)).not.toBeNull();
  });

  it("cross-tenant + unknown tokens do not resolve", async () => {
    const assetB = await mkAsset(orgB);
    const tB = tok();
    expect((await insertActive(orgB, assetB, tB)).error).toBeNull();
    expect(await resolve(tB, orgB), "own org resolves").not.toBeNull();
    expect(await resolve(tB, orgA), "cross-tenant denied").toBeNull();
    expect(await resolve("no-such-token", orgA), "unknown denied").toBeNull();
  });

  it("same-org guard rejects an identity whose asset is another org's", async () => {
    const assetB = await mkAsset(orgB);
    const bad = await db(serviceClient())
      .from("asset_qr_identities")
      .insert({ org_id: orgA, asset_id: assetB, token: tok(), active: true });
    expect(bad.error).not.toBeNull();
  });

  it("anon cannot read identities (RLS)", async () => {
    const asset = await mkAsset(orgA);
    await insertActive(orgA, asset);
    const { data, error } = await db(anonClient())
      .from("asset_qr_identities").select("id").eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
