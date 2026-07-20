import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { runInspectionGenerator } from "@/server/services/asset-inspection-generator";

/**
 * Inspection schedules + due-work generation — real-Postgres proof (20260930).
 *
 * Proves the M4b-2 invariants with the REAL generator service running against a
 * live database:
 *   - a due schedule yields EXACTLY ONE draft inspection per cycle, carrying the
 *     frozen snapshot of the family's CURRENT PUBLISHED version;
 *   - repeated runs are idempotent; CONCURRENT runs create one row (the claim);
 *   - the schedule advances exactly one interval (CAS), one-offs deactivate;
 *   - paused schedules and unpublished/archived families generate nothing (and
 *     unpublished families do NOT advance — they resume, overdue, on republish);
 *   - same-org guards on schedules and on generated-inspection provenance;
 *   - RLS: anon reads nothing.
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
}
const db = (c: unknown) => c as unknown as Client;

const TAG = `it-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TODAY = "2026-07-20";

const DEF = {
  sections: [
    {
      key: "s1",
      title: "Checks",
      items: [
        {
          key: "ok",
          prompt: "All good",
          response_type: "pass_fail",
          required: true,
          safety_critical: false,
          severity: "minor",
          allow_na: false,
          requires_photo: false,
          requires_photo_on_fail: false,
          requires_comment_on_fail: true,
          requires_signature: false,
        },
      ],
    },
  ],
};

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Gen ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "scheduled asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkPublishedTemplate(org: string): Promise<{ id: string; family: string }> {
  const family = crypto.randomUUID();
  const { data, error } = await db(serviceClient())
    .from("asset_inspection_templates")
    .insert({ org_id: org, family_id: family, version: 1, name: `Gen check ${family.slice(0, 6)}`, status: "published", definition: DEF })
    .select("id").single();
  expect(error, error?.message).toBeNull();
  return { id: String(data?.id ?? ""), family };
}
async function mkSchedule(org: string, asset: string, template: string, over: Row = {}) {
  return db(serviceClient())
    .from("asset_inspection_schedules")
    .insert({
      org_id: org, asset_id: asset, template_id: template,
      interval_days: 7, next_due: TODAY, lead_time_days: 0, active: true, ...over,
    })
    .select("id").single();
}
async function inspectionsFor(scheduleId: string) {
  const { data } = await db(serviceClient())
    .from("asset_inspections")
    .select("id, status, title, due_at, cycle_key, template_version, template_snapshot")
    .eq("schedule_id", scheduleId);
  return data ?? [];
}
async function scheduleRow(id: string) {
  const { data } = await db(serviceClient())
    .from("asset_inspection_schedules")
    .select("id, next_due, active")
    .eq("id", id)
    .maybeSingle();
  return data;
}

describeIntegration("asset_inspection_schedules · idempotent due-work generation", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";
  let tplA = { id: "", family: "" };
  let tplB = { id: "", family: "" };

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    assetA = await mkAsset(orgA);
    assetB = await mkAsset(orgB);
    tplA = await mkPublishedTemplate(orgA);
    tplB = await mkPublishedTemplate(orgB);
  });

  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("generates EXACTLY ONE correctly-shaped due inspection, and a re-run adds nothing", async () => {
    const s = await mkSchedule(orgA, assetA, tplA.id);
    const sid = String(s.data?.id);

    await runInspectionGenerator(TODAY);
    let rows = await inspectionsFor(sid);
    expect(rows).toHaveLength(1);
    const insp = rows[0]!;
    expect(insp.status).toBe("draft");
    expect(insp.cycle_key).toBe(TODAY);
    expect(insp.template_version).toBe(1);
    expect(String(insp.due_at)).toContain(TODAY);
    const snap = insp.template_snapshot as { version: number; sections: unknown[] };
    expect(snap.version).toBe(1);
    expect(snap.sections).toHaveLength(1);

    // Idempotent: run again — the cycle exists and the schedule has advanced.
    await runInspectionGenerator(TODAY);
    rows = await inspectionsFor(sid);
    expect(rows).toHaveLength(1);
    const after = await scheduleRow(sid);
    expect(after?.next_due).toBe("2026-07-27"); // exactly ONE 7-day advance
  });

  it("CONCURRENT generator runs create exactly one inspection and one advance", async () => {
    const s = await mkSchedule(orgA, assetA, tplA.id, { next_due: "2026-07-19" });
    const sid = String(s.data?.id);

    await Promise.all([runInspectionGenerator(TODAY), runInspectionGenerator(TODAY)]);

    const rows = await inspectionsFor(sid);
    expect(rows).toHaveLength(1); // the claim: one winner
    const after = await scheduleRow(sid);
    expect(after?.next_due).toBe("2026-07-26"); // ONE interval from 07-19, not two
  });

  it("a PAUSED schedule generates nothing", async () => {
    const s = await mkSchedule(orgA, assetA, tplA.id, { active: false });
    await runInspectionGenerator(TODAY);
    expect(await inspectionsFor(String(s.data?.id))).toHaveLength(0);
  });

  it("an UNPUBLISHED family generates nothing and does NOT advance (resumes overdue)", async () => {
    // A family whose only version is superseded-equivalent: archive the published one.
    const fam = crypto.randomUUID();
    const { data: tpl } = await db(serviceClient())
      .from("asset_inspection_templates")
      .insert({ org_id: orgA, family_id: fam, version: 1, name: "Archived check", status: "archived", definition: DEF })
      .select("id").single();
    const s = await mkSchedule(orgA, assetA, String(tpl?.id));
    const sid = String(s.data?.id);

    await runInspectionGenerator(TODAY);
    expect(await inspectionsFor(sid)).toHaveLength(0);
    const after = await scheduleRow(sid);
    expect(after?.next_due).toBe(TODAY); // NOT advanced
    expect(after?.active).toBe(true);
  });

  it("a ONE-OFF schedule generates once then deactivates", async () => {
    const s = await mkSchedule(orgA, assetA, tplA.id, { interval_days: null, interval_months: null });
    const sid = String(s.data?.id);

    await runInspectionGenerator(TODAY);
    expect(await inspectionsFor(sid)).toHaveLength(1);
    const after = await scheduleRow(sid);
    expect(after?.active).toBe(false);

    // Re-run: inactive → nothing new.
    await runInspectionGenerator(TODAY);
    expect(await inspectionsFor(sid)).toHaveLength(1);
  });

  it("rejects cross-org schedule references (asset/template guards + provenance guard)", async () => {
    const badTemplate = await mkSchedule(orgA, assetA, tplB.id);
    expect(badTemplate.error?.message ?? "").toMatch(/not in org/i);

    const badAsset = await mkSchedule(orgA, assetB, tplA.id);
    expect(badAsset.error?.message ?? "").toMatch(/not in org/i);

    // Generated-inspection provenance: a cross-org schedule_id on an inspection.
    const sOk = await mkSchedule(orgB, assetB, tplB.id, { next_due: "2030-01-01" });
    const bad = await db(serviceClient()).from("asset_inspections").insert({
      org_id: orgA, asset_id: assetA, title: "Bad provenance", status: "draft",
      schedule_id: String(sOk.data?.id), cycle_key: "2030-01-01",
    }).select("id").single();
    expect(bad.error?.message ?? "").toMatch(/not in org/i);
  });

  it("denies anon (RLS)", async () => {
    const s = await mkSchedule(orgA, assetA, tplA.id, { next_due: "2030-01-01" });
    const { data, error } = await db(anonClient())
      .from("asset_inspection_schedules")
      .select("id")
      .eq("id", String(s.data?.id));
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
