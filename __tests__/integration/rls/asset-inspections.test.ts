import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Asset inspections — real-Postgres proof (20260927000000).
 *
 * Proves the M4a invariants against a live database. Triggers + CHECKs fire for
 * every role, so service_role is a faithful proxy for the immutability/integrity
 * proofs; RLS is proven with anon + an authenticated NON-member (the house
 * pattern):
 *   - IMMUTABILITY: snapshot is write-once; content/outcome/safety_critical are
 *     frozen once issued (the frozen safety record can't be re-scored);
 *   - ISSUE INTEGRITY: an issued inspection MUST carry an outcome AND a snapshot;
 *   - SAME-ORG GUARD: an inspection can't reference another org's asset;
 *   - CHECKs: bogus status/outcome rejected;
 *   - RLS: anon + non-member cannot read;
 *   - ATTACHMENTS: the shared CHECK accepts 'asset_inspections', still accepts a
 *     prior target ('assets'), and rejects a bogus target.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
  maybeSingle(): PromiseLike<Res<Row>>;
  single(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Upd;
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
  update(r: Row): Upd;
  delete(): Del;
}
interface Client {
  from(t: string): Table;
}
const db = (c: unknown) => c as unknown as Client;

const TAG = `it-insp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Insp ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "inspected asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function draft(org: string, asset: string, extra: Row = {}) {
  return db(serviceClient())
    .from("asset_inspections")
    .insert({ org_id: org, asset_id: asset, title: "Pre-use", status: "draft", ...extra });
}

const SNAP = { title: "Pre-use", outcome: "fail", frozen: true };

describeIntegration("asset_inspections · immutability + integrity + RLS", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";
  let nonMemberToken = "";
  let nonMemberId = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    assetA = await mkAsset(orgA);
    assetB = await mkAsset(orgB);

    const email = `${TAG}@example.test`;
    const password = `Pw-${TAG}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    nonMemberId = created.data.user?.id ?? "";
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    nonMemberToken = signedIn.data.session?.access_token ?? "";
    expect(nonMemberToken).not.toEqual("");
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
    if (nonMemberId) await serviceClient().auth.admin.deleteUser(nonMemberId);
  });

  it("accepts a draft, then a legit issue (outcome + snapshot) in one update", async () => {
    const ins = await draft(orgA, assetA, { safety_critical: true }).select("id").single();
    expect(ins.error, ins.error?.message).toBeNull();
    const id = String(ins.data?.id);

    const issued = await db(serviceClient())
      .from("asset_inspections")
      .update({ status: "issued", outcome: "fail", snapshot: SNAP, inspected_at: new Date().toISOString() })
      .eq("id", id);
    expect(issued.error, issued.error?.message).toBeNull();
  });

  it("REJECTS an issued inspection with no outcome", async () => {
    const ins = await draft(orgA, assetA).select("id").single();
    const id = String(ins.data?.id);
    const bad = await db(serviceClient())
      .from("asset_inspections")
      .update({ status: "issued", snapshot: SNAP })
      .eq("id", id);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/requires an outcome/i);
  });

  it("REJECTS an issued inspection with no snapshot", async () => {
    const ins = await draft(orgA, assetA).select("id").single();
    const id = String(ins.data?.id);
    const bad = await db(serviceClient())
      .from("asset_inspections")
      .update({ status: "issued", outcome: "pass" })
      .eq("id", id);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/requires a snapshot/i);
  });

  it("makes snapshot WRITE-ONCE, and freezes content/outcome/safety_critical after issue", async () => {
    const ins = await draft(orgA, assetA, { safety_critical: true, content: { a: 1 } }).select("id").single();
    const id = String(ins.data?.id);
    const iss = await db(serviceClient())
      .from("asset_inspections")
      .update({ status: "issued", outcome: "fail", snapshot: SNAP })
      .eq("id", id);
    expect(iss.error, iss.error?.message).toBeNull();

    const reSnap = await db(serviceClient())
      .from("asset_inspections").update({ snapshot: { tampered: true } }).eq("id", id);
    expect(reSnap.error?.message ?? "").toMatch(/snapshot is immutable/i);

    const reContent = await db(serviceClient())
      .from("asset_inspections").update({ content: { a: 999 } }).eq("id", id);
    expect(reContent.error?.message ?? "").toMatch(/content is frozen/i);

    const reOutcome = await db(serviceClient())
      .from("asset_inspections").update({ outcome: "pass" }).eq("id", id);
    expect(reOutcome.error?.message ?? "").toMatch(/outcome is frozen/i);

    const reSafety = await db(serviceClient())
      .from("asset_inspections").update({ safety_critical: false }).eq("id", id);
    expect(reSafety.error?.message ?? "").toMatch(/safety_critical is frozen/i);
  });

  it("REJECTS an inspection referencing another org's asset (same-org guard)", async () => {
    const bad = await draft(orgA, assetB).select("id").single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/not in org/i);
  });

  it("REJECTS a bogus status or outcome (CHECK)", async () => {
    const badStatus = await draft(orgA, assetA, { status: "weird" }).select("id").single();
    expect(badStatus.error).not.toBeNull();
    const badOutcome = await draft(orgA, assetA, { outcome: "maybe" }).select("id").single();
    expect(badOutcome.error).not.toBeNull();
  });

  it("denies anon and an authenticated NON-member (RLS)", async () => {
    const ins = await draft(orgA, assetA).select("id").single();
    const id = String(ins.data?.id);

    const anon = await db(anonClient()).from("asset_inspections").select("id").eq("id", id);
    expect(anon.error, anon.error?.message).toBeNull();
    expect(anon.data ?? []).toHaveLength(0);

    const nonMember = await db(userClient(nonMemberToken)).from("asset_inspections").select("id").eq("id", id);
    expect(nonMember.error, nonMember.error?.message).toBeNull();
    expect(nonMember.data ?? []).toHaveLength(0);
  });

  it("attachment CHECK accepts 'asset_inspections', still accepts 'assets', rejects bogus", async () => {
    const insp = await draft(orgA, assetA).select("id").single();
    const inspId = String(insp.data?.id);

    const ok = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "asset_inspections", target_id: inspId,
      filename: "cert.pdf", storage_path: `${orgA}/x.pdf`,
    }).select("id").single();
    expect(ok.error, ok.error?.message).toBeNull();

    const prior = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "assets", target_id: assetA,
      filename: "a.pdf", storage_path: `${orgA}/a.pdf`,
    }).select("id").single();
    expect(prior.error, prior.error?.message).toBeNull();

    const bogus = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "not_a_real_table", target_id: inspId,
      filename: "b.pdf", storage_path: `${orgA}/b.pdf`,
    }).select("id").single();
    expect(bogus.error).not.toBeNull();
  });
});
