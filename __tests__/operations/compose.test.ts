import { describe, it, expect } from "vitest";
import {
  activeMaintenanceStatuses,
  assetHref,
  composeOperations,
  type EstateAssetRow,
  type EstateCaseRow,
  type EstateCustodyRow,
  type EstateInspectionRow,
  type EstateOverrideRow,
  type EstateSafetyRow,
  type OperationsFacts,
} from "@/lib/operations/compose";
import { assessCompliance, type ComplianceScheduleInput } from "@/lib/fleet/compliance";
import { isActiveCase, MAINTENANCE_STATUSES } from "@/lib/assets/maintenance";
import type { ScheduleConflict } from "@/lib/schedule/conflicts";

/**
 * Operations command centre — the composition.
 *
 * The contract this file exists to pin is NEGATIVE: composeOperations must not
 * decide anything the domain libs already decide. So the assertions below feed
 * it inputs whose classification is fixed by lib/fleet/compliance.ts,
 * lib/assets/*, and lib/schedule/conflicts.ts, and check that the page's numbers
 * are exactly those classifications sliced and ordered — never re-judged.
 *
 * Clock is always passed in (`todayIso` / `nowIso`); nothing here reads a clock.
 */

const TODAY = "2026-07-28";
const NOW = "2026-07-28T09:00:00.000Z";

function asset(over: Partial<EstateAssetRow> = {}): EstateAssetRow {
  return {
    id: "a1",
    name: "Breaker 1",
    category: "Tools",
    status: "active",
    registration: null,
    ...over,
  };
}

function maintCase(over: Partial<EstateCaseRow> = {}): EstateCaseRow {
  return {
    id: "c1",
    asset_id: "a1",
    case_type: "breakdown",
    status: "reported",
    priority: "medium",
    title: "Won't start",
    out_of_service: false,
    scheduled_for: null,
    completed_at: null,
    created_at: "2026-07-20T08:00:00.000Z",
    ...over,
  };
}

function inspection(over: Partial<EstateInspectionRow> = {}): EstateInspectionRow {
  return { id: "i1", asset_id: "a1", title: "Pre-use check", due_at: TODAY, ...over };
}

function custody(over: Partial<EstateCustodyRow> = {}): EstateCustodyRow {
  return {
    id: "cu1",
    asset_id: "a1",
    assignment_type: "issued_to_staff",
    status: "open",
    assigned_at: "2026-07-01T08:00:00.000Z",
    expected_return_at: null,
    assignee_id: "u1",
    job_id: null,
    location: null,
    ...over,
  };
}

function safety(over: Partial<EstateSafetyRow> = {}): EstateSafetyRow {
  return {
    id: "s1",
    asset_id: "a1",
    title: "LOLER thorough examination",
    status: "issued",
    outcome: "fail",
    safety_critical: true,
    inspected_at: "2026-07-10T08:00:00.000Z",
    created_at: "2026-07-10T08:00:00.000Z",
    reinspection_of: null,
    ...over,
  };
}

function override(over: Partial<EstateOverrideRow> = {}): EstateOverrideRow {
  return {
    id: "o1",
    asset_id: "a1",
    inspection_id: "s1",
    reason: "Isolated and tagged out; needed for a controlled lift",
    expires_at: null,
    created_at: "2026-07-11T08:00:00.000Z",
    created_by: "u1",
    revoked_at: null,
    ...over,
  };
}

function conflict(over: Partial<ScheduleConflict> = {}): ScheduleConflict {
  return {
    key: "staff_double_booked:r1+r2",
    kind: "staff_double_booked",
    severity: "high",
    day: TODAY,
    at: NOW,
    daysAway: 0,
    title: "Dave is double-booked",
    detail: "Two shifts overlap.",
    subjectId: "u1",
    subjectName: "Dave",
    sourceIds: ["r1", "r2"],
    href: "/staff/rota",
    score: 3150,
    ...over,
  };
}

function facts(over: Partial<OperationsFacts> = {}): OperationsFacts {
  return {
    todayIso: TODAY,
    nowIso: NOW,
    assets: [],
    openCases: [],
    recentCompletions: [],
    dueInspections: [],
    safetyInspections: [],
    overrides: [],
    openCustody: [],
    vehicleAssetIds: new Set<string>(),
    vehicleCounts: { total: 0, inService: 0, offRoad: 0, inWorkshop: 0 },
    compliance: [],
    conflicts: [],
    ...over,
  };
}

function schedules(rows: Partial<ComplianceScheduleInput>[]): ComplianceScheduleInput[] {
  return rows.map((r, i) => ({
    id: `sch${i}`,
    assetId: "v1",
    type: "mot",
    nextDue: TODAY,
    active: true,
    leadTimeDays: 30,
    inService: true,
    ...r,
  }));
}

// ── The read filter is the lib's own definition ──────────────────────────────

describe("activeMaintenanceStatuses", () => {
  it("is exactly the set lib/assets/maintenance.ts calls active — nothing hand-copied", () => {
    expect([...activeMaintenanceStatuses()]).toEqual(MAINTENANCE_STATUSES.filter(isActiveCase));
    expect(activeMaintenanceStatuses()).not.toContain("completed");
    expect(activeMaintenanceStatuses()).not.toContain("cancelled");
    // …and it is non-trivial, so "excludes the terminal two" means something.
    expect(activeMaintenanceStatuses().length).toBe(MAINTENANCE_STATUSES.length - 2);
  });
});

// ── Deep links ───────────────────────────────────────────────────────────────

describe("assetHref", () => {
  it("sends a vehicle to the fleet page and everything else to the asset page", () => {
    const vehicles = new Set(["v1"]);
    expect(assetHref(vehicles, "v1")).toBe("/fleet/vehicles/v1");
    expect(assetHref(vehicles, "a1")).toBe("/assets/a1");
  });
});

// ── Fleet: sliced from assessCompliance, never re-judged ─────────────────────

describe("fleet compliance", () => {
  const compliance = assessCompliance(
    schedules([
      { id: "mot-late", type: "mot", nextDue: "2026-07-01", inService: true }, // critical
      { id: "tax-late", type: "road_tax", nextDue: "2026-07-01", inService: true }, // high
      { id: "srv-soon", type: "service", nextDue: "2026-08-10" }, // due_soon
      { id: "ins-fine", type: "insurance", nextDue: "2027-07-01", leadTimeDays: 30 }, // ok
    ]),
    TODAY,
  );

  const view = composeOperations(
    facts({
      compliance,
      assets: [asset({ id: "v1", name: "Transit LWB", registration: "AB12 CDE" })],
      vehicleAssetIds: new Set(["v1"]),
      vehicleCounts: { total: 1, inService: 1, offRoad: 0, inWorkshop: 0 },
    }),
  );

  it("shows every non-ok obligation and no ok ones", () => {
    expect(view.fleet.attention.map((r) => r.status.id)).toEqual([
      "mot-late",
      "tax-late",
      "srv-soon",
    ]);
  });

  it("keeps assessCompliance's own worst-first order", () => {
    expect(view.fleet.attention.map((r) => r.status.state)).toEqual([
      "overdue",
      "overdue",
      "due_soon",
    ]);
  });

  it("counts a breach only where the lib called it critical", () => {
    expect(view.fleet.breaches.map((r) => r.status.id)).toEqual(["mot-late"]);
    expect(view.fleet.breachVehicleCount).toBe(1);
  });

  it("labels each row from the asset register and links to the vehicle", () => {
    const row = view.fleet.attention[0]!;
    expect(row.assetName).toBe("Transit LWB");
    expect(row.registration).toBe("AB12 CDE");
    expect(row.href).toBe("/fleet/vehicles/v1#compliance");
  });

  it("counts distinct VEHICLES in the banner, not obligations", () => {
    const two = assessCompliance(
      schedules([
        { id: "m1", assetId: "v1", type: "mot", nextDue: "2026-07-01" },
        { id: "i1", assetId: "v1", type: "insurance", nextDue: "2026-07-02" },
      ]),
      TODAY,
    );
    const v = composeOperations(facts({ compliance: two, vehicleAssetIds: new Set(["v1"]) }));
    expect(v.fleet.breaches).toHaveLength(2);
    expect(v.fleet.breachVehicleCount).toBe(1);
  });
});

// ── Equipment ────────────────────────────────────────────────────────────────

describe("maintenance cases", () => {
  it("separates kit withdrawn from use from work that leaves it running", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "a1", name: "Excavator" }), asset({ id: "a2", name: "Dumper" })],
        openCases: [
          maintCase({ id: "open", asset_id: "a2", out_of_service: false }),
          maintCase({ id: "stopped", asset_id: "a1", out_of_service: true }),
        ],
      }),
    );
    expect(view.equipment.outOfService.map((c) => c.caseId)).toEqual(["stopped"]);
    expect(view.equipment.otherOpen.map((c) => c.caseId)).toEqual(["open"]);
  });

  it("counts DISTINCT unusable assets, never double-counting one item of kit", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "a1" }), asset({ id: "a2" }), asset({ id: "a3" })],
        openCases: [
          // Two cases on ONE asset, both stoppages — still one machine.
          maintCase({ id: "c1", asset_id: "a1", out_of_service: true }),
          maintCase({ id: "c2", asset_id: "a1", out_of_service: true }),
          maintCase({ id: "c3", asset_id: "a2", out_of_service: true }),
          maintCase({ id: "c4", asset_id: "a3", out_of_service: false }),
        ],
        // …and a1 is ALSO safety-blocked, which must not make it a fourth item.
        safetyInspections: [safety({ id: "s1", asset_id: "a1" })],
      }),
    );
    expect(view.equipment.outOfService).toHaveLength(3);
    expect(view.equipment.unusableAssetCount).toBe(2);
  });

  it("counts a safety-blocked asset with no maintenance case at all", () => {
    const view = composeOperations(
      facts({ assets: [asset()], safetyInspections: [safety()] }),
    );
    expect(view.equipment.outOfService).toHaveLength(0);
    expect(view.equipment.unusableAssetCount).toBe(1);
  });

  it("does not count an asset whose safety failure has a live override", () => {
    const view = composeOperations(
      facts({ assets: [asset()], safetyInspections: [safety()], overrides: [override()] }),
    );
    expect(view.equipment.safetyBlocked).toHaveLength(1);
    expect(view.equipment.unusableAssetCount).toBe(0);
  });

  it("orders by out-of-service, then the priority order maintenance.ts declares", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        openCases: [
          maintCase({ id: "low", priority: "low" }),
          maintCase({ id: "high", priority: "high" }),
          maintCase({ id: "medium", priority: "medium" }),
        ],
      }),
    );
    expect(view.equipment.otherOpen.map((c) => c.caseId)).toEqual(["high", "medium", "low"]);
  });

  it("breaks a tie on age then id, so the order is total and reproducible", () => {
    const rows = [
      maintCase({ id: "b", created_at: "2026-07-01T00:00:00.000Z" }),
      maintCase({ id: "a", created_at: "2026-07-01T00:00:00.000Z" }),
      maintCase({ id: "c", created_at: "2026-06-01T00:00:00.000Z" }),
    ];
    const forward = composeOperations(facts({ assets: [asset()], openCases: rows }));
    const reversed = composeOperations(facts({ assets: [asset()], openCases: [...rows].reverse() }));
    expect(forward.equipment.otherOpen.map((c) => c.caseId)).toEqual(["c", "a", "b"]);
    expect(reversed.equipment.otherOpen.map((c) => c.caseId)).toEqual(["c", "a", "b"]);
  });

  it("labels the type and status from maintenance.ts rather than echoing the enum", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        openCases: [maintCase({ case_type: "mot", status: "awaiting_supplier" })],
      }),
    );
    const row = view.equipment.otherOpen[0]!;
    expect(row.typeLabel).toBe("MOT");
    expect(row.statusLabel).toBe("With supplier");
  });

  it("routes a vehicle's case to the vehicle page and a tool's to the asset page", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "v1" }), asset({ id: "a1" })],
        openCases: [maintCase({ id: "c1", asset_id: "v1" }), maintCase({ id: "c2", asset_id: "a1" })],
        vehicleAssetIds: new Set(["v1"]),
      }),
    );
    const hrefs = new Map(view.equipment.otherOpen.map((c) => [c.caseId, c.href]));
    expect(hrefs.get("c1")).toBe("/fleet/vehicles/v1");
    expect(hrefs.get("c2")).toBe("/assets/a1");
  });

  it("lists recent completions newest first", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        recentCompletions: [
          maintCase({ id: "older", status: "completed", completed_at: "2026-07-20T08:00:00.000Z" }),
          maintCase({ id: "newer", status: "completed", completed_at: "2026-07-27T08:00:00.000Z" }),
        ],
      }),
    );
    expect(view.recentCompletions.map((c) => c.caseId)).toEqual(["newer", "older"]);
  });
});

// ── Safety blocks: the DB predicate's mirror, not a second opinion ───────────

describe("safety blocks", () => {
  it("reports an uncleared failure as blocking", () => {
    const view = composeOperations(
      facts({ assets: [asset({ name: "Telehandler" })], safetyInspections: [safety()] }),
    );
    expect(view.equipment.safetyBlocked).toHaveLength(1);
    expect(view.equipment.safetyBlocked[0]!.assetName).toBe("Telehandler");
    expect(view.equipment.safetyBlocked[0]!.blocking).toBe(true);
  });

  it("drops a failure that a linked passing re-inspection has cleared", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        safetyInspections: [
          safety(),
          safety({
            id: "s2",
            outcome: "pass",
            reinspection_of: "s1",
            inspected_at: "2026-07-12T08:00:00.000Z",
          }),
        ],
      }),
    );
    expect(view.equipment.safetyBlocked).toEqual([]);
  });

  it("still shows a bypassed failure, but never calls it cleared", () => {
    const view = composeOperations(
      facts({ assets: [asset()], safetyInspections: [safety()], overrides: [override()] }),
    );
    expect(view.equipment.safetyBlocked).toHaveLength(1);
    expect(view.equipment.safetyBlocked[0]!.blocking).toBe(false);
  });

  it("ignores an override that has expired at the caller's clock", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        safetyInspections: [safety()],
        overrides: [override({ expires_at: "2026-07-27T08:00:00.000Z" })],
      }),
    );
    expect(view.equipment.safetyBlocked[0]!.blocking).toBe(true);
  });

  it("sorts genuinely blocked assets above merely-overridden ones", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "a1" }), asset({ id: "a2" })],
        safetyInspections: [safety({ id: "s1", asset_id: "a1" }), safety({ id: "s2", asset_id: "a2" })],
        overrides: [override({ id: "o1", asset_id: "a1", inspection_id: "s1" })],
      }),
    );
    expect(view.equipment.safetyBlocked.map((a) => a.assetId)).toEqual(["a2", "a1"]);
  });

  it("scopes an override to its own asset — one asset's bypass never clears another's", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "a1" }), asset({ id: "a2" })],
        safetyInspections: [safety({ id: "s1", asset_id: "a1" }), safety({ id: "s2", asset_id: "a2" })],
        overrides: [override({ id: "o1", asset_id: "a1", inspection_id: "s2" })],
      }),
    );
    expect(view.equipment.safetyBlocked.every((a) => a.blocking)).toBe(true);
  });
});

// ── Inspections ──────────────────────────────────────────────────────────────

describe("inspections", () => {
  const view = composeOperations(
    facts({
      assets: [asset({ name: "Tower scaffold" })],
      dueInspections: [
        inspection({ id: "late", due_at: "2026-07-27" }),
        inspection({ id: "today", due_at: TODAY }),
        inspection({ id: "soon", due_at: "2026-08-04" }),
        inspection({ id: "no-date", due_at: null }),
      ],
    }),
  );

  it("uses isInspectionOverdue's boundary — due today is not yet overdue", () => {
    expect(view.inspections.overdue.map((i) => i.inspectionId)).toEqual(["late"]);
    expect(view.inspections.upcoming.map((i) => i.inspectionId)).toEqual(["today", "soon"]);
  });

  it("drops a draft with no due date rather than sorting it arbitrarily", () => {
    const ids = [...view.inspections.overdue, ...view.inspections.upcoming].map(
      (i) => i.inspectionId,
    );
    expect(ids).not.toContain("no-date");
  });

  it("links to the inspection record, which is where it gets completed", () => {
    expect(view.inspections.overdue[0]!.href).toBe("/assets/a1/inspections/late");
  });
});

// ── Custody ──────────────────────────────────────────────────────────────────

describe("custody", () => {
  it("flags only open holdings past their return date, longest overdue first", () => {
    const view = composeOperations(
      facts({
        assets: [asset({ id: "a1", name: "Genny" }), asset({ id: "a2", name: "Whacker" })],
        openCustody: [
          custody({ id: "late-2", asset_id: "a2", expected_return_at: "2026-07-26" }),
          custody({ id: "late-1", asset_id: "a1", expected_return_at: "2026-07-20" }),
          custody({ id: "due-today", expected_return_at: TODAY }),
          custody({ id: "open-ended", expected_return_at: null }),
        ],
      }),
    );
    expect(view.custody.overdue.map((c) => c.assignmentId)).toEqual(["late-1", "late-2"]);
    expect(view.custody.openTotal).toBe(4);
  });

  it("names the holder without leaking a person's identity onto the tile", () => {
    const view = composeOperations(
      facts({
        assets: [asset()],
        openCustody: [
          custody({ id: "s", assignment_type: "issued_to_staff", expected_return_at: "2026-07-01" }),
          custody({
            id: "d",
            assignment_type: "stored_at_depot",
            location: "Aston yard",
            expected_return_at: "2026-07-02",
          }),
        ],
      }),
    );
    const holders = view.custody.overdue.map((c) => c.holderLabel);
    expect(holders).toEqual(["a team member", "Aston yard"]);
  });
});

// ── Estate counts ────────────────────────────────────────────────────────────

describe("the estate at a glance", () => {
  it("excludes disposed assets from the active count and from idle", () => {
    const view = composeOperations(
      facts({
        assets: [
          asset({ id: "a1", status: "active" }),
          asset({ id: "a2", status: "active" }),
          asset({ id: "a3", status: "sold" }),
        ],
        openCustody: [custody({ id: "cu1", asset_id: "a1" })],
      }),
    );
    expect(view.estate.assets).toEqual({ total: 3, active: 2, held: 1, idle: 1 });
  });

  it("takes the vehicle counts from the fleet snapshot rather than recomputing them", () => {
    const counts = { total: 7, inService: 5, offRoad: 1, inWorkshop: 1 };
    const view = composeOperations(facts({ vehicleCounts: counts }));
    expect(view.estate.vehicles).toEqual(counts);
  });
});

// ── Schedule ─────────────────────────────────────────────────────────────────

describe("schedule conflicts", () => {
  it("shows the lib's own high band — which IS today and tomorrow — and counts the rest", () => {
    const view = composeOperations(
      facts({
        conflicts: [
          conflict({ key: "today", severity: "high", daysAway: 0 }),
          conflict({ key: "tomorrow", severity: "high", daysAway: 1 }),
          conflict({ key: "next-week", severity: "medium", daysAway: 5 }),
          conflict({ key: "later", severity: "low", daysAway: 11 }),
        ],
      }),
    );
    expect(view.schedule.imminent.map((c) => c.key)).toEqual(["today", "tomorrow"]);
    expect(view.schedule.total).toBe(4);
  });

  it("preserves the detector's ranking rather than re-sorting", () => {
    const ranked = [
      conflict({ key: "first", score: 3150 }),
      conflict({ key: "second", score: 3100 }),
    ];
    const view = composeOperations(facts({ conflicts: ranked }));
    expect(view.schedule.imminent.map((c) => c.key)).toEqual(["first", "second"]);
  });
});

// ── First run ────────────────────────────────────────────────────────────────

describe("a brand-new org", () => {
  it("is flagged so the page can explain itself instead of showing an empty grid", () => {
    expect(composeOperations(facts()).isNewEstate).toBe(true);
  });

  it("is NOT flagged once anything real exists — including a conflict with no kit", () => {
    expect(composeOperations(facts({ assets: [asset()] })).isNewEstate).toBe(false);
    expect(
      composeOperations(facts({ vehicleCounts: { total: 1, inService: 1, offRoad: 0, inWorkshop: 0 } }))
        .isNewEstate,
    ).toBe(false);
    expect(composeOperations(facts({ conflicts: [conflict()] })).isNewEstate).toBe(false);
  });
});

// ── Purity ───────────────────────────────────────────────────────────────────

describe("purity", () => {
  it("does not mutate its inputs and is repeatable", () => {
    const input = facts({
      assets: [asset({ id: "a2" }), asset({ id: "a1" })],
      openCases: [maintCase({ id: "c2" }), maintCase({ id: "c1" })],
      conflicts: [conflict()],
    });
    const snapshotOfInput = JSON.stringify({
      assets: input.assets,
      openCases: input.openCases,
      conflicts: input.conflicts,
    });
    const a = composeOperations(input);
    const b = composeOperations(input);
    expect(
      JSON.stringify({
        assets: input.assets,
        openCases: input.openCases,
        conflicts: input.conflicts,
      }),
    ).toBe(snapshotOfInput);
    expect(a).toEqual(b);
  });
});
