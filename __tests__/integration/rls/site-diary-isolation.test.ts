import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * RLS proof — site diary entries are tenant-private (20260920000000).
 *
 * Mirrors the snags isolation proof: against real Postgres with the migrations
 * applied, prove (1) service_role reads an entry it created, (2) anon is denied,
 * (3) an AUTHENTICATED non-member is denied (membership-gated via
 * current_org_ids()), and that the tenant_attachments CHECK now (4) accepts
 * 'site_diary_entries' and (5) still rejects an unknown table.
 *
 * Runs only against a live DB (describeIntegration): skips locally, fails loudly
 * in CI if the DB is missing. The auth user + org are torn down on teardown.
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

const TOKEN = `it-diary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("site_diary_entries · tenant isolation (RLS)", () => {
  let orgId = "";
  let entryId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Diary RLS Probe Org", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");
    if (!orgId) throw new Error("failed to create probe organisation");

    const entry = await svc
      .from("site_diary_entries")
      .insert({ org_id: orgId, entry_date: "2026-07-18", work_summary: "probe" })
      .select("id")
      .single();
    expect(entry.error, entry.error?.message).toBeNull();
    entryId = String(entry.data?.id ?? "");
    if (!entryId) throw new Error("failed to create probe diary entry");

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

  it("service_role can read the entry it created (RLS bypassed)", async () => {
    const { data, error } = await db(serviceClient())
      .from("site_diary_entries")
      .select("id, work_summary")
      .eq("id", entryId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("anon cannot see the entry (RLS enforced)", async () => {
    const { data, error } = await db(anonClient())
      .from("site_diary_entries")
      .select("id")
      .eq("id", entryId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated non-member cannot see the entry (membership-gated)", async () => {
    const { data, error } = await db(userClient(authToken))
      .from("site_diary_entries")
      .select("id")
      .eq("id", entryId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("tenant_attachments accepts target_table='site_diary_entries' (CHECK widened)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "site_diary_entries",
        target_id: entryId,
        filename: "site.jpg",
        storage_path: `${orgId}/site_diary_entries/${entryId}/probe.jpg`,
      });
    expect(error, error?.message).toBeNull();
  });

  it("tenant_attachments still rejects an unknown target_table (CHECK enforced)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "not_a_real_table",
        target_id: entryId,
        filename: "x.jpg",
        storage_path: `${orgId}/x/probe.jpg`,
      });
    expect(error).not.toBeNull();
  });
});
