import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TYPES,
  ASSIGNMENT_TYPE_LABELS,
  CONDITIONS,
  CONDITION_LABELS,
  checkOutSchema,
  friendlyAssignmentError,
  isAssignableStatus,
  isOverdue,
  returnNeedsAttention,
} from "@/lib/assets/assignment";

describe("assignment constants", () => {
  it("labels every type and condition", () => {
    for (const t of ASSIGNMENT_TYPES) expect(ASSIGNMENT_TYPE_LABELS[t]).toBeTruthy();
    for (const c of CONDITIONS) expect(CONDITION_LABELS[c]).toBeTruthy();
  });
});

describe("eligibility + overdue", () => {
  it("only an active asset is assignable", () => {
    expect(isAssignableStatus("active")).toBe(true);
    for (const s of ["retired", "sold", "lost", "stolen", "written_off"]) {
      expect(isAssignableStatus(s), s).toBe(false);
    }
  });

  it("isOverdue only for open + past-due", () => {
    expect(isOverdue("2026-07-01", "open", "2026-07-10")).toBe(true);
    expect(isOverdue("2026-07-20", "open", "2026-07-10")).toBe(false);
    expect(isOverdue("2026-07-01", "closed", "2026-07-10")).toBe(false);
    expect(isOverdue(null, "open", "2026-07-10")).toBe(false);
  });

  it("returnNeedsAttention on damaged/unsafe/incomplete", () => {
    expect(returnNeedsAttention("damaged")).toBe(true);
    expect(returnNeedsAttention("unsafe")).toBe(true);
    expect(returnNeedsAttention("good")).toBe(false);
    expect(returnNeedsAttention(null)).toBe(false);
  });
});

describe("friendlyAssignmentError", () => {
  it("maps a unique violation to 'already checked out'", () => {
    expect(friendlyAssignmentError("23505", "duplicate key")).toMatch(/already checked out/i);
  });
  it("maps eligibility + org guard violations", () => {
    expect(friendlyAssignmentError("23514", "asset X is retired and cannot be assigned")).toMatch(
      /current state/i,
    );
    expect(friendlyAssignmentError("23514", "job X is not in org Y")).toMatch(/organisation/i);
  });
  it("falls back generically", () => {
    expect(friendlyAssignmentError("XXXXX", "weird")).toMatch(/try again/i);
  });
});

describe("checkOutSchema", () => {
  const uuid = "44444444-4444-4444-4444-444444444444";

  it("requires the destination that matches the assignment type", () => {
    // issued_to_staff needs an assignee
    expect(
      checkOutSchema.safeParse({ asset_id: uuid, assignment_type: "issued_to_staff" }).success,
    ).toBe(false);
    expect(
      checkOutSchema.safeParse({
        asset_id: uuid,
        assignment_type: "issued_to_staff",
        assignee_id: uuid,
      }).success,
    ).toBe(true);
    // allocated_to_job needs a job
    expect(
      checkOutSchema.safeParse({ asset_id: uuid, assignment_type: "allocated_to_job", job_id: uuid })
        .success,
    ).toBe(true);
    // stored_at_depot needs a location
    expect(
      checkOutSchema.safeParse({
        asset_id: uuid,
        assignment_type: "stored_at_depot",
        location: "Main yard",
      }).success,
    ).toBe(true);
    expect(
      checkOutSchema.safeParse({ asset_id: uuid, assignment_type: "stored_at_depot" }).success,
    ).toBe(false);
  });

  it("coerces meter reading and validates condition", () => {
    const parsed = checkOutSchema.parse({
      asset_id: uuid,
      assignment_type: "loaded_on_vehicle",
      vehicle_asset_id: uuid,
      issue_condition: "good",
      issue_meter_reading: "1240.5",
    });
    expect(parsed.issue_meter_reading).toBe(1240.5);
    expect(parsed.issue_condition).toBe("good");
    expect(
      checkOutSchema.safeParse({
        asset_id: uuid,
        assignment_type: "loaded_on_vehicle",
        vehicle_asset_id: uuid,
        issue_condition: "pristine",
      }).success,
    ).toBe(false);
  });
});
