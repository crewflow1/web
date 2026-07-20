import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Safety overrides + reinspection lineage + hardening — real-Postgres proof
 * (20261001000000).
 *
 * Proves every M4d invariant against a live database:
 *   - an ACTIVE override bypasses exactly ONE fail (check-out AND transfer);
 *     expiry/revocation restore blocking purely by predicate; the overridden
 *     inspection is never touched;
 *   - one LIVE override per fail (concurrency: exactly one winner);
 *   - override targets must be same-org, same-asset, issued safety-critical
 *     fails; the record is immutable except write-once revocation;
 *   - EXPLICIT LINEAGE: a linked issued pass clears its fail even when
 *     BACKDATED (the M4c timestamp fallback would not); lineage is scoped;
 *   - A4.9 HARDENING: a blocking fail cannot be retired (superseded/archived)
 *     without an issued successor;
 *   - PRE-USE RULE: a due, uncompleted draft from an ACTIVE required schedule
 *     blocks issue; completing it (or pausing the schedule) unblocks;
 *   - RLS: anon reads nothing; M2/M4c custody behaviour is regression-proven
 *     by the existing suites in the same run.
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
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
}
const db = (c: unknown) => c as unknown as Client;

const TAG = `it-ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Ovr ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "override asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkJob(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("jobs").insert({ org_id: org }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function issuedInspection(org: string, asset: string, o: {
  safety_critical?: boolean; outcome?: string; inspected_at?: string; status?: string;
  reinspection_of?: string | null; title?: string;
} = {}) {
  return db(serviceClient()).from("asset_inspections").insert({
    org_id: org, asset_id: asset, title: o.title ?? "safety", status: o.status ?? "issued",
    safety_critical: o.safety_critical ?? true, outcome: o.outcome ?? "fail",
    snapshot: { frozen: true }, inspected_at: o.inspected_at ?? T2,
    reinspection_of: o.reinspection_of ?? null,
  }).select("id").single();
}
function mkOverride(org: string, asset: string, inspection: string, o: Row = {}) {
  return db(serviceClient()).from("asset_inspection_overrides").insert({
    org_id: org, asset_id: asset, inspection_id: inspection,
    reason: "Awaiting parts; yard moves only per site manager", ...o,
  }).select("id").single();
}
function openAssignment(org: string, asset: string, job: string) {
  return db(serviceClient())
    .from("asset_assignments")
    .insert({ org_id: org, asset_id: asset, assignment_type: "allocated_to_job", status: "open", job_id: job });
}

describeIntegration("asset_inspection_overrides · overrides + lineage + hardening + pre-use", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    jobA = await mkJob(orgA);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("an ACTIVE override bypasses the block; the inspection is untouched", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    const failId = String(fail.data?.id);

    const blocked = await openAssignment(orgA, asset, jobA);
    expect(blocked.error?.message ?? "").toMatch(/failed safety inspection/i);

    const ovr = await mkOverride(orgA, asset, failId);
    expect(ovr.error, ovr.error?.message).toBeNull();

    const allowed = await openAssignment(orgA, asset, jobA);
    expect(allowed.error, allowed.error?.message).toBeNull();

    const { data: after } = await db(serviceClient())
      .from("asset_inspections").select("status, outcome, safety_critical").eq("id", failId).single();
    expect(after).toEqual({ status: "issued", outcome: "fail", safety_critical: true });
  });

  it("an EXPIRED override no longer bypasses (pure time predicate, no cron)", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    // Deterministically expired: created 2h ago, expired 1h ago (CHECK is relative).
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 1 * 3600_000).toISOString();
    const ovr = await mkOverride(orgA, asset, String(fail.data?.id), {
      created_at: twoHoursAgo, expires_at: oneHourAgo,
    });
    expect(ovr.error, ovr.error?.message).toBeNull();

    const blocked = await openAssignment(orgA, asset, jobA);
    expect(blocked.error?.message ?? "").toMatch(/failed safety inspection/i);
  });

  it("a REVOKED override no longer bypasses; revocation is write-once", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    const ovr = await mkOverride(orgA, asset, String(fail.data?.id));
    const ovrId = String(ovr.data?.id);

    const revoke = await db(serviceClient())
      .from("asset_inspection_overrides")
      .update({ revoked_at: new Date().toISOString(), revoke_reason: "parts arrived" })
      .eq("id", ovrId);
    expect(revoke.error, revoke.error?.message).toBeNull();

    const blocked = await openAssignment(orgA, asset, jobA);
    expect(blocked.error?.message ?? "").toMatch(/failed safety inspection/i);

    // No un-revoke — even as service role (triggers fire for every role).
    const unrevoke = await db(serviceClient())
      .from("asset_inspection_overrides").update({ revoked_at: null }).eq("id", ovrId);
    expect(unrevoke.error?.message ?? "").toMatch(/revoked and can no longer change/i);
  });

  it("ONE LIVE override per fail: concurrent creates yield exactly one winner", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    const failId = String(fail.data?.id);
    const results = await Promise.all([
      mkOverride(orgA, asset, failId),
      mkOverride(orgA, asset, failId),
    ]);
    const wins = results.filter((r) => r.error == null).length;
    const losses = results.filter((r) => r.error?.code === "23505").length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
  });

  it("rejects wrong targets: passed / non-critical / draft / cross-org / cross-asset", async () => {
    const asset = await mkAsset(orgA);
    const otherAsset = await mkAsset(orgA);
    const passed = await issuedInspection(orgA, asset, { outcome: "pass" });
    const nonCritical = await issuedInspection(orgA, asset, { safety_critical: false });
    const draft = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: asset, title: "draft", status: "draft", safety_critical: true,
    }).select("id").single();
    const failOther = await issuedInspection(orgA, otherAsset);

    for (const [id, re] of [
      [String(passed.data?.id), /not an issued safety-critical fail/i],
      [String(nonCritical.data?.id), /not an issued safety-critical fail/i],
      [String(draft.data?.id), /not an issued safety-critical fail/i],
      [String(failOther.data?.id), /not for asset/i],
    ] as const) {
      const bad = await mkOverride(orgA, asset, id);
      expect(bad.error?.message ?? "").toMatch(re);
    }

    const failB = await issuedInspection(orgB, await mkAsset(orgB));
    const crossOrg = await mkOverride(orgA, asset, String(failB.data?.id));
    expect(crossOrg.error?.message ?? "").toMatch(/not in org/i);
  });

  it("overrides are per-fail: two fails need two overrides; the record is immutable", async () => {
    const asset = await mkAsset(orgA);
    const f1 = await issuedInspection(orgA, asset, { inspected_at: T1 });
    const f2 = await issuedInspection(orgA, asset, { inspected_at: T2 });
    const ovr1 = await mkOverride(orgA, asset, String(f1.data?.id));

    const stillBlocked = await openAssignment(orgA, asset, jobA);
    expect(stillBlocked.error?.message ?? "").toMatch(/failed safety inspection/i);

    await mkOverride(orgA, asset, String(f2.data?.id));
    const allowed = await openAssignment(orgA, asset, jobA);
    expect(allowed.error, allowed.error?.message).toBeNull();

    const tamper = await db(serviceClient())
      .from("asset_inspection_overrides")
      .update({ expires_at: new Date(Date.now() + 86400_000).toISOString() })
      .eq("id", String(ovr1.data?.id));
    expect(tamper.error?.message ?? "").toMatch(/immutable except revocation/i);
  });

  it("EXPLICIT LINEAGE: a linked issued pass clears its fail even when BACKDATED", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset, { inspected_at: T2 });
    // Pass inspected BEFORE the fail (T1 < T2): arm 2 would NOT clear this.
    const pass = await issuedInspection(orgA, asset, {
      outcome: "pass", inspected_at: T1, reinspection_of: String(fail.data?.id),
    });
    expect(pass.error, pass.error?.message).toBeNull();

    const allowed = await openAssignment(orgA, asset, jobA);
    expect(allowed.error, allowed.error?.message).toBeNull();
  });

  it("lineage guards: cross-asset target and draft target rejected; frozen after issue", async () => {
    const asset = await mkAsset(orgA);
    const otherAsset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, otherAsset);
    const crossAsset = await issuedInspection(orgA, asset, {
      outcome: "pass", reinspection_of: String(fail.data?.id),
    });
    expect(crossAsset.error?.message ?? "").toMatch(/not an issued inspection of asset/i);

    const ownFail = await issuedInspection(orgA, asset, { inspected_at: T1 });
    const linked = await issuedInspection(orgA, asset, {
      outcome: "pass", inspected_at: T2, reinspection_of: String(ownFail.data?.id),
    });
    const refreeze = await db(serviceClient())
      .from("asset_inspections").update({ reinspection_of: null }).eq("id", String(linked.data?.id));
    expect(refreeze.error?.message ?? "").toMatch(/reinspection_of is frozen/i);
  });

  it("A4.9 HARDENING: a blocking fail cannot be retired without an issued successor", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    const failId = String(fail.data?.id);

    const escape = await db(serviceClient())
      .from("asset_inspections").update({ status: "superseded" }).eq("id", failId);
    expect(escape.error?.message ?? "").toMatch(/cannot be retired without an issued successor/i);

    // With an issued linked re-inspection, retiring is legitimate.
    await issuedInspection(orgA, asset, { outcome: "pass", inspected_at: T3, reinspection_of: failId });
    const retire = await db(serviceClient())
      .from("asset_inspections").update({ status: "superseded" }).eq("id", failId);
    expect(retire.error, retire.error?.message).toBeNull();
  });

  it("TRANSFER honours overrides: bypassed transfer succeeds; after revoke it rolls back", async () => {
    const asset = await mkAsset(orgA);
    const first = await openAssignment(orgA, asset, jobA);
    expect(first.error, first.error?.message).toBeNull();
    const fail = await issuedInspection(orgA, asset);
    const ovr = await mkOverride(orgA, asset, String(fail.data?.id));

    const transferArgs = {
      p_asset_id: asset, p_org_id: orgA, p_assignment_type: "allocated_to_job",
      p_job_id: jobA, p_assignee_id: null, p_vehicle_asset_id: null, p_location: null,
      p_issue_condition: null, p_issue_notes: null, p_expected_return_at: null, p_assigned_by: null,
    };
    const t1 = await db(serviceClient()).rpc("transfer_asset_assignment", transferArgs);
    expect(t1.error, t1.error?.message).toBeNull();

    await db(serviceClient())
      .from("asset_inspection_overrides")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", String(ovr.data?.id));
    const t2 = await db(serviceClient()).rpc("transfer_asset_assignment", transferArgs);
    expect(t2.error?.message ?? "").toMatch(/failed safety inspection/i);

    const { data: stillOpen } = await db(serviceClient())
      .from("asset_assignments").select("id").eq("asset_id", asset).eq("status", "open");
    expect(stillOpen ?? []).toHaveLength(1); // rollback preserved the open row
  });

  it("PRE-USE RULE: a due uncompleted required check blocks; completing or pausing unblocks", async () => {
    const asset = await mkAsset(orgA);
    // A published template + a required schedule + a due draft (as the generator makes).
    const fam = crypto.randomUUID();
    const tpl = await db(serviceClient()).from("asset_inspection_templates").insert({
      org_id: orgA, family_id: fam, version: 1, name: "Pre-use", status: "published",
      definition: { sections: [{ key: "s1", title: "S", items: [{ key: "k1", prompt: "ok", response_type: "pass_fail", required: true, safety_critical: false, severity: "minor", allow_na: false, requires_photo: false, requires_photo_on_fail: false, requires_comment_on_fail: false, requires_signature: false }] }] },
    }).select("id").single();
    const sched = await db(serviceClient()).from("asset_inspection_schedules").insert({
      org_id: orgA, asset_id: asset, template_id: String(tpl.data?.id),
      interval_days: 1, next_due: "2026-07-21", required_for_assignment: true, active: true,
    }).select("id").single();
    const schedId = String(sched.data?.id);
    const due = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: asset, title: "Pre-use", status: "draft",
      due_at: "2026-07-19T00:00:00.000Z", schedule_id: schedId, cycle_key: "2026-07-19",
    }).select("id").single();
    const dueId = String(due.data?.id);

    const blocked = await openAssignment(orgA, asset, jobA);
    expect(blocked.error?.message ?? "").toMatch(/requires a completed inspection/i);

    // Completing the check (draft → issued) unblocks.
    const complete = await db(serviceClient()).from("asset_inspections")
      .update({ status: "issued", outcome: "pass", snapshot: { frozen: true }, inspected_at: new Date().toISOString() })
      .eq("id", dueId);
    expect(complete.error, complete.error?.message).toBeNull();
    const allowed = await openAssignment(orgA, asset, jobA);
    expect(allowed.error, allowed.error?.message).toBeNull();
  });

  it("PRE-USE RULE escape valves: a paused or non-required schedule never blocks", async () => {
    const asset = await mkAsset(orgA);
    const fam = crypto.randomUUID();
    const tpl = await db(serviceClient()).from("asset_inspection_templates").insert({
      org_id: orgA, family_id: fam, version: 1, name: "Optional check", status: "published",
      definition: { sections: [{ key: "s1", title: "S", items: [{ key: "k1", prompt: "ok", response_type: "pass_fail", required: true, safety_critical: false, severity: "minor", allow_na: false, requires_photo: false, requires_photo_on_fail: false, requires_comment_on_fail: false, requires_signature: false }] }] },
    }).select("id").single();

    for (const over of [{ required_for_assignment: false, active: true }, { required_for_assignment: true, active: false }]) {
      const sched = await db(serviceClient()).from("asset_inspection_schedules").insert({
        org_id: orgA, asset_id: asset, template_id: String(tpl.data?.id),
        interval_days: 1, next_due: "2026-07-21", ...over,
      }).select("id").single();
      await db(serviceClient()).from("asset_inspections").insert({
        org_id: orgA, asset_id: asset, title: "Check", status: "draft",
        due_at: "2026-07-19T00:00:00.000Z", schedule_id: String(sched.data?.id), cycle_key: `2026-07-19-${String(sched.data?.id).slice(0, 4)}`,
      }).select("id").single();
    }

    const allowed = await openAssignment(orgA, asset, jobA);
    expect(allowed.error, allowed.error?.message).toBeNull();

    // Close it so later cases on this asset start clean.
    await db(serviceClient()).from("asset_assignments")
      .update({ status: "closed", actual_return_at: new Date().toISOString() })
      .eq("asset_id", asset).eq("status", "open");
  });

  it("denies anon (RLS)", async () => {
    const asset = await mkAsset(orgA);
    const fail = await issuedInspection(orgA, asset);
    const ovr = await mkOverride(orgA, asset, String(fail.data?.id));
    const { data, error } = await db(anonClient())
      .from("asset_inspection_overrides").select("id").eq("id", String(ovr.data?.id));
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
