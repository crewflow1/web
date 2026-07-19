import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Asset assignments — real-Postgres invariant proof (20260925000000).
 *
 * The defining risk of custody is conflicting/duplicate assignment, so the
 * guarantees are enforced at the DB and proven here against a live database:
 *   - the PARTIAL UNIQUE INDEX admits one open assignment per asset — a second
 *     fails, and two CONCURRENT check-outs yield exactly one winner;
 *   - the GUARD TRIGGER rejects a non-active asset (eligibility) and any
 *     cross-org job / vehicle / assignee (same-org references);
 *   - TRANSFER is atomic (close-old + open-new in one txn) and rolls back fully
 *     on a bad destination, leaving the original custody intact;
 *   - RETURN closes once (a repeat is a no-op);
 *   - the shared tenant_attachments CHECK admits 'asset_assignments', still
 *     admits a prior target, rejects bogus; and anon cannot read assignments.
 *
 * Triggers + unique indexes fire for every role, so service_role is a faithful
 * test of the invariants (it is also the most privileged app writer).
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
interface UpdChain
  extends PromiseLike<{ error: { message: string } | null; count: number | null }> {
  eq(k: string, v: unknown): UpdChain;
}
interface Del extends PromiseLike<Res<null>> {
  eq(k: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Q;
  insert(r: Row | Row[]): Ins;
  update(r: Row, o?: { count?: string }): UpdChain;
  delete(): Del;
}
interface Client {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
}
const db = (c: unknown) => c as unknown as Client;

const TOKEN = `it-aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations")
    .insert({ name: `AA ${slug}`, slug })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string, status = "active"): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets")
    .insert({ org_id: org, name: `asset ${status}`, status })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkJob(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("jobs")
    .insert({ org_id: org })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function openAssignment(org: string, asset: string, extra: Row = {}) {
  return db(serviceClient())
    .from("asset_assignments")
    .insert({ org_id: org, asset_id: asset, assignment_type: "allocated_to_job", status: "open", ...extra });
}

describeIntegration("asset_assignments · custody invariants", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";

  beforeAll(async () => {
    orgA = await mkOrg(`${TOKEN}-a`);
    orgB = await mkOrg(`${TOKEN}-b`);
    jobA = await mkJob(orgA);
    jobB = await mkJob(orgB);
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("admits one open assignment and rejects a second (partial unique index)", async () => {
    const asset = await mkAsset(orgA);
    const first = await openAssignment(orgA, asset, { job_id: jobA });
    expect(first.error, first.error?.message).toBeNull();
    const second = await openAssignment(orgA, asset, { job_id: jobA });
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe("23505");
  });

  it("two CONCURRENT check-outs yield exactly one winner", async () => {
    const asset = await mkAsset(orgA);
    const results = await Promise.all([
      openAssignment(orgA, asset, { job_id: jobA }),
      openAssignment(orgA, asset, { job_id: jobA }),
    ]);
    const wins = results.filter((r) => r.error == null).length;
    const losses = results.filter((r) => r.error?.code === "23505").length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    // ...and exactly one open row exists.
    const { data } = await db(serviceClient())
      .from("asset_assignments")
      .select("id")
      .eq("asset_id", asset)
      .eq("status", "open");
    expect(data ?? []).toHaveLength(1);
  });

  it("rejects assigning a non-active asset (eligibility guard)", async () => {
    const retired = await mkAsset(orgA, "retired");
    const r = await openAssignment(orgA, retired, { job_id: jobA });
    expect(r.error).not.toBeNull();
    expect(r.error?.message).toMatch(/cannot be assigned/i);
  });

  it("rejects cross-org job / vehicle / assignee references (same-org guard)", async () => {
    const asset = await mkAsset(orgA);
    const crossJob = await openAssignment(orgA, asset, { job_id: jobB });
    expect(crossJob.error, "cross-org job").not.toBeNull();
    const vehicleB = await mkAsset(orgB);
    const crossVeh = await openAssignment(orgA, asset, {
      assignment_type: "loaded_on_vehicle",
      vehicle_asset_id: vehicleB,
    });
    expect(crossVeh.error, "cross-org vehicle").not.toBeNull();
    const strangerAssignee = await openAssignment(orgA, asset, {
      assignment_type: "issued_to_staff",
      assignee_id: "99999999-9999-9999-9999-999999999999",
    });
    expect(strangerAssignee.error, "non-member assignee").not.toBeNull();
  });

  it("transfers atomically and rolls back on a bad destination", async () => {
    const asset = await mkAsset(orgA);
    const opened = await openAssignment(orgA, asset, { job_id: jobA });
    expect(opened.error, opened.error?.message).toBeNull();

    // Good transfer: closes old, opens new.
    const ok = await db(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: asset, p_org_id: orgA, p_assignment_type: "stored_at_depot",
      p_job_id: null, p_assignee_id: null, p_vehicle_asset_id: null,
      p_location: "Main yard", p_issue_condition: null, p_issue_notes: null,
      p_expected_return_at: null, p_assigned_by: null,
    });
    expect(ok.error, ok.error?.message).toBeNull();
    const afterOk = await db(serviceClient())
      .from("asset_assignments").select("id").eq("asset_id", asset).eq("status", "open");
    expect(afterOk.data ?? []).toHaveLength(1); // still exactly one open (the new one)

    // Bad transfer (cross-org job) must roll back — the current open stays.
    const bad = await db(serviceClient()).rpc("transfer_asset_assignment", {
      p_asset_id: asset, p_org_id: orgA, p_assignment_type: "allocated_to_job",
      p_job_id: jobB, p_assignee_id: null, p_vehicle_asset_id: null,
      p_location: null, p_issue_condition: null, p_issue_notes: null,
      p_expected_return_at: null, p_assigned_by: null,
    });
    expect(bad.error, "bad transfer must fail").not.toBeNull();
    const afterBad = await db(serviceClient())
      .from("asset_assignments").select("id, location").eq("asset_id", asset).eq("status", "open");
    expect(afterBad.data ?? []).toHaveLength(1); // unchanged — original intact
    expect((afterBad.data?.[0]?.location as string) ?? "").toBe("Main yard");
  });

  it("closes an assignment once; a repeat return is a no-op", async () => {
    const asset = await mkAsset(orgA);
    const opened = await openAssignment(orgA, asset, { job_id: jobA });
    const openId = String(opened.error ? "" : (await db(serviceClient())
      .from("asset_assignments").select("id").eq("asset_id", asset).eq("status", "open").single()).data?.id ?? "");
    const close1 = await db(serviceClient())
      .from("asset_assignments").update({ status: "closed" }, { count: "exact" }).eq("id", openId).eq("org_id", orgA).eq("status", "open");
    expect(close1.error, close1.error?.message).toBeNull();
    expect(close1.count).toBe(1);
    const close2 = await db(serviceClient())
      .from("asset_assignments").update({ status: "closed" }, { count: "exact" }).eq("id", openId).eq("org_id", orgA).eq("status", "open");
    expect(close2.count ?? 0).toBe(0); // already closed — no-op
  });

  it("attachment CHECK admits 'asset_assignments' + a prior target, rejects bogus; anon denied", async () => {
    const asset = await mkAsset(orgA);
    const okAssign = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "asset_assignments", target_id: asset,
      filename: "handover.jpg", storage_path: `${orgA}/asset_assignments/x.jpg`,
    });
    expect(okAssign.error, okAssign.error?.message).toBeNull();
    const okPrior = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "assets", target_id: asset,
      filename: "m.pdf", storage_path: `${orgA}/assets/m.pdf`,
    });
    expect(okPrior.error, okPrior.error?.message).toBeNull();
    const bogus = await db(serviceClient()).from("tenant_attachments").insert({
      org_id: orgA, target_table: "nope", target_id: asset, filename: "x", storage_path: "x",
    });
    expect(bogus.error).not.toBeNull();

    const anon = await db(anonClient()).from("asset_assignments").select("id").eq("org_id", orgA);
    expect(anon.error, anon.error?.message).toBeNull();
    expect(anon.data ?? []).toHaveLength(0);
  });
});
