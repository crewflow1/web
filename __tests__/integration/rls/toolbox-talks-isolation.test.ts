import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * RLS proof — toolbox talks are tenant-private (20260921000000).
 *
 * Mirrors the snags / site-diary proofs: against real Postgres, prove
 * service_role reads its own row, anon is denied, an authenticated non-member is
 * denied (membership-gated), and the shared tenant_attachments CHECK now accepts
 * 'toolbox_talks' while still rejecting an unknown table.
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

const TOKEN = `it-toolbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("toolbox_talks · tenant isolation (RLS)", () => {
  let orgId = "";
  let talkId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Toolbox RLS Probe Org", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");
    if (!orgId) throw new Error("failed to create probe organisation");

    const talk = await svc
      .from("toolbox_talks")
      .insert({ org_id: orgId, talk_date: "2026-07-18", topic: "Probe talk" })
      .select("id")
      .single();
    expect(talk.error, talk.error?.message).toBeNull();
    talkId = String(talk.data?.id ?? "");
    if (!talkId) throw new Error("failed to create probe toolbox talk");

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

  it("service_role can read the talk it created (RLS bypassed)", async () => {
    const { data, error } = await db(serviceClient())
      .from("toolbox_talks")
      .select("id, topic")
      .eq("id", talkId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("anon cannot see the talk (RLS enforced)", async () => {
    const { data, error } = await db(anonClient())
      .from("toolbox_talks")
      .select("id")
      .eq("id", talkId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated non-member cannot see the talk (membership-gated)", async () => {
    const { data, error } = await db(userClient(authToken))
      .from("toolbox_talks")
      .select("id")
      .eq("id", talkId);
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("tenant_attachments accepts target_table='toolbox_talks' (CHECK widened)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "toolbox_talks",
        target_id: talkId,
        filename: "attendance.jpg",
        storage_path: `${orgId}/toolbox_talks/${talkId}/probe.jpg`,
      });
    expect(error, error?.message).toBeNull();
  });

  it("tenant_attachments still rejects an unknown target_table (CHECK enforced)", async () => {
    const { error } = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: orgId,
        target_table: "not_a_real_table",
        target_id: talkId,
        filename: "x.jpg",
        storage_path: `${orgId}/x/probe.jpg`,
      });
    expect(error).not.toBeNull();
  });
});
