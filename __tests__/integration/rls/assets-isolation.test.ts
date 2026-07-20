import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * RLS proof — assets are tenant-private (Asset Management, 20260924000000).
 *
 * Mirrors the Site Management proofs: against real Postgres, prove service_role
 * reads its own row, anon is denied, an authenticated non-member is denied
 * (membership-gated via current_org_ids()), and the shared tenant_attachments
 * CHECK now accepts 'assets' while still accepting a prior target ('site_reports')
 * and rejecting an unknown one.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("assets · tenant isolation (RLS)", () => {
  let orgId = "";
  let assetId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Asset RLS Probe Org", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");
    if (!orgId) throw new Error("failed to create probe organisation");

    const asset = await svc
      .from("assets")
      .insert({ org_id: orgId, name: "RLS probe digger" })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    assetId = String(asset.data?.id ?? "");
    if (!assetId) throw new Error("failed to create probe asset");

    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    authUserId = created.data.user?.id ?? "";
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    authToken = signedIn.data.session?.access_token ?? "";
    if (!authToken) throw new Error("failed to mint an authenticated token");
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("service_role can read the asset it created (RLS bypassed)", async () => {
    const { data, error } = await db(serviceClient())
      .from("assets")
      .select("id, name")
      .eq("id", assetId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("anon cannot see the asset (RLS enforced)", async () => {
    const { data, error } = await db(anonClient())
      .from("assets")
      .select("id")
      .eq("id", assetId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated non-member cannot see the asset (membership-gated)", async () => {
    const { data, error } = await db(userClient(authToken))
      .from("assets")
      .select("id")
      .eq("id", assetId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("tenant_attachments accepts 'assets', still accepts 'site_reports', rejects bogus", async () => {
    const svc = db(serviceClient());
    const okAsset = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "assets",
      target_id: assetId,
      filename: "manual.pdf",
      storage_path: `${orgId}/assets/${assetId}/manual.pdf`,
    });
    expect(okAsset.error, okAsset.error?.message).toBeNull();

    const okPrior = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "site_reports",
      target_id: assetId,
      filename: "x.pdf",
      storage_path: `${orgId}/site_reports/x.pdf`,
    });
    expect(okPrior.error, okPrior.error?.message).toBeNull();

    const bogus = await svc.from("tenant_attachments").insert({
      org_id: orgId,
      target_table: "not_a_real_table",
      target_id: assetId,
      filename: "x.pdf",
      storage_path: `${orgId}/x.pdf`,
    });
    expect(bogus.error).not.toBeNull();
  });
});
