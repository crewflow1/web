import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  assessCompliance,
  emptyComplianceRollup,
  isFleetComplianceType,
  rollupCompliance,
  type ComplianceScheduleInput,
  type ComplianceStatus,
  type FleetComplianceRollup,
} from "@/lib/fleet/compliance";
import {
  computeConsumption,
  operatingCost,
  summariseByVehicle,
  sumFuel,
  type FuelLogInput,
  type VehicleFuelSummary,
} from "@/lib/fleet/fuel";
import { sumMoney } from "@/lib/money";

/**
 * Fleet read model — every query PINNED to the active org.
 *
 * `current_org_ids()` returns EVERY org the viewer belongs to, so RLS alone
 * would blend a dual-org user's two fleets onto one page (the M2 P0 class).
 * Every read below therefore carries its own `.eq("org_id", orgId)` on top of
 * RLS, and every paged read carries a unique `id` tiebreaker so a page boundary
 * can never drop or repeat a vehicle. `__tests__/security/fleet-active-org-
 * scoping.test.ts` pins that on source; the integration tier proves it against
 * a real dual-org user.
 *
 * Best-effort like the other snapshot services: a failure degrades to an empty
 * fleet rather than throwing, so the Daily Briefing and the dashboard can never
 * be broken by this additive domain.
 */

type Row = Record<string, unknown>;
type AnyBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => AnyBuilder;
  order: (k: string, o: { ascending: boolean }) => AnyBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyBuilder;
  in: (k: string, v: unknown[]) => AnyBuilder;
  gte: (k: string, v: unknown) => AnyBuilder;
};
type LooseClient = { from: (t: string) => AnyBuilder };

/** Org-pinned, fully paged read with a total order (sort key + unique id). */
async function pagedRows(
  db: LooseClient,
  table: string,
  cols: string,
  orgId: string,
  idKey = "id",
): Promise<Row[]> {
  const { data } = await fetchAllRows<Row>((from, to) =>
    db
      .from(table)
      .select(cols)
      .eq("org_id", orgId)
      .order(idKey, { ascending: true })
      .range(from, to),
  );
  return data;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The asset + vehicle-extension pair, as every fleet surface consumes it. */
export interface FleetVehicle {
  assetId: string;
  name: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  variant: string | null;
  assetStatus: string;
  ownership: string;
  category: string | null;
  supplierId: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  notes: string | null;
  operationalStatus: string;
  vehicleClass: string | null;
  fuelType: string | null;
  vin: string | null;
  yearOfManufacture: number | null;
  firstRegisteredOn: string | null;
  grossWeightKg: number | null;
  motExempt: boolean;
  financeType: string;
  financeProviderId: string | null;
  financeAgreementRef: string | null;
  financeMonthlyPayment: number | null;
  financeEndDate: string | null;
  homeDepot: string | null;
  odometerMiles: number | null;
  odometerRecordedAt: string | null;
  createdAt: string;
}

const VEHICLE_COLS =
  "asset_id, org_id, vin, variant, year_of_manufacture, first_registered_on, fuel_type, " +
  "vehicle_class, gross_weight_kg, mot_exempt, operational_status, finance_type, " +
  "finance_provider_id, finance_agreement_ref, finance_monthly_payment, finance_end_date, " +
  "home_depot, odometer_miles, odometer_recorded_at, created_at";

const ASSET_COLS =
  "id, name, registration, manufacturer, model, ownership, status, category, " +
  "supplier_id, purchase_date, purchase_price, notes, created_at";

/**
 * Load every vehicle in the org: the `fleet_vehicles` extension rows joined to
 * their `assets` parents in TypeScript.
 *
 * WHY NOT A POSTGREST EMBED: the join key is the COMPOSITE FK (asset_id, org_id)
 * → assets(id, org_id). PostgREST relationship detection over a composite FK is
 * ambiguous enough that an embed can silently resolve differently than intended,
 * and a silently-wrong join in a tenant-scoped read is precisely the failure
 * class this domain must not have. Two explicitly org-pinned, fully-paged reads
 * merged on an id map are unambiguous, and both halves carry the org predicate —
 * so neither can leak, independent of how the planner resolves anything.
 */
export async function loadFleetVehicles(orgId: string): Promise<FleetVehicle[]> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const [vehicleRows, assetRows] = await Promise.all([
      pagedRows(db, "fleet_vehicles", VEHICLE_COLS, orgId, "asset_id"),
      pagedRows(db, "assets", ASSET_COLS, orgId),
    ]);

    const assetById = new Map<string, Row>();
    for (const a of assetRows) assetById.set(str(a.id), a);

    const out: FleetVehicle[] = [];
    for (const v of vehicleRows) {
      const assetId = str(v.asset_id);
      const a = assetById.get(assetId);
      // An extension row with no visible parent means the asset is outside this
      // org's view — skip rather than render a half-record. The composite FK
      // makes this unreachable; the guard costs nothing and fails safe.
      if (!a) continue;
      out.push({
        assetId,
        name: str(a.name),
        registration: (a.registration as string | null) ?? null,
        manufacturer: (a.manufacturer as string | null) ?? null,
        model: (a.model as string | null) ?? null,
        variant: (v.variant as string | null) ?? null,
        assetStatus: str(a.status),
        ownership: str(a.ownership),
        category: (a.category as string | null) ?? null,
        supplierId: (a.supplier_id as string | null) ?? null,
        purchaseDate: (a.purchase_date as string | null) ?? null,
        purchasePrice: numOrNull(a.purchase_price),
        notes: (a.notes as string | null) ?? null,
        operationalStatus: str(v.operational_status),
        vehicleClass: (v.vehicle_class as string | null) ?? null,
        fuelType: (v.fuel_type as string | null) ?? null,
        vin: (v.vin as string | null) ?? null,
        yearOfManufacture: numOrNull(v.year_of_manufacture),
        firstRegisteredOn: (v.first_registered_on as string | null) ?? null,
        grossWeightKg: numOrNull(v.gross_weight_kg),
        motExempt: v.mot_exempt === true,
        financeType: str(v.finance_type),
        financeProviderId: (v.finance_provider_id as string | null) ?? null,
        financeAgreementRef: (v.finance_agreement_ref as string | null) ?? null,
        financeMonthlyPayment: numOrNull(v.finance_monthly_payment),
        financeEndDate: (v.finance_end_date as string | null) ?? null,
        homeDepot: (v.home_depot as string | null) ?? null,
        odometerMiles: numOrNull(v.odometer_miles),
        odometerRecordedAt: (v.odometer_recorded_at as string | null) ?? null,
        createdAt: str(v.created_at),
      });
    }
    // Newest first with a unique asset_id tiebreaker — a TOTAL order, so paging
    // over this list is stable across requests.
    return out.sort(
      (x, y) => y.createdAt.localeCompare(x.createdAt) || y.assetId.localeCompare(x.assetId),
    );
  } catch (err) {
    console.warn("[fleet] loadFleetVehicles failed", err);
    return [];
  }
}

/** A vehicle is "in service" when the company says it is available to drive. */
export function isInService(v: Pick<FleetVehicle, "operationalStatus" | "assetStatus">): boolean {
  return v.operationalStatus === "in_service" && v.assetStatus === "active";
}

/**
 * Classify every fleet compliance schedule in the org. Shared by the Daily
 * Briefing (rolled up) and the fleet pages (itemised) so the two can never
 * report different numbers from two different computations.
 */
export async function loadFleetCompliance(
  orgId: string,
  todayIso: string,
  vehicles?: readonly FleetVehicle[],
): Promise<ComplianceStatus[]> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const fleet = vehicles ?? (await loadFleetVehicles(orgId));
    if (fleet.length === 0) return [];
    const inServiceByAsset = new Map(fleet.map((v) => [v.assetId, isInService(v)]));

    const scheduleRows = await pagedRows(
      db,
      "asset_service_schedules",
      "id, org_id, asset_id, maintenance_type, next_due, lead_time_days, active",
      orgId,
    );

    const inputs: ComplianceScheduleInput[] = [];
    for (const s of scheduleRows) {
      const type = str(s.maintenance_type);
      if (!isFleetComplianceType(type)) continue;
      const assetId = str(s.asset_id);
      // Only schedules on VEHICLES are fleet compliance. A 'service' schedule on
      // an excavator belongs to the asset register, not the fleet board.
      if (!inServiceByAsset.has(assetId)) continue;
      inputs.push({
        id: str(s.id),
        assetId,
        type,
        nextDue: str(s.next_due),
        active: s.active === true,
        leadTimeDays: numOrNull(s.lead_time_days) ?? 0,
        inService: inServiceByAsset.get(assetId) === true,
      });
    }

    return assessCompliance(inputs, todayIso);
  } catch (err) {
    console.warn("[fleet] loadFleetCompliance failed", err);
    return [];
  }
}

/**
 * The briefing-facing rollup. Best-effort: an empty rollup emits no fleet lines
 * at all, which is the correct degradation for an additive signal.
 */
export async function buildFleetComplianceRollup(
  orgId: string,
  todayIso: string,
): Promise<FleetComplianceRollup> {
  try {
    const statuses = await loadFleetCompliance(orgId, todayIso);
    return rollupCompliance(statuses);
  } catch (err) {
    console.warn("[fleet] buildFleetComplianceRollup failed", err);
    return emptyComplianceRollup();
  }
}

export interface FleetFuelView {
  logs: FuelLogInput[];
  totals: ReturnType<typeof sumFuel>;
  byVehicle: VehicleFuelSummary[];
  consumption: ReturnType<typeof computeConsumption>;
}

const FUEL_COLS =
  "id, org_id, asset_id, filled_on, odometer_miles, litres, cost, is_full_fill, " +
  "supplier_id, station, driver_id, notes, created_at";

/** Org-pinned fuel logs, optionally narrowed to one vehicle, fully paged. */
export async function loadFuelLogs(orgId: string, assetId?: string): Promise<FuelLogInput[]> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;
    const { data } = await fetchAllRows<Row>((from, to) => {
      const base = db.from("asset_fuel_logs").select(FUEL_COLS).eq("org_id", orgId);
      const scoped = assetId ? base.eq("asset_id", assetId) : base;
      return scoped.order("id", { ascending: true }).range(from, to);
    });
    return data.map((r) => ({
      id: str(r.id),
      assetId: str(r.asset_id),
      filledOn: str(r.filled_on),
      odometerMiles: numOrNull(r.odometer_miles),
      litres: (r.litres as number | string | null) ?? null,
      cost: (r.cost as number | string | null) ?? null,
      isFullFill: r.is_full_fill === true,
    }));
  } catch (err) {
    console.warn("[fleet] loadFuelLogs failed", err);
    return [];
  }
}

export interface FleetOverview {
  vehicles: FleetVehicle[];
  compliance: ComplianceStatus[];
  rollup: FleetComplianceRollup;
  fuel: FleetFuelView;
  /** Maintenance spend is admin-only at the DB — 0 for members by construction. */
  maintenanceSpend: number;
  operatingCost: number;
  counts: { total: number; inService: number; offRoad: number; inWorkshop: number };
}

/**
 * Everything the /fleet overview renders, in one org-pinned pass.
 *
 * `maintenanceSpend` reads `asset_maintenance_case_costs`, whose RLS is
 * ADMIN-ONLY on all four verbs (20261002000000 — supplier rates are invisible
 * to members AT THE DATABASE). A member's read therefore returns zero rows and
 * the figure is 0. That is not a bug to work around: the cost surface simply is
 * not theirs to see, and the UI labels the tile accordingly rather than
 * implying the fleet costs nothing to maintain.
 */
export async function loadFleetOverview(orgId: string, todayIso: string): Promise<FleetOverview> {
  const vehicles = await loadFleetVehicles(orgId);
  const [compliance, fuelLogs, maintenanceSpend] = await Promise.all([
    loadFleetCompliance(orgId, todayIso, vehicles),
    loadFuelLogs(orgId),
    loadMaintenanceSpend(orgId, new Set(vehicles.map((v) => v.assetId))),
  ]);

  const fleetFuelLogs = fuelLogs.filter((l) => vehicles.some((v) => v.assetId === l.assetId));
  const fuel: FleetFuelView = {
    logs: fleetFuelLogs,
    totals: sumFuel(fleetFuelLogs),
    byVehicle: summariseByVehicle(fleetFuelLogs),
    consumption: computeConsumption(fleetFuelLogs),
  };

  return {
    vehicles,
    compliance,
    rollup: rollupCompliance(compliance),
    fuel,
    maintenanceSpend,
    operatingCost: operatingCost(fuel.totals.spend, maintenanceSpend),
    counts: {
      total: vehicles.length,
      inService: vehicles.filter((v) => isInService(v)).length,
      offRoad: vehicles.filter((v) => v.operationalStatus === "off_road").length,
      inWorkshop: vehicles.filter((v) => v.operationalStatus === "in_workshop").length,
    },
  };
}

export interface VehicleAssignment {
  id: string;
  assignmentType: string;
  status: string;
  assignedAt: string;
  expectedReturnAt: string | null;
  actualReturnAt: string | null;
  assigneeId: string | null;
  jobId: string | null;
  location: string | null;
}

export interface VehicleCase {
  id: string;
  caseType: string;
  status: string;
  title: string;
  scheduledFor: string | null;
  completedAt: string | null;
  odometerMiles: number | null;
  supplierId: string | null;
  outOfService: boolean;
  scheduleId: string | null;
  createdAt: string;
}

export interface VehicleSchedule {
  id: string;
  maintenanceType: string;
  title: string | null;
  nextDue: string;
  intervalMonths: number | null;
  intervalDays: number | null;
  leadTimeDays: number;
  active: boolean;
  lastCompletedAt: string | null;
  supplierId: string | null;
}

export interface VehicleInspection {
  id: string;
  status: string;
  outcome: string | null;
  safetyCritical: boolean;
  performedAt: string | null;
  createdAt: string;
}

export interface VehicleDetail {
  assignments: VehicleAssignment[];
  cases: VehicleCase[];
  schedules: VehicleSchedule[];
  inspections: VehicleInspection[];
  fuel: FuelLogInput[];
}

/**
 * Everything the vehicle page composes from the EXISTING asset spine — custody
 * (asset_assignments), inspections, maintenance cases and service schedules —
 * plus this vehicle's fuel log. Fleet builds no second engine for any of it.
 *
 * Every read is pinned to BOTH the active org and this asset. The asset
 * predicate alone would not be enough: a multi-org user's asset id is only
 * meaningful inside one org, and RLS spans all of theirs.
 */
export async function loadVehicleDetail(orgId: string, assetId: string): Promise<VehicleDetail> {
  const empty: VehicleDetail = {
    assignments: [],
    cases: [],
    schedules: [],
    inspections: [],
    fuel: [],
  };
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;
    const scoped = (table: string, cols: string) =>
      db.from(table).select(cols).eq("org_id", orgId).eq("asset_id", assetId);

    const [assignRes, caseRes, schedRes, inspRes, fuel] = await Promise.all([
      scoped(
        "asset_assignments",
        "id, assignment_type, status, assigned_at, expected_return_at, actual_return_at, assignee_id, job_id, location",
      ).order("assigned_at", { ascending: false }),
      scoped(
        "asset_maintenance_cases",
        "id, case_type, status, title, scheduled_for, completed_at, odometer_miles, supplier_id, out_of_service, schedule_id, created_at",
      ).order("created_at", { ascending: false }),
      scoped(
        "asset_service_schedules",
        "id, maintenance_type, title, next_due, interval_months, interval_days, lead_time_days, active, last_completed_at, supplier_id",
      ).order("next_due", { ascending: true }),
      scoped(
        "asset_inspections",
        "id, status, outcome, safety_critical, performed_at, created_at",
      ).order("created_at", { ascending: false }),
      loadFuelLogs(orgId, assetId),
    ]);

    return {
      assignments: ((assignRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        assignmentType: str(r.assignment_type),
        status: str(r.status),
        assignedAt: str(r.assigned_at),
        expectedReturnAt: (r.expected_return_at as string | null) ?? null,
        actualReturnAt: (r.actual_return_at as string | null) ?? null,
        assigneeId: (r.assignee_id as string | null) ?? null,
        jobId: (r.job_id as string | null) ?? null,
        location: (r.location as string | null) ?? null,
      })),
      cases: ((caseRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        caseType: str(r.case_type),
        status: str(r.status),
        title: str(r.title),
        scheduledFor: (r.scheduled_for as string | null) ?? null,
        completedAt: (r.completed_at as string | null) ?? null,
        odometerMiles: numOrNull(r.odometer_miles),
        supplierId: (r.supplier_id as string | null) ?? null,
        outOfService: r.out_of_service === true,
        scheduleId: (r.schedule_id as string | null) ?? null,
        createdAt: str(r.created_at),
      })),
      schedules: ((schedRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        maintenanceType: str(r.maintenance_type),
        title: (r.title as string | null) ?? null,
        nextDue: str(r.next_due),
        intervalMonths: numOrNull(r.interval_months),
        intervalDays: numOrNull(r.interval_days),
        leadTimeDays: numOrNull(r.lead_time_days) ?? 0,
        active: r.active === true,
        lastCompletedAt: (r.last_completed_at as string | null) ?? null,
        supplierId: (r.supplier_id as string | null) ?? null,
      })),
      inspections: ((inspRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        status: str(r.status),
        outcome: (r.outcome as string | null) ?? null,
        safetyCritical: r.safety_critical === true,
        performedAt: (r.performed_at as string | null) ?? null,
        createdAt: str(r.created_at),
      })),
      fuel,
    };
  } catch (err) {
    console.warn("[fleet] loadVehicleDetail failed", err);
    return empty;
  }
}

/** Maintenance spend for the org's VEHICLE assets. Admin-visible only (see above). */
export async function loadMaintenanceSpend(
  orgId: string,
  vehicleAssetIds: ReadonlySet<string>,
): Promise<number> {
  if (vehicleAssetIds.size === 0) return 0;
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;
    const [caseRows, costRows] = await Promise.all([
      pagedRows(db, "asset_maintenance_cases", "id, org_id, asset_id", orgId),
      pagedRows(db, "asset_maintenance_case_costs", "case_id, org_id, cost_parts, cost_labour, cost_external", orgId, "case_id"),
    ]);
    const vehicleCaseIds = new Set(
      caseRows.filter((c) => vehicleAssetIds.has(str(c.asset_id))).map((c) => str(c.id)),
    );
    const amounts: Array<number | string | null> = [];
    for (const c of costRows) {
      if (!vehicleCaseIds.has(str(c.case_id))) continue;
      amounts.push(c.cost_parts as number | string | null);
      amounts.push(c.cost_labour as number | string | null);
      amounts.push(c.cost_external as number | string | null);
    }
    return sumMoney(amounts);
  } catch (err) {
    console.warn("[fleet] loadMaintenanceSpend failed", err);
    return 0;
  }
}
