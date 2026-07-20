import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * RLS proof — snags are tenant-private (Site Management, 20260919000000).
 *
 * The snags table is a new tenant surface: every policy is scoped to
 * `org_id in (select current_org_ids())`. This converts that intent into a
 * runtime enforcement check against real Postgres with the actual migrations
 * applied:
 *
 *   1. a service_role client (BYPASSRLS) can read a snag it created — the
 *      table + migration are live, and "zero rows elsewhere" is a real denial,
 *      not a vacuously empty table;
 *   2. an anonymous client cannot see the snag (RLS enabled — unauthenticated
 *      is denied);
 *   3. an AUTHENTICATED client that is NOT a member of the org still cannot see
 *      it — proving the gate is org MEMBERSHIP via current_org_ids(), not mere
 *      authentication. This is the property a cross-tenant leak would violate.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB,
 * fails loudly in CI if the DB is missing. The integration config runs files
 * serially, so the auth user minted here can't race other suites; it (and the
 * org, which cascades to its snags) is deleted on teardown.
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

const TOKEN = `it-snags-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("snags · tenant isolation (RLS)", () => {
  let orgId = "";
  let snagId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Snag RLS Probe Org", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");
    if (!orgId) throw new Error("failed to create probe organisation");

    const snag = await svc
      .from("snags")
      .insert({ org_id: orgId, title: "RLS probe snag" })
      .select("id")
      .single();
    expect(snag.error, snag.error?.message).toBeNull();
    snagId = String(snag.data?.id ?? "");
    if (!snagId) throw new Error("failed to create probe snag");

    // Mint an authenticated user that is NOT a member of the probe org.
    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    authUserId = created.data.user?.id ?? "";

    const signedIn = await anonClient().auth.signInWithPassword({
      email,
      password,
    });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    authToken = signedIn.data.session?.access_token ?? "";
    if (!authToken) throw new Error("failed to mint an authenticated token");
  });

  afterAll(async () => {
    // Deleting the org cascades to its snags (org_id ... on delete cascade).
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("service_role can read the snag it created (RLS bypassed)", async () => {
    const { data, error } = await db(serviceClient())
      .from("snags")
      .select("id, title")
      .eq("id", snagId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(1);
    expect((data?.[0]?.title as string) ?? "").toBe("RLS probe snag");
  });

  it("anon cannot see the snag (RLS enforced)", async () => {
    const { data, error } = await db(anonClient())
      .from("snags")
      .select("id")
      .eq("id", snagId);
    // RLS filters rows rather than erroring → expect an empty result set.
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated non-member cannot see the snag (membership-gated)", async () => {
    const { data, error } = await db(userClient(authToken))
      .from("snags")
      .select("id")
      .eq("id", snagId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  // The migration widens the tenant_attachments target_table CHECK to admit
  // 'snags' (so snag photos ride the universal pipeline). Prove the widening
  // took — and that the constraint still constrains — rather than assume it.
  it("tenant_attachments accepts target_table='snags' (CHECK widened)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "snags",
        target_id: snagId,
        filename: "defect.jpg",
        storage_path: `${orgId}/snags/${snagId}/probe.jpg`,
      });
    // Cascades away with the org on teardown (org_id ... on delete cascade).
    expect(error, error?.message).toBeNull();
  });

  it("tenant_attachments still rejects an unknown target_table (CHECK enforced)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "not_a_real_table",
        target_id: snagId,
        filename: "x.jpg",
        storage_path: `${orgId}/x/probe.jpg`,
      });
    // A single, correctly-widened CHECK must still reject a bogus value; a null
    // error here would mean the constraint was dropped, not widened.
    expect(error).not.toBeNull();
  });
});
