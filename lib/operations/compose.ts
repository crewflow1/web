import {
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  MAINTENANCE_STATUS_LABELS,
  MAINTENANCE_TYPE_LABELS,
  isActiveCase,
  type MaintenancePriority,
  type MaintenanceStatus,
  type SchedulableMaintenanceType,
} from "@/lib/assets/maintenance";
import { isInspectionOverdue } from "@/lib/assets/inspection-schedule";
import {
  currentSafetyBlocks,
  hasUnbypassedBlock,
  type BlockableInspection,
  type OverrideRow,
  type SafetyBlock,
} from "@/lib/assets/inspection-override";
import { isOverdue as isCustodyOverdue, ASSIGNMENT_TYPE_LABELS, type AssignmentType } from "@/lib/assets/assignment";
import { isDisposed, type AssetStatus } from "@/lib/assets/schema";
import type { ComplianceStatus } from "@/lib/fleet/compliance";
import type { ScheduleConflict } from "@/lib/schedule/conflicts";

/**
 * Operations command centre — the COMPOSITION layer (PURE, no I/O).
 *
 * The whole point of this module is that it introduces NO NEW BUSINESS RULES.
 * Every judgement on this page — is a vehicle legally in breach, is an
 * inspection overdue, is a maintenance case still open, is a safety failure
 * still blocking, is a piece of kit late back, is a clash imminent — is already
 * owned by a pure, unit-tested module somewhere in the product, and this file
 * imports that module rather than re-deciding:
 *
 *   lib/fleet/compliance.ts        assessCompliance / complianceSeverity
 *                                  (MOT · insurance · road tax · service)
 *   lib/assets/maintenance.ts      isActiveCase, the status + priority
 *                                  vocabularies
 *   lib/assets/inspection-schedule isInspectionOverdue
 *   lib/assets/inspection-override currentSafetyBlocks / hasUnbypassedBlock
 *                                  (the UI mirror of the DB clearing predicate)
 *   lib/assets/assignment.ts       isOverdue (custody past its return date)
 *   lib/assets/schema.ts           isDisposed
 *   lib/schedule/conflicts.ts      detectScheduleConflicts + conflictSeverity
 *   lib/fleet/fuel.ts              sumFuel / operatingCost (via the service)
 *
 * What IS decided here is presentation: which slice of each already-classified
 * list this page shows, in what order, and where each row links. Ordering is a
 * total order everywhere (a unique id always breaks the final tie) so the page
 * renders identically for any permutation of the rows the reads return.
 *
 * The split mirrors lib/site-ops/timeline.ts and lib/schedule/conflicts.ts: the
 * service (server/services/operations-snapshot.ts) does the org-pinned, paged,
 * bounded reads; everything below is testable without a database, so the numbers
 * asserted in the unit tests are the exact numbers an owner sees.
 */

// ── Facts in (exactly the columns the service selects) ───────────────────────

export interface EstateAssetRow {
  id: string;
  name: string | null;
  category: string | null;
  status: string | null;
  registration: string | null;
}

export interface EstateCaseRow {
  id: string;
  asset_id: string;
  case_type: string | null;
  status: string | null;
  priority: string | null;
  title: string | null;
  out_of_service: boolean | null;
  scheduled_for: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface EstateInspectionRow {
  id: string;
  asset_id: string;
  title: string | null;
  due_at: string | null;
}

export interface EstateCustodyRow {
  id: string;
  asset_id: string;
  assignment_type: string | null;
  status: string | null;
  assigned_at: string;
  expected_return_at: string | null;
  assignee_id: string | null;
  job_id: string | null;
  location: string | null;
}

/** An issued safety-critical inspection, plus the asset it belongs to. */
export type EstateSafetyRow = BlockableInspection & { asset_id: string };
export type EstateOverrideRow = OverrideRow & { asset_id: string };

export interface OperationsFacts {
  /** UK/UTC calendar day, YYYY-MM-DD — the clock is the caller's, never ours. */
  todayIso: string;
  /** The same instant as an ISO timestamp, for override expiry comparisons. */
  nowIso: string;
  assets: readonly EstateAssetRow[];
  openCases: readonly EstateCaseRow[];
  recentCompletions: readonly EstateCaseRow[];
  dueInspections: readonly EstateInspectionRow[];
  safetyInspections: readonly EstateSafetyRow[];
  overrides: readonly EstateOverrideRow[];
  openCustody: readonly EstateCustodyRow[];
  /** Asset ids that carry a `fleet_vehicles` extension — drives the deep link. */
  vehicleAssetIds: ReadonlySet<string>;
  /**
   * Straight from the fleet snapshot, which derives them with `isInService`
   * (server/services/fleet-snapshot.ts). Passed in rather than recomputed so the
   * Operations page and /fleet can never print two different fleet sizes.
   */
  vehicleCounts: { total: number; inService: number; offRoad: number; inWorkshop: number };
  /** Already classified by lib/fleet/compliance.ts via the fleet snapshot. */
  compliance: readonly ComplianceStatus[];
  /** Already detected + ranked by lib/schedule/conflicts.ts. */
  conflicts: readonly ScheduleConflict[];
}

// ── Rows out ─────────────────────────────────────────────────────────────────

export interface OpsCaseRow {
  caseId: string;
  assetId: string;
  assetName: string;
  title: string;
  typeLabel: string;
  statusLabel: string;
  priority: MaintenancePriority | null;
  outOfService: boolean;
  createdAt: string;
  completedAt: string | null;
  href: string;
}

export interface OpsSafetyRow {
  assetId: string;
  assetName: string;
  blocks: SafetyBlock[];
  /** True when nothing bypasses the failure — the asset cannot be issued. */
  blocking: boolean;
  href: string;
}

export interface OpsInspectionRow {
  inspectionId: string;
  assetId: string;
  assetName: string;
  title: string;
  dueAt: string;
  overdue: boolean;
  href: string;
}

export interface OpsComplianceRow {
  /** The classification exactly as lib/fleet/compliance.ts produced it. */
  status: ComplianceStatus;
  assetName: string;
  registration: string | null;
  href: string;
}

export interface OpsCustodyRow {
  assignmentId: string;
  assetId: string;
  assetName: string;
  holderLabel: string;
  assignedAt: string;
  expectedReturnAt: string;
  href: string;
}

export interface OperationsView {
  estate: {
    vehicles: { total: number; inService: number; offRoad: number; inWorkshop: number };
    /** `total` counts every asset row; `active` excludes sold/lost/retired/etc. */
    assets: { total: number; active: number; held: number; idle: number };
  };
  fleet: {
    /** In-service vehicles with an expired MOT or insurance — a live offence. */
    breaches: OpsComplianceRow[];
    /** Everything overdue or inside its booking window, worst first. */
    attention: OpsComplianceRow[];
    /** Distinct vehicles behind `breaches` — what the banner counts. */
    breachVehicleCount: number;
  };
  equipment: {
    /** Open cases that have taken the asset out of service, worst first. */
    outOfService: OpsCaseRow[];
    /** Every other open case (still work, not a stoppage). */
    otherOpen: OpsCaseRow[];
    /** Assets with an uncleared safety-critical failure. */
    safetyBlocked: OpsSafetyRow[];
    /**
     * DISTINCT assets that cannot be used right now — the union of "an open
     * case has it out of service" and "a safety failure blocks its issue". A
     * set union of two existing classifications, so an asset that is both is
     * one item of kit, not two.
     */
    unusableAssetCount: number;
  };
  inspections: {
    overdue: OpsInspectionRow[];
    upcoming: OpsInspectionRow[];
  };
  schedule: {
    /** The lib's own `high` band — a clash today or tomorrow. */
    imminent: ScheduleConflict[];
    /** Everything found inside the detector's fortnight window. */
    total: number;
  };
  custody: {
    /** Open custody past its expected return date, longest overdue first. */
    overdue: OpsCustodyRow[];
    openTotal: number;
  };
  /** Completed maintenance inside the service's recent window, newest first. */
  recentCompletions: OpsCaseRow[];
  /**
   * True when this org has no operational estate at all — no assets, no
   * vehicles, and nothing in the schedule to flag. Drives the "here is what
   * Operations does" first-run state rather than an empty grid.
   */
  isNewEstate: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACTIVE_MAINTENANCE_STATUSES: readonly MaintenanceStatus[] = MAINTENANCE_STATUSES.filter(
  (s) => isActiveCase(s),
);

/**
 * The statuses a case can hold while it is still real work. Exported so the
 * service's `.in("status", …)` filter is the SAME set `isActiveCase` defines —
 * a status added to lib/assets/maintenance.ts is picked up by the read for free
 * instead of being silently excluded by a hand-copied list.
 */
export function activeMaintenanceStatuses(): readonly MaintenanceStatus[] {
  return ACTIVE_MAINTENANCE_STATUSES;
}

function assetLabel(names: ReadonlyMap<string, string>, assetId: string): string {
  const n = names.get(assetId)?.trim();
  return n && n.length > 0 ? n : "Unnamed asset";
}

/**
 * Where a row goes when clicked. A vehicle is an ASSET with an extension row, so
 * both pages are legitimate — but an operator who clicks a van expects the
 * vehicle page (plate, MOT, fuel), and one who clicks a breaker expects the
 * asset page. The vehicle id set is what tells the two apart.
 */
export function assetHref(vehicleAssetIds: ReadonlySet<string>, assetId: string): string {
  return vehicleAssetIds.has(assetId) ? `/fleet/vehicles/${assetId}` : `/assets/${assetId}`;
}

function priorityOf(value: string | null): MaintenancePriority | null {
  return (MAINTENANCE_PRIORITIES as readonly string[]).includes(value ?? "")
    ? (value as MaintenancePriority)
    : null;
}

/**
 * Display rank for an open case. NOT a severity judgement — `out_of_service` is
 * a stored fact ("this asset cannot be used"), and the priority order is the one
 * lib/assets/maintenance.ts already declares. Nothing is scored here.
 */
function caseRank(row: EstateCaseRow): number {
  const p = priorityOf(row.priority);
  const priorityRank = p == null ? 0 : MAINTENANCE_PRIORITIES.indexOf(p) + 1;
  return (row.out_of_service === true ? 100 : 0) + priorityRank;
}

function toCaseRow(
  row: EstateCaseRow,
  names: ReadonlyMap<string, string>,
  vehicleAssetIds: ReadonlySet<string>,
): OpsCaseRow {
  const type = (row.case_type ?? "") as SchedulableMaintenanceType;
  const status = (row.status ?? "") as MaintenanceStatus;
  return {
    caseId: row.id,
    assetId: row.asset_id,
    assetName: assetLabel(names, row.asset_id),
    title: (row.title ?? "").trim() || "Maintenance case",
    typeLabel: MAINTENANCE_TYPE_LABELS[type] ?? (row.case_type ?? "Case"),
    statusLabel: MAINTENANCE_STATUS_LABELS[status] ?? (row.status ?? ""),
    priority: priorityOf(row.priority),
    outOfService: row.out_of_service === true,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    href: assetHref(vehicleAssetIds, row.asset_id),
  };
}

function custodyHolder(row: EstateCustodyRow): string {
  const type = row.assignment_type as AssignmentType;
  if (type === "issued_to_staff") return "a team member";
  if (type === "allocated_to_job") return "a job";
  const where = row.location?.trim();
  if (where) return where;
  return (ASSIGNMENT_TYPE_LABELS[type] ?? "somewhere").toLowerCase();
}

// ── The composition ──────────────────────────────────────────────────────────

/**
 * Turn already-classified facts into the page's view model.
 *
 * Pure: no clock of its own (`facts.todayIso` / `facts.nowIso` carry the pinned
 * instant), no I/O, no mutation of the inputs. Every list is totally ordered.
 */
export function composeOperations(facts: OperationsFacts): OperationsView {
  const names = new Map<string, string>();
  for (const a of facts.assets) if (a.name) names.set(a.id, a.name);

  const activeAssets = facts.assets.filter((a) => !isDisposed((a.status ?? "") as AssetStatus));

  // Custody ------------------------------------------------------------------
  // `openCustody` is already `status = 'open'` at the read — the same predicate
  // /assets/holdings uses — so "held" here means exactly what that page means.
  const heldAssetIds = new Set(facts.openCustody.map((c) => c.asset_id));
  const overdueCustody: OpsCustodyRow[] = facts.openCustody
    .filter((c) => isCustodyOverdue(c.expected_return_at, c.status ?? "", facts.todayIso))
    .sort(
      (a, b) =>
        (a.expected_return_at ?? "").localeCompare(b.expected_return_at ?? "") ||
        a.id.localeCompare(b.id),
    )
    .map((c) => ({
      assignmentId: c.id,
      assetId: c.asset_id,
      assetName: assetLabel(names, c.asset_id),
      holderLabel: custodyHolder(c),
      assignedAt: c.assigned_at,
      expectedReturnAt: c.expected_return_at as string,
      href: assetHref(facts.vehicleAssetIds, c.asset_id),
    }));

  // Maintenance --------------------------------------------------------------
  const openCaseRows = [...facts.openCases]
    .sort((a, b) => caseRank(b) - caseRank(a) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((c) => toCaseRow(c, names, facts.vehicleAssetIds));

  const recentCompletions = [...facts.recentCompletions]
    .sort(
      (a, b) =>
        (b.completed_at ?? "").localeCompare(a.completed_at ?? "") || b.id.localeCompare(a.id),
    )
    .map((c) => toCaseRow(c, names, facts.vehicleAssetIds));

  // Inspections --------------------------------------------------------------
  const inspectionRows: OpsInspectionRow[] = facts.dueInspections
    .filter((i) => typeof i.due_at === "string" && i.due_at.length > 0)
    .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? "") || a.id.localeCompare(b.id))
    .map((i) => ({
      inspectionId: i.id,
      assetId: i.asset_id,
      assetName: assetLabel(names, i.asset_id),
      title: (i.title ?? "").trim() || "Inspection",
      dueAt: (i.due_at as string).slice(0, 10),
      overdue: isInspectionOverdue(i.due_at, facts.todayIso),
      // Deliberately the INSPECTION, not the asset: the operator's next action is
      // to complete the record, and that is where it happens.
      href: `/assets/${i.asset_id}/inspections/${i.id}`,
    }));

  // Safety blocks ------------------------------------------------------------
  // Grouped per asset and run through the same unit-tested mirror of the DB
  // clearing predicate that /assets/inspections and the asset detail page use.
  const byAsset = new Map<string, EstateSafetyRow[]>();
  for (const row of facts.safetyInspections) {
    const bucket = byAsset.get(row.asset_id);
    if (bucket) bucket.push(row);
    else byAsset.set(row.asset_id, [row]);
  }
  const safetyBlocked: OpsSafetyRow[] = [...byAsset.entries()]
    .map(([assetId, rows]) => {
      const blocks = currentSafetyBlocks(
        rows,
        facts.overrides.filter((o) => o.asset_id === assetId),
        facts.nowIso,
      );
      return {
        assetId,
        assetName: assetLabel(names, assetId),
        blocks,
        blocking: hasUnbypassedBlock(blocks),
        href: assetHref(facts.vehicleAssetIds, assetId),
      };
    })
    .filter((a) => a.blocks.length > 0)
    // Genuinely blocked before merely-overridden; asset id keeps the order total.
    .sort(
      (a, b) =>
        Number(b.blocking) - Number(a.blocking) ||
        b.blocks.length - a.blocks.length ||
        a.assetId.localeCompare(b.assetId),
    );

  // Fleet --------------------------------------------------------------------
  // `assessCompliance` has already ranked these worst-first and stamped the
  // severity; labelling and slicing them is all that happens here.
  const registrations = new Map<string, string>();
  for (const a of facts.assets) if (a.registration) registrations.set(a.id, a.registration);
  const toComplianceRow = (status: ComplianceStatus): OpsComplianceRow => ({
    status,
    assetName: assetLabel(names, status.assetId),
    registration: registrations.get(status.assetId) ?? null,
    href: `/fleet/vehicles/${status.assetId}#compliance`,
  });

  const attention = facts.compliance.filter((c) => c.state !== "ok").map(toComplianceRow);
  const breaches = facts.compliance.filter((c) => c.severity === "critical").map(toComplianceRow);

  const outOfService = openCaseRows.filter((c) => c.outOfService);
  const unusableAssets = new Set<string>([
    ...outOfService.map((c) => c.assetId),
    ...safetyBlocked.filter((a) => a.blocking).map((a) => a.assetId),
  ]);

  return {
    estate: {
      vehicles: { ...facts.vehicleCounts },
      assets: {
        total: facts.assets.length,
        active: activeAssets.length,
        held: heldAssetIds.size,
        idle: Math.max(0, activeAssets.filter((a) => !heldAssetIds.has(a.id)).length),
      },
    },
    fleet: {
      breaches,
      attention,
      breachVehicleCount: new Set(breaches.map((b) => b.status.assetId)).size,
    },
    equipment: {
      outOfService,
      otherOpen: openCaseRows.filter((c) => !c.outOfService),
      safetyBlocked,
      unusableAssetCount: unusableAssets.size,
    },
    inspections: {
      overdue: inspectionRows.filter((i) => i.overdue),
      upcoming: inspectionRows.filter((i) => !i.overdue),
    },
    schedule: {
      // `conflictSeverity` maps daysAway <= 1 to `high` and nothing else does —
      // so this IS the lib's own "today or tomorrow" band, not a second rule.
      imminent: facts.conflicts.filter((c) => c.severity === "high"),
      total: facts.conflicts.length,
    },
    custody: { overdue: overdueCustody, openTotal: facts.openCustody.length },
    recentCompletions,
    isNewEstate:
      facts.assets.length === 0 &&
      facts.vehicleCounts.total === 0 &&
      facts.conflicts.length === 0,
  };
}
