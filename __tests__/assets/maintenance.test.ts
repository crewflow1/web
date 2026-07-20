import { describe, expect, it } from "vitest";
import {
  assertCaseTransition,
  canTransitionCase,
  caseCostsSchema,
  downtimeHours,
  friendlyMaintenanceError,
  isActiveCase,
  reportCaseSchema,
  type MaintenanceCaseContext,
} from "@/lib/assets/maintenance";

const ctx = (over: Partial<MaintenanceCaseContext> = {}): MaintenanceCaseContext => ({
  reinspectionRequired: false,
  workEvidencePresent: true,
  ...over,
});

describe("maintenance transition matrix", () => {
  it("permits the documented forward paths", () => {
    expect(canTransitionCase("reported", "triaged", ctx())).toBe(true);
    expect(canTransitionCase("reported", "in_progress", ctx())).toBe(true); // fix-on-the-spot
    expect(canTransitionCase("triaged", "awaiting_supplier", ctx())).toBe(true);
    expect(canTransitionCase("awaiting_parts", "in_progress", ctx())).toBe(true);
    expect(canTransitionCase("in_progress", "ready_for_reinspection", ctx())).toBe(true);
    expect(canTransitionCase("ready_for_reinspection", "ready_for_return_to_service", ctx())).toBe(true);
    expect(canTransitionCase("ready_for_return_to_service", "completed", ctx())).toBe(true);
  });

  it("cancelled → reported is the ONLY resurrection (explicit reopen)", () => {
    expect(canTransitionCase("cancelled", "reported", ctx())).toBe(true);
    expect(canTransitionCase("cancelled", "in_progress", ctx())).toBe(false);
    expect(canTransitionCase("completed", "reported", ctx())).toBe(false); // terminal
  });

  it("completing requires work evidence", () => {
    expect(canTransitionCase("in_progress", "completed", ctx({ workEvidencePresent: false }))).toBe(false);
    expect(canTransitionCase("in_progress", "completed", ctx())).toBe(true);
  });

  it("a reinspection-required case can NEVER skip its gate", () => {
    const need = ctx({ reinspectionRequired: true });
    // straight to RTS from work — no
    expect(canTransitionCase("in_progress", "ready_for_return_to_service", need)).toBe(false);
    // straight to completed from work — no
    expect(canTransitionCase("in_progress", "completed", need)).toBe(false);
    // the legal path: work → reinspection → RTS → completed
    expect(canTransitionCase("in_progress", "ready_for_reinspection", need)).toBe(true);
    expect(canTransitionCase("ready_for_reinspection", "ready_for_return_to_service", need)).toBe(true);
    expect(canTransitionCase("ready_for_return_to_service", "completed", need)).toBe(true);
  });

  it("assertCaseTransition throws the house-convention error", () => {
    expect(() => assertCaseTransition("reported", "completed", ctx())).toThrow(
      "invalid_transition:reported->completed",
    );
  });

  it("isActiveCase excludes only the terminals", () => {
    expect(isActiveCase("reported")).toBe(true);
    expect(isActiveCase("awaiting_supplier")).toBe(true);
    expect(isActiveCase("completed")).toBe(false);
    expect(isActiveCase("cancelled")).toBe(false);
  });
});

describe("downtimeHours", () => {
  it("computes whole hours; null when incomplete or inverted", () => {
    expect(downtimeHours("2026-07-19T08:00:00.000Z", "2026-07-19T17:30:00.000Z")).toBe(10);
    expect(downtimeHours(null, "2026-07-19T17:00:00.000Z")).toBeNull();
    expect(downtimeHours("2026-07-19T17:00:00.000Z", "2026-07-19T08:00:00.000Z")).toBeNull();
  });
});

describe("schemas", () => {
  it("reportCaseSchema requires a fault title and coerces flags", () => {
    expect(reportCaseSchema.safeParse({ asset_id: "not-uuid", case_type: "breakdown", title: "x" }).success).toBe(false);
    const parsed = reportCaseSchema.parse({
      asset_id: "11111111-1111-1111-1111-111111111111",
      case_type: "breakdown",
      title: "  Hydraulic hose burst  ",
      out_of_service: "on",
    });
    expect(parsed.title).toBe("Hydraulic hose burst");
    expect(parsed.out_of_service).toBe(true);
    expect(parsed.priority).toBe("medium");
  });

  it("caseCostsSchema refuses negatives", () => {
    expect(
      caseCostsSchema.safeParse({ case_id: "11111111-1111-1111-1111-111111111111", cost_parts: -5 }).success,
    ).toBe(false);
  });
});

describe("friendlyMaintenanceError", () => {
  it("maps each DB invariant to construction language", () => {
    expect(friendlyMaintenanceError("23514", "case x requires work evidence")).toMatch(/what work was done/i);
    expect(friendlyMaintenanceError("23514", "a cancelled maintenance case requires a reason")).toMatch(/reason/i);
    expect(friendlyMaintenanceError("23514", "case x has an unresolved safety block and cannot return to service")).toMatch(/re-inspection/i);
    expect(friendlyMaintenanceError("23514", "a completed maintenance case is frozen")).toMatch(/can't be changed/i);
    expect(friendlyMaintenanceError("XXXXX", "weird")).toMatch(/try again/i);
  });
});
