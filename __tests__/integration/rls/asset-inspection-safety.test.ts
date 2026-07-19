import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Asset inspection SAFETY-BLOCKING — real-Postgres proof (20260928000000).
 *
 * Proves the M4c seam: the M2 custody guard (tg_asset_assignments_guard) now
 * refuses to issue an asset that has a CURRENT issued safety-critical FAIL, and
 * a later issued safety-critical PASS clears it. Triggers fire for every role,
 * so service_role is a faithful proxy. Covers check-out (insert) AND transfer
 * (the SECURITY INVOKER RPC), plus the negatives (non-safety-critical fail and a
 * draft fail don't block).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Q extends PromiseLike<Res<Row[]>> {
  eq(k: string, v: unknown): Q;
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

const TAG = `it-safety-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FAIL_AT = "2026-01-01T00:00:00.000Z";
const PASS_AT = "2026-02-01T00:00:00.000Z"; // later than FAIL_AT → clears the block

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Safety ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "safety asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkJob(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("jobs").insert({ org_id: org }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
// Insert an already-issued inspection directly (the immutability trigger is
// before-UPDATE only, so a seeded issued row is fine — the guard reads
// status/outcome/safety_critical/inspected_at).
function issuedInspection(org: string, asset: string, o: {
  safety_critical: boolean; outcome: string; inspected_at: string; status?: string;
}) {
  return db(serviceClient()).from("asset_inspections").insert({
    org_id: org, asset_id: asset, title: "safety", status: o.status ?? "issued",
    safety_critical: o.safety_critical, outcome: o.outcome, snapshot: { frozen: true },
    inspected_at: o.inspected_at,
  });
}
function openAssignment(org: string, asset: string, extra: Row = {}) {
  return db(serviceClient())
    .from("asset_assignments")
    .insert({ org_id: org, asset_id: asset, assignment_type: "allocated_to_job", status: "open", ...extra });
}

describeIntegration("asset custody · safety-blocking (M4c)", () => {
  let orgA = "";
  let jobA = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    jobA = await mkJob(orgA);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
  });

  it("BLOCKS check-out of an asset with a current issued safety-critical FAIL", async () => {
    const asset = await mkAsset(orgA);
    const insp = await issuedInspection(orgA, asset, { safety_critical: true, outcome: "fail", inspected_at: FAIL_AT });
    expect(insp.error, insp.error?.message).toBeNull();

    const r = await openAssignment(orgA, asset, { job_id: jobA });
    expect(r.error).not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/failed safety inspection/i);
  });

  it("CLEARS the block after a later issued safety-critical PASS (re-inspection)", async () => {
    const asset = await mkAsset(orgA);
    await issuedInspection(orgA, asset, { safety_critical: true, outcome: "fail", inspected_at: FAIL_AT });
    const pass = await issuedInspection(orgA, asset, { safety_critical: true, outcome: "pass", inspected_at: PASS_AT });
    expect(pass.error, pass.error?.message).toBeNull();

    const r = await openAssignment(orgA, asset, { job_id: jobA });
    expect(r.error, r.error?.message).toBeNull(); // issuable again
  });

  it("does NOT block a NON-safety-critical fail", async () => {
    const asset = await mkAsset(orgA);
    await issuedInspection(orgA, asset, { safety_critical: false, outcome: "fail", inspected_at: FAIL_AT });
    const r = await openAssignment(orgA, asset, { job_id: jobA });
    expect(r.error, r.error?.message).toBeNull();
  });

  it("does NOT block a DRAFT (unissued) safety fail — only issued failures count", async () => {
    const asset = await mkAsset(orgA);
    await issuedInspection(orgA, asset, { safety_critical: true, outcome: "fail", inspected_at: FAIL_AT, status: "draft" });
    const r = await openAssignment(orgA, asset, { job_id: jobA });
    expect(r.error, r.error?.message).toBeNull();
  });

  it("BLOCKS a transfer-in too (the guard fires on the RPC's new open row, atomic rollback)", async () => {
    const asset = await mkAsset(orgA);
    // Checked out fine BEFORE the failure…
    const first = await openAssignment(orgA, asset, { job_id: jobA });
    expect(first.error, first.error?.message).toBeNull();
    // …then a safety-critical fail is issued…
    await issuedInspection(orgA, asset, { safety_critical: true, outcome: "fail", inspected_at: FAIL_AT });
    // …so transferring it to a new holder is refused (and rolls back).
    const t = await db(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: asset, p_org_id: orgA, p_assignment_type: "allocated_to_job",
      p_job_id: jobA, p_assignee_id: null, p_vehicle_asset_id: null, p_location: null,
      p_issue_condition: null, p_issue_notes: null, p_expected_return_at: null, p_assigned_by: null,
    });
    expect(t.error).not.toBeNull();
    expect(t.error?.message ?? "").toMatch(/failed safety inspection/i);

    // The original open assignment survived the rollback.
    const stillOpen = await db(serviceClient())
      .from("asset_assignments").select("id").eq("asset_id", asset).eq("status", "open");
    expect(stillOpen.data ?? []).toHaveLength(1);
  });
});
