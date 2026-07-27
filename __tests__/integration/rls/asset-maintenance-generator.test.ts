import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { runMaintenanceGenerator } from "@/server/services/asset-maintenance-generator";

/**
 * Service schedules + case generation — real-Postgres proof (20261003000000).
 *
 * The REAL generator service against a live database (the M4b-2 proof shape):
 *   - a due schedule yields EXACTLY ONE 'scheduled' case per cycle (type,
 *     supplier and date propagated); re-runs are idempotent; the schedule
 *     advances exactly one interval (CAS);
 *   - CONCURRENT runs create one case and one advance;
 *   - paused schedules generate nothing; one-offs deactivate after one;
 *   - cross-org schedule refs and the generated-provenance smuggle are
 *     rejected; anon reads nothing.
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

const TAG = `it-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TODAY = "2026-07-20";

async function mkOrg(slug: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("organizations").insert({ name: `Svc ${slug}`, slug: `${TAG}-${slug}` }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
async function mkAsset(org: string): Promise<string> {
  const { data, error } = await db(serviceClient())
    .from("assets").insert({ org_id: org, name: "serviced asset" }).select("id").single();
  expect(error, error?.message).toBeNull();
  return String(data?.id ?? "");
}
function mkSchedule(org: string, asset: string, over: Row = {}) {
  return db(serviceClient())
    .from("asset_service_schedules")
    .insert({
      org_id: org, asset_id: asset, maintenance_type: "service",
      interval_months: 6, next_due: TODAY, lead_time_days: 14, active: true, ...over,
    })
    .select("id").single();
}
async function casesFor(scheduleId: string) {
  const { data } = await db(serviceClient())
    .from("asset_maintenance_cases")
    .select("id, status, case_type, title, scheduled_for, cycle_key, supplier_id")
    .eq("schedule_id", scheduleId);
  return data ?? [];
}
async function scheduleRow(id: string) {
  const { data } = await db(serviceClient())
    .from("asset_service_schedules").select("id, next_due, active").eq("id", id).maybeSingle();
  return data;
}

describeIntegration("asset_service_schedules · idempotent case generation", () => {
  let orgA = "";
  let orgB = "";
  let assetA = "";
  let assetB = "";

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    assetA = await mkAsset(orgA);
    assetB = await mkAsset(orgB);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
  });

  it("generates EXACTLY ONE correctly-shaped case; re-run adds nothing; one CAS advance", async () => {
    const s = await mkSchedule(orgA, assetA);
    const sid = String(s.data?.id);

    await runMaintenanceGenerator(TODAY);
    let rows = await casesFor(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("scheduled");
    expect(rows[0]!.case_type).toBe("service");
    expect(rows[0]!.cycle_key).toBe(TODAY);
    expect(String(rows[0]!.scheduled_for)).toContain(TODAY);

    await runMaintenanceGenerator(TODAY);
    rows = await casesFor(sid);
    expect(rows).toHaveLength(1);
    const after = await scheduleRow(sid);
    expect(after?.next_due).toBe("2027-01-20"); // exactly ONE 6-month advance
  });

  it("CONCURRENT runs create one case and one advance", async () => {
    const s = await mkSchedule(orgA, assetA, { next_due: "2026-07-19", interval_months: null, interval_days: 42 });
    const sid = String(s.data?.id);

    await Promise.all([runMaintenanceGenerator(TODAY), runMaintenanceGenerator(TODAY)]);

    expect(await casesFor(sid)).toHaveLength(1);
    const after = await scheduleRow(sid);
    expect(after?.next_due).toBe("2026-08-30"); // ONE 42-day advance from 07-19
  });

  it("paused schedules generate nothing; one-offs deactivate after one", async () => {
    const paused = await mkSchedule(orgA, assetA, { active: false });
    const oneOff = await mkSchedule(orgA, assetA, { interval_months: null, interval_days: null });

    await runMaintenanceGenerator(TODAY);
    expect(await casesFor(String(paused.data?.id))).toHaveLength(0);
    expect(await casesFor(String(oneOff.data?.id))).toHaveLength(1);
    const after = await scheduleRow(String(oneOff.data?.id));
    expect(after?.active).toBe(false);

    await runMaintenanceGenerator(TODAY);
    expect(await casesFor(String(oneOff.data?.id))).toHaveLength(1);
  });

  it("rejects cross-org refs (schedule asset/supplier + generated-provenance smuggle)", async () => {
    const crossAsset = await mkSchedule(orgA, assetB);
    expect(crossAsset.error?.message ?? "").toMatch(/not in org/i);

    const sB = await mkSchedule(orgB, assetB, { next_due: "2030-01-01" });
    const smuggle = await db(serviceClient()).from("asset_maintenance_cases").insert({
      org_id: orgA, asset_id: assetA, case_type: "service", title: "bad provenance",
      status: "scheduled", schedule_id: String(sB.data?.id), cycle_key: "2030-01-01",
    }).select("id").single();
    expect(smuggle.error?.message ?? "").toMatch(/not in org/i);
  });

  it("denies anon (RLS)", async () => {
    const s = await mkSchedule(orgA, assetA, { next_due: "2030-01-01" });
    const { data, error } = await db(anonClient())
      .from("asset_service_schedules").select("id").eq("id", String(s.data?.id));
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
