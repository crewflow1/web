import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { loadFleetOverview, type FleetOverview } from "@/server/services/fleet-snapshot";
import { buildScheduleIntegrity } from "@/server/services/schedule-integrity";
import { emptyComplianceRollup } from "@/lib/fleet/compliance";
import {
  activeMaintenanceStatuses,
  composeOperations,
  type EstateAssetRow,
  type EstateCaseRow,
  type EstateCustodyRow,
  type EstateInspectionRow,
  type EstateOverrideRow,
  type EstateSafetyRow,
  type OperationsFacts,
  type OperationsView,
} from "@/lib/operations/compose";
import { operatingCost, type ConsumptionResult, type FuelTotals } from "@/lib/fleet/fuel";
import { SCHEDULE_WINDOW_DAYS } from "@/lib/schedule/window";

/**
 * Operations command centre — the READ layer.
 *
 * This module FETCHES and COMPOSES; it never decides and it NEVER WRITES. There
 * is no insert/update/delete/rpc anywhere in the file, and `OperationsClient`
 * structurally exposes only read verbs, so a write cannot be added without also
 * widening the type. Every classification comes from an existing pure lib via
 * lib/operations/compose.ts.
 *
 * SCOPING — belt and braces, deliberately:
 *   1. RLS: reads run on the caller's client (the user's JWT in the app).
 *   2. `org_id` PINNED on EVERY read. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so an RLS-only read BLENDS tenants for a dual-org
 *      member — the class fixed in #456 and repeatedly before that. RLS is the
 *      floor here, never the scoping mechanism. `__tests__/security/operations-
 *      active-org-scoping.test.ts` pins that on source; `__tests__/integration/
 *      rls/operations-isolation.test.ts` proves it against a real dual-org user.
 *
 * PAGING: `fetchAllRows` requires a UNIQUE total order — a non-unique sort key
 * (a date, an FK, a status) can drop or duplicate rows at a 500-row page edge.
 * Every read therefore orders by the primary key `id`. Ordering for DISPLAY is
 * the pure lib's job, not the query's.
 *
 * BOUNDING — nothing here reads a whole history:
 *   · maintenance cases are split into OPEN (`.in(status, activeMaintenance
 *     Statuses())`) and RECENTLY COMPLETED (a fixed window), never "all cases";
 *   · inspections are the open due queue (`draft` + a `due_at`), which is what
 *     the partial index on that pair exists for;
 *   · the safety picture is a two-wave read — the FAILS first, then the passes
 *     and overrides for only those assets — so it is bounded by the number of
 *     assets that have ever failed a safety check, not by inspection history;
 *   · custody is the OPEN set only;
 *   · fleet and schedule reuse their own already-bounded loaders (the fleet
 *     register, and the detector's fortnight window).
 *
 * FAN-OUT: two waves, never N+1. Wave 1 issues the six estate reads in parallel
 * alongside the fleet and schedule loaders; wave 2 resolves the two safety
 * follow-ups with one read each.
 *
 * TESTABILITY: `gatherOperationsFacts` takes the Supabase client as an argument
 * rather than creating it, so the integration suite drives the EXACT same
 * queries with a real user JWT against real Postgres (mirrors
 * server/services/job-site-hub.ts and schedule-integrity.ts).
 */

type Row = Record<string, unknown>;

/** Minimal, self-returning, READ-ONLY view of the PostgREST builder. */
export type OperationsClient = { from: (t: string) => OperationsBuilder };
type OperationsBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => OperationsBuilder;
  eq: (k: string, v: unknown) => OperationsBuilder;
  in: (k: string, v: readonly unknown[]) => OperationsBuilder;
  gte: (k: string, v: unknown) => OperationsBuilder;
  not: (k: string, op: string, v: unknown) => OperationsBuilder;
  order: (k: string, o: { ascending: boolean }) => OperationsBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

/**
 * How far back "recently completed" looks. A DISPLAY WINDOW, not a judgement:
 * it bounds the read so a ten-year-old org does not page its entire maintenance
 * history to render one card. A fortnight matches the schedule detector's
 * horizon, so the two "recent" surfaces on this page cover the same span of
 * time in opposite directions.
 */
export const RECENT_COMPLETION_DAYS = SCHEDULE_WINDOW_DAYS;

/** How many rows each card lists before deferring to its full surface. */
export const OPS_CARD_LIMIT = 6;

const ASSET_COLS = "id, org_id, name, category, status, registration";
const CASE_COLS =
  "id, org_id, asset_id, case_type, status, priority, title, out_of_service, " +
  "scheduled_for, completed_at, created_at";
const INSPECTION_DUE_COLS = "id, org_id, asset_id, title, due_at";
const SAFETY_COLS =
  "id, org_id, asset_id, title, status, outcome, safety_critical, inspected_at, " +
  "created_at, reinspection_of";
const OVERRIDE_COLS =
  "id, org_id, asset_id, inspection_id, reason, expires_at, created_at, created_by, revoked_at";
const CUSTODY_COLS =
  "id, org_id, asset_id, assignment_type, status, assigned_at, expected_return_at, " +
  "assignee_id, job_id, location";

/**
 * Page an org-pinned read to completion, ordered by the unique primary key.
 * `build` adds the narrowing filters; a read error degrades to whatever was
 * gathered, matching the briefing's and the fleet snapshot's best-effort posture.
 */
async function pagedRows<T>(
  db: OperationsClient,
  table: string,
  cols: string,
  orgId: string,
  build: (b: OperationsBuilder) => OperationsBuilder,
  pageSize?: number,
): Promise<T[]> {
  const { data } = await fetchAllRows<Row>(
    (from, to) =>
      // THE ORG PIN. Every single read in this file passes through here.
      build(db.from(table).select(cols).eq("org_id", orgId))
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return data as unknown as T[];
}

const identity = (b: OperationsBuilder): OperationsBuilder => b;

export interface EstateFacts {
  assets: EstateAssetRow[];
  openCases: EstateCaseRow[];
  recentCompletions: EstateCaseRow[];
  dueInspections: EstateInspectionRow[];
  safetyInspections: EstateSafetyRow[];
  overrides: EstateOverrideRow[];
  openCustody: EstateCustodyRow[];
}

/**
 * Read every estate fact the page needs, for ONE org.
 *
 * Wave 1 (six reads, parallel) covers the asset register, the open and recently
 * completed maintenance cases, the open inspection queue, the issued
 * safety-critical FAILURES, and open custody.
 *
 * Wave 2 (two reads) completes the safety picture for only those assets that
 * actually carry a failure: the issued safety-critical PASSES that may clear
 * them, and the live overrides that may bypass them. Reading passes for every
 * asset would grow without bound as inspections accumulate; narrowing to the
 * failing assets keeps the answer EXACT while keeping the read small — the same
 * indirect-source pattern as server/services/job-site-hub.ts.
 */
export async function gatherOperationsFacts(
  db: OperationsClient,
  orgId: string,
  sinceIso: string,
  pageSize?: number,
): Promise<EstateFacts> {
  const openStatuses = activeMaintenanceStatuses();

  const [assets, openCases, recentCompletions, dueInspections, safetyFails, openCustody] =
    await Promise.all([
      pagedRows<EstateAssetRow>(db, "assets", ASSET_COLS, orgId, identity, pageSize),
      pagedRows<EstateCaseRow>(
        db,
        "asset_maintenance_cases",
        CASE_COLS,
        orgId,
        (b) => b.in("status", openStatuses),
        pageSize,
      ),
      pagedRows<EstateCaseRow>(
        db,
        "asset_maintenance_cases",
        CASE_COLS,
        orgId,
        (b) => b.eq("status", "completed").gte("completed_at", sinceIso),
        pageSize,
      ),
      // The open due queue: a draft record that carries a due date. Exactly what
      // the (status, due_at) partial index was created for.
      pagedRows<EstateInspectionRow>(
        db,
        "asset_inspections",
        INSPECTION_DUE_COLS,
        orgId,
        (b) => b.eq("status", "draft").not("due_at", "is", null),
        pageSize,
      ),
      pagedRows<EstateSafetyRow>(
        db,
        "asset_inspections",
        SAFETY_COLS,
        orgId,
        (b) => b.eq("safety_critical", true).eq("status", "issued").eq("outcome", "fail"),
        pageSize,
      ),
      pagedRows<EstateCustodyRow>(
        db,
        "asset_assignments",
        CUSTODY_COLS,
        orgId,
        (b) => b.eq("status", "open"),
        pageSize,
      ),
    ]);

  const failingAssetIds = [...new Set(safetyFails.map((f) => f.asset_id).filter(Boolean))];

  const [safetyPasses, overrides] = await Promise.all([
    failingAssetIds.length === 0
      ? Promise.resolve([] as EstateSafetyRow[])
      : pagedRows<EstateSafetyRow>(
          db,
          "asset_inspections",
          SAFETY_COLS,
          orgId,
          (b) =>
            b
              .eq("safety_critical", true)
              .eq("status", "issued")
              .in("asset_id", failingAssetIds)
              .in("outcome", ["pass", "pass_with_defects"]),
          pageSize,
        ),
    failingAssetIds.length === 0
      ? Promise.resolve([] as EstateOverrideRow[])
      : pagedRows<EstateOverrideRow>(
          db,
          "asset_inspection_overrides",
          OVERRIDE_COLS,
          orgId,
          (b) => b.in("asset_id", failingAssetIds),
          pageSize,
        ),
  ]);

  return {
    assets,
    openCases,
    recentCompletions,
    dueInspections,
    // `currentSafetyBlocks` filters by outcome itself, so handing it the union of
    // fails and their clearing passes is exactly the input it expects.
    safetyInspections: [...safetyFails, ...safetyPasses],
    overrides,
    openCustody,
  };
}

export interface OperationsSnapshot {
  view: OperationsView;
  costs: {
    fuel: FuelTotals;
    /** Admin-only at the DB (20261002) — 0 for members BY CONSTRUCTION. */
    maintenanceSpend: number;
    operatingCost: number;
    consumption: ConsumptionResult;
  };
  window: { days: number; recentDays: number };
  generatedAt: string;
}

function emptyFleetOverview(): FleetOverview {
  return {
    vehicles: [],
    compliance: [],
    rollup: emptyComplianceRollup(),
    fuel: {
      logs: [],
      totals: { spend: 0, litres: 0, entries: 0 },
      byVehicle: [],
      consumption: { segments: [], mpg: null, measuredMiles: 0, skipped: 0 },
    },
    maintenanceSpend: 0,
    operatingCost: 0,
    counts: { total: 0, inService: 0, offRoad: 0, inWorkshop: 0 },
  };
}

function emptyEstate(): EstateFacts {
  return {
    assets: [],
    openCases: [],
    recentCompletions: [],
    dueInspections: [],
    safetyInspections: [],
    overrides: [],
    openCustody: [],
  };
}

/**
 * Build the whole command centre for one org.
 *
 * THREE independent loaders run in parallel — the fleet register, the schedule
 * detector, and this module's estate reads. Each is already best-effort in its
 * own right, and the estate read is wrapped so a failure degrades that half to
 * empty rather than blanking the page: an operator seeing "no maintenance cases"
 * beside a working fleet board is a smaller lie than a 500, and the card copy
 * never claims the absence of data proves the absence of a problem.
 */
export async function buildOperationsSnapshot(
  orgId: string,
  options: { now?: Date } = {},
): Promise<OperationsSnapshot> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const todayIso = generatedAt.slice(0, 10);
  const sinceIso = new Date(now.getTime() - RECENT_COMPLETION_DAYS * 86_400_000).toISOString();

  const [fleet, schedule, estate] = await Promise.all([
    loadFleetOverview(orgId, todayIso).catch((err) => {
      console.warn("[operations] fleet overview failed", err);
      return emptyFleetOverview();
    }),
    buildScheduleIntegrity(orgId, { now, limit: Number.MAX_SAFE_INTEGER }),
    (async () => {
      try {
        const supabase = await createClient();
        return await gatherOperationsFacts(
          supabase as unknown as OperationsClient,
          orgId,
          sinceIso,
        );
      } catch (err) {
        console.warn("[operations] estate read failed", err);
        return emptyEstate();
      }
    })(),
  ]);

  const facts: OperationsFacts = {
    todayIso,
    nowIso: generatedAt,
    ...estate,
    vehicleAssetIds: new Set(fleet.vehicles.map((v) => v.assetId)),
    vehicleCounts: fleet.counts,
    compliance: fleet.compliance,
    conflicts: schedule.conflicts,
  };

  return {
    view: composeOperations(facts),
    costs: {
      fuel: fleet.fuel.totals,
      maintenanceSpend: fleet.maintenanceSpend,
      // Reuses the fleet's own sum rather than adding the two figures again here.
      operatingCost: operatingCost(fleet.fuel.totals.spend, fleet.maintenanceSpend),
      consumption: fleet.fuel.consumption,
    },
    window: { days: SCHEDULE_WINDOW_DAYS, recentDays: RECENT_COMPLETION_DAYS },
    generatedAt,
  };
}
