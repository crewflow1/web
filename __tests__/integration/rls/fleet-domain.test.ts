import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { assessCompliance, rollupCompliance } from "@/lib/fleet/compliance";
import { computeConsumption, summariseByVehicle, sumFuel } from "@/lib/fleet/fuel";

/**
 * Fleet domain against real Postgres — the CHECK widenings (20261057000000),
 * the atomic completion RPC, the fuel table's guards and odometer sync
 * (20261058000000), and the pure aggregation libs running over rows that
 * actually came out of the database.
 *
 * The widening test is the load-bearing one: the maintenance generator passes
 * `schedule.maintenance_type` STRAIGHT INTO `case_type`, so if only one of the
 * two CHECKs had been widened, every generated MOT case would fail at insert.
 * This proves both accept the compliance types.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
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
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-fleetdom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COMPLIANCE_TYPES = ["mot", "insurance", "road_tax"] as const;

describeIntegration("fleet · compliance engines + fuel", () => {
  let orgId = "";
  let assetId = "";
  let otherOrgId = "";
  let otherSupplierId = "";
  let userId = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const org = await svc
      .from("organizations")
      .insert({ name: "Fleet Domain Probe", slug: TOKEN })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");

    const other = await svc
      .from("organizations")
      .insert({ name: "Fleet Domain Other", slug: `${TOKEN}-o` })
      .select("id")
      .single();
    otherOrgId = String(other.data?.id ?? "");

    const otherSupplier = await svc
      .from("suppliers")
      .insert({ org_id: otherOrgId, name: "Foreign Garage Ltd" })
      .select("id")
      .single();
    expect(otherSupplier.error, otherSupplier.error?.message).toBeNull();
    otherSupplierId = String(otherSupplier.data?.id ?? "");

    const asset = await svc
      .from("assets")
      .insert({ org_id: orgId, name: "Domain probe van", category: "Vehicle" })
      .select("id")
      .single();
    expect(asset.error, asset.error?.message).toBeNull();
    assetId = String(asset.data?.id ?? "");

    const veh = await svc
      .from("fleet_vehicles")
      .insert({ asset_id: assetId, org_id: orgId, operational_status: "in_service" })
      .select("asset_id")
      .single();
    expect(veh.error, veh.error?.message).toBeNull();

    const email = `${TOKEN}@example.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    userId = created.data.user?.id ?? "";
    await svc.from("users").insert({ id: userId, email, full_name: "Fleet domain" });
    await svc.from("memberships").insert({ org_id: orgId, user_id: userId, role: "owner" });
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    if (otherOrgId) await svc.from("organizations").delete().eq("id", otherOrgId);
    if (userId) await serviceClient().auth.admin.deleteUser(userId);
  });

  // ── the coupled CHECK widening ────────────────────────────────────────────
  it("asset_service_schedules accepts every compliance cadence", async () => {
    for (const type of COMPLIANCE_TYPES) {
      const { error } = await db(serviceClient())
        .from("asset_service_schedules")
        .insert({
          org_id: orgId,
          asset_id: assetId,
          maintenance_type: type,
          next_due: "2027-01-01",
          interval_months: 12,
          lead_time_days: 30,
        })
        .select("id")
        .single();
      expect(error, `${type} schedule should be accepted: ${error?.message}`).toBeNull();
    }
  });

  it("asset_maintenance_cases accepts the SAME set — the generator passthrough works", async () => {
    // server/services/asset-maintenance-generator.ts writes
    // `case_type: schedule.maintenance_type` directly. If only the schedule
    // CHECK had been widened, this insert is exactly what would fail in cron.
    for (const type of COMPLIANCE_TYPES) {
      const { error } = await db(serviceClient())
        .from("asset_maintenance_cases")
        .insert({
          org_id: orgId,
          asset_id: assetId,
          case_type: type,
          status: "scheduled",
          title: `${type} due`,
        })
        .select("id")
        .single();
      expect(error, `${type} case should be accepted: ${error?.message}`).toBeNull();
    }
  });

  it("still rejects a case type nobody defined", async () => {
    const { error } = await db(serviceClient())
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "teleportation",
        status: "reported",
        title: "nope",
      })
      .select("id")
      .single();
    expect(error, "the widened CHECK must still be a CHECK").not.toBeNull();
  });

  it("keeps every pre-existing case type legal — a widening, never a narrowing", async () => {
    for (const type of ["breakdown", "corrective", "preventive", "service", "calibration", "warranty"]) {
      const { error } = await db(serviceClient())
        .from("asset_maintenance_cases")
        .insert({
          org_id: orgId,
          asset_id: assetId,
          case_type: type,
          status: "reported",
          title: `${type} regression probe`,
        })
        .select("id")
        .single();
      expect(error, `${type} must remain legal: ${error?.message}`).toBeNull();
    }
  });

  it("records mileage at the event on a case", async () => {
    const { data, error } = await db(serviceClient())
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "mot",
        status: "scheduled",
        title: "MOT with mileage",
        odometer_miles: 87_500,
      })
      .select("id, odometer_miles")
      .single();
    expect(error, error?.message).toBeNull();
    expect(Number(data?.odometer_miles)).toBe(87_500);
  });

  it("rejects an out-of-range odometer on a case", async () => {
    const { error } = await db(serviceClient())
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "mot",
        status: "reported",
        title: "bad odo",
        odometer_miles: -1,
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  // ── the atomic completion RPC ─────────────────────────────────────────────
  it("completes the generated case AND advances the schedule in one transaction", async () => {
    const svc = db(serviceClient());
    const sched = await svc
      .from("asset_service_schedules")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        maintenance_type: "mot",
        next_due: "2026-08-01",
        interval_months: 12,
        lead_time_days: 30,
      })
      .select("id")
      .single();
    const scheduleId = String(sched.data?.id);

    const kase = await svc
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "mot",
        status: "scheduled",
        title: "MOT 2026",
        schedule_id: scheduleId,
        cycle_key: "2026-08-01",
      })
      .select("id")
      .single();
    const caseId = String(kase.data?.id);

    const { error } = await rpc(serviceClient()).rpc("record_fleet_compliance_completion", {
      p_org_id: orgId,
      p_asset_id: assetId,
      p_case_id: caseId,
      p_schedule_id: scheduleId,
      p_case_type: "mot",
      p_title: "MOT 2026",
      p_completed_on: "2026-07-28",
      p_odometer_miles: 91_200,
      p_supplier_id: null,
      p_work_performed: "MOT passed, no advisories",
      p_next_due: "2027-07-28",
      p_completed_by: userId,
    });
    expect(error, error?.message).toBeNull();

    const done = await svc
      .from("asset_maintenance_cases")
      .select("status, work_performed, odometer_miles, completed_at")
      .eq("id", caseId);
    expect(String(done.data?.[0]?.status)).toBe("completed");
    expect(Number(done.data?.[0]?.odometer_miles)).toBe(91_200);

    const rolled = await svc
      .from("asset_service_schedules")
      .select("next_due, last_completed_at")
      .eq("id", scheduleId);
    expect(String(rolled.data?.[0]?.next_due)).toBe("2027-07-28");
    expect(rolled.data?.[0]?.last_completed_at).not.toBeNull();
  });

  it("ROLLS BACK the completion when the schedule half fails — no silent half-write", async () => {
    // The dangerous half-write is "obligation disappears, no evidence written".
    // A function body is one transaction, so a bad schedule id must undo the
    // case write too.
    const svc = db(serviceClient());
    const kase = await svc
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "insurance",
        status: "scheduled",
        title: "Insurance renewal",
      })
      .select("id")
      .single();
    const caseId = String(kase.data?.id);

    const { error } = await rpc(serviceClient()).rpc("record_fleet_compliance_completion", {
      p_org_id: orgId,
      p_asset_id: assetId,
      p_case_id: caseId,
      p_schedule_id: "11111111-1111-4111-8111-111111111111", // does not exist
      p_case_type: "insurance",
      p_title: "Insurance renewal",
      p_completed_on: "2026-07-28",
      p_odometer_miles: null,
      p_supplier_id: null,
      p_work_performed: "Renewed with Aviva",
      p_next_due: "2027-07-28",
      p_completed_by: userId,
    });
    expect(error, "a missing schedule must fail the whole call").not.toBeNull();
    // Guard against a false pass: a missing RPC also errors.
    expect(error?.code).not.toBe("PGRST202");

    const after = await svc
      .from("asset_maintenance_cases")
      .select("status, work_performed")
      .eq("id", caseId);
    // The case is untouched — the rollback worked.
    expect(String(after.data?.[0]?.status)).toBe("scheduled");
    expect(after.data?.[0]?.work_performed).toBeNull();
  });

  it("refuses a completion with no record of what was done", async () => {
    const { error } = await rpc(serviceClient()).rpc("record_fleet_compliance_completion", {
      p_org_id: orgId,
      p_asset_id: assetId,
      p_case_id: null,
      p_schedule_id: null,
      p_case_type: "road_tax",
      p_title: "Tax",
      p_completed_on: "2026-07-28",
      p_odometer_miles: null,
      p_supplier_id: null,
      p_work_performed: "   ",
      p_next_due: null,
      p_completed_by: userId,
    });
    expect(error, "evidence is required").not.toBeNull();
  });

  it("refuses to complete another org's case even as service_role", async () => {
    const { error } = await rpc(serviceClient()).rpc("record_fleet_compliance_completion", {
      p_org_id: otherOrgId, // wrong org for this asset
      p_asset_id: assetId,
      p_case_id: null,
      p_schedule_id: null,
      p_case_type: "mot",
      p_title: "Cross-org MOT",
      p_completed_on: "2026-07-28",
      p_odometer_miles: null,
      p_supplier_id: null,
      p_work_performed: "should not happen",
      p_next_due: null,
      p_completed_by: userId,
    });
    expect(error, "the asset guard should refuse a cross-org case").not.toBeNull();
  });

  it("a completed case stays frozen — the spine's G4 still applies to compliance", async () => {
    const svc = db(serviceClient());
    const kase = await svc
      .from("asset_maintenance_cases")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        case_type: "mot",
        status: "completed",
        title: "Frozen probe",
        work_performed: "Passed",
        completed_at: "2026-07-01T00:00:00Z",
      })
      .select("id")
      .single();
    const { error } = await svc
      .from("asset_maintenance_cases")
      .update({ work_performed: "Actually failed" })
      .eq("id", String(kase.data?.id));
    expect(error, "a completed case must not be rewritable").not.toBeNull();
  });

  // ── fuel ──────────────────────────────────────────────────────────────────
  it("accepts a fill and rejects the invalid shapes", async () => {
    const svc = db(serviceClient());
    const ok = await svc
      .from("asset_fuel_logs")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        filled_on: "2026-07-01",
        litres: 60,
        cost: 90,
        odometer_miles: 100_000,
        is_full_fill: true,
      })
      .select("id")
      .single();
    expect(ok.error, ok.error?.message).toBeNull();

    const zeroLitres = await svc
      .from("asset_fuel_logs")
      .insert({ org_id: orgId, asset_id: assetId, filled_on: "2026-07-02", litres: 0, cost: 10 })
      .select("id")
      .single();
    expect(zeroLitres.error, "zero litres is not a fill").not.toBeNull();

    const negativeCost = await svc
      .from("asset_fuel_logs")
      .insert({ org_id: orgId, asset_id: assetId, filled_on: "2026-07-02", cost: -5 })
      .select("id")
      .single();
    expect(negativeCost.error, "negative cost must be refused").not.toBeNull();

    const empty = await svc
      .from("asset_fuel_logs")
      .insert({ org_id: orgId, asset_id: assetId, filled_on: "2026-07-02", cost: 0 })
      .select("id")
      .single();
    expect(empty.error, "an entry with no litres and no cost records nothing").not.toBeNull();
  });

  it("refuses a fill dated in the future", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { error } = await db(serviceClient())
      .from("asset_fuel_logs")
      .insert({ org_id: orgId, asset_id: assetId, filled_on: future, cost: 50 })
      .select("id")
      .single();
    expect(error, "a future fill date must be refused").not.toBeNull();
  });

  it("refuses a fuel log pointing at another org's supplier or a non-member driver", async () => {
    const svc = db(serviceClient());
    const badSupplier = await svc
      .from("asset_fuel_logs")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        filled_on: "2026-07-03",
        cost: 50,
        supplier_id: otherSupplierId,
      })
      .select("id")
      .single();
    expect(badSupplier.error, "cross-org supplier must be refused").not.toBeNull();
  });

  it("advances the vehicle odometer forward only — a back-dated receipt cannot rewind it", async () => {
    const svc = db(serviceClient());
    // Higher reading advances it.
    await svc
      .from("asset_fuel_logs")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        filled_on: "2026-07-10",
        cost: 95,
        litres: 62,
        odometer_miles: 100_400,
      })
      .select("id")
      .single();
    let veh = await svc.from("fleet_vehicles").select("odometer_miles").eq("asset_id", assetId);
    expect(Number(veh.data?.[0]?.odometer_miles)).toBe(100_400);

    // An older, LOWER reading entered later must not move it backwards.
    await svc
      .from("asset_fuel_logs")
      .insert({
        org_id: orgId,
        asset_id: assetId,
        filled_on: "2026-06-15",
        cost: 88,
        litres: 58,
        odometer_miles: 99_000,
      })
      .select("id")
      .single();
    veh = await svc.from("fleet_vehicles").select("odometer_miles").eq("asset_id", assetId);
    expect(Number(veh.data?.[0]?.odometer_miles)).toBe(100_400);
  });

  it("aggregates real rows through the pure libs, and refuses to fake an mpg", async () => {
    const svc = db(serviceClient());
    const probe = await svc
      .from("assets")
      .insert({ org_id: orgId, name: "MPG probe", category: "Vehicle" })
      .select("id")
      .single();
    const probeId = String(probe.data?.id);
    await svc
      .from("fleet_vehicles")
      .insert({ asset_id: probeId, org_id: orgId })
      .select("asset_id")
      .single();

    // Two consecutive FULL fills with readings → a real figure.
    await svc.from("asset_fuel_logs").insert([
      {
        org_id: orgId,
        asset_id: probeId,
        filled_on: "2026-07-01",
        litres: 60,
        cost: 90,
        odometer_miles: 10_000,
        is_full_fill: true,
      },
      {
        org_id: orgId,
        asset_id: probeId,
        filled_on: "2026-07-08",
        litres: 45,
        cost: 67.5,
        odometer_miles: 10_300,
        is_full_fill: true,
      },
    ]);

    const rows = await svc
      .from("asset_fuel_logs")
      .select("id, asset_id, filled_on, odometer_miles, litres, cost, is_full_fill")
      .eq("asset_id", probeId);
    const logs = (rows.data ?? []).map((r) => ({
      id: String(r.id),
      assetId: String(r.asset_id),
      filledOn: String(r.filled_on),
      odometerMiles: r.odometer_miles == null ? null : Number(r.odometer_miles),
      litres: r.litres as string | null,
      cost: r.cost as string | null,
      isFullFill: r.is_full_fill === true,
    }));

    const totals = sumFuel(logs);
    expect(totals.spend).toBe(157.5);
    expect(totals.litres).toBe(105);

    const consumption = computeConsumption(logs);
    expect(consumption.mpg).not.toBeNull();
    expect(consumption.measuredMiles).toBe(300);

    // Now add a PARTIAL fill on top: it must not silently join the maths.
    await svc.from("asset_fuel_logs").insert({
      org_id: orgId,
      asset_id: probeId,
      filled_on: "2026-07-15",
      litres: 20,
      cost: 30,
      odometer_miles: 10_450,
      is_full_fill: false,
    });
    const rows2 = await svc
      .from("asset_fuel_logs")
      .select("id, asset_id, filled_on, odometer_miles, litres, cost, is_full_fill")
      .eq("asset_id", probeId);
    const logs2 = (rows2.data ?? []).map((r) => ({
      id: String(r.id),
      assetId: String(r.asset_id),
      filledOn: String(r.filled_on),
      odometerMiles: r.odometer_miles == null ? null : Number(r.odometer_miles),
      litres: r.litres as string | null,
      cost: r.cost as string | null,
      isFullFill: r.is_full_fill === true,
    }));
    const after = computeConsumption(logs2);
    // Still exactly ONE valid segment — the partial adds spend, not efficiency.
    expect(after.segments).toHaveLength(1);
    expect(after.mpg).toBe(consumption.mpg);
    expect(sumFuel(logs2).spend).toBe(187.5);

    const perVehicle = summariseByVehicle(logs2);
    expect(perVehicle[0]!.assetId).toBe(probeId);
    expect(perVehicle[0]!.spend).toBe(187.5);
  });

  // ── detection over real schedule rows ────────────────────────────────────
  it("detects overdue and upcoming compliance from rows read back out of Postgres", async () => {
    const svc = db(serviceClient());
    const probe = await svc
      .from("assets")
      .insert({ org_id: orgId, name: "Detection probe", category: "Vehicle" })
      .select("id")
      .single();
    const probeId = String(probe.data?.id);
    await svc
      .from("fleet_vehicles")
      .insert({ asset_id: probeId, org_id: orgId, operational_status: "in_service" })
      .select("asset_id")
      .single();

    await svc.from("asset_service_schedules").insert([
      // expired MOT on an in-service van → the legal breach
      {
        org_id: orgId,
        asset_id: probeId,
        maintenance_type: "mot",
        next_due: "2026-07-18",
        lead_time_days: 30,
      },
      // service due in a fortnight
      {
        org_id: orgId,
        asset_id: probeId,
        maintenance_type: "service",
        next_due: "2026-08-11",
        lead_time_days: 30,
      },
      // road tax far out
      {
        org_id: orgId,
        asset_id: probeId,
        maintenance_type: "road_tax",
        next_due: "2027-06-01",
        lead_time_days: 30,
      },
    ]);

    const rows = await svc
      .from("asset_service_schedules")
      .select("id, asset_id, maintenance_type, next_due, lead_time_days, active")
      .eq("asset_id", probeId);

    const statuses = assessCompliance(
      (rows.data ?? []).map((r) => ({
        id: String(r.id),
        assetId: String(r.asset_id),
        type: String(r.maintenance_type) as "mot" | "insurance" | "road_tax" | "service",
        nextDue: String(r.next_due),
        active: r.active === true,
        leadTimeDays: Number(r.lead_time_days),
        inService: true,
      })),
      "2026-07-28",
    );

    const rollup = rollupCompliance(statuses);
    expect(rollup.legalBreach.count).toBe(1);
    expect(rollup.legalBreach.maxDaysOverdue).toBe(10);
    expect(rollup.dueSoon.count).toBe(1);
    expect(rollup.dueSoon.soonestDays).toBe(14);
    // The road tax a year out is neither overdue nor due soon.
    expect(rollup.otherOverdue.count).toBe(0);
  });

  it("anon cannot read fuel logs", async () => {
    const { data, error } = await db(anonClient()).from("asset_fuel_logs").select("id");
    expect(error ? true : (data ?? []).length === 0).toBe(true);
  });
});
