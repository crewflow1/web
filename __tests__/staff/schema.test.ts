import { describe, it, expect } from "vitest";
import {
  STAFF_ROLES,
  EMPLOYMENT_TYPES,
  LEAVE_TYPES,
  intervalsOverlap,
  findRotaConflicts,
  updateStaffProfileSchema,
  updateStaffRoleSchema,
  rotaEntryFormSchema,
  leaveRequestFormSchema,
} from "@/lib/staff/schema";

describe("role + enum sanity", () => {
  it("STAFF_ROLES exposes owner/admin/staff", () => {
    expect(STAFF_ROLES).toEqual(["owner", "admin", "staff"]);
  });

  it("EMPLOYMENT_TYPES covers the 4 product values", () => {
    expect(EMPLOYMENT_TYPES).toEqual([
      "employee",
      "self_employed",
      "contractor",
      "apprentice",
    ]);
  });

  it("LEAVE_TYPES covers the 4 spec values", () => {
    expect(LEAVE_TYPES).toEqual(["holiday", "sick", "emergency", "unpaid"]);
  });
});

describe("updateStaffProfileSchema", () => {
  it("coerces hourly_pay from form string + clears empty employment_type", () => {
    const r = updateStaffProfileSchema.safeParse({
      full_name: "Alice",
      phone: "07700 900000",
      hourly_pay: "18.50",
      employment_type: "",
      start_date: "",
      emergency_contact_name: "",
      emergency_contact_phone: "",
      emergency_contact_relationship: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hourly_pay).toBe(18.5);
      expect(r.data.employment_type).toBeUndefined();
      expect(r.data.start_date).toBeUndefined();
    }
  });

  it("rejects invalid employment_type", () => {
    const r = updateStaffProfileSchema.safeParse({
      employment_type: "freelance",
    });
    expect(r.success).toBe(false);
  });
});

describe("updateStaffRoleSchema", () => {
  it("accepts owner/admin/staff; rejects anything else", () => {
    expect(updateStaffRoleSchema.safeParse({ role: "admin" }).success).toBe(true);
    expect(updateStaffRoleSchema.safeParse({ role: "staff" }).success).toBe(true);
    expect(updateStaffRoleSchema.safeParse({ role: "owner" }).success).toBe(true);
    expect(updateStaffRoleSchema.safeParse({ role: "member" }).success).toBe(false);
    expect(updateStaffRoleSchema.safeParse({ role: "" }).success).toBe(false);
  });
});

describe("rotaEntryFormSchema", () => {
  it("accepts a valid shift", () => {
    const r = rotaEntryFormSchema.safeParse({
      user_id: "00000000-0000-0000-0000-000000000001",
      starts_at: "2026-05-21T09:00",
      ends_at: "2026-05-21T17:00",
      job_id: "",
      notes: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.job_id).toBeUndefined();
    }
  });

  it("rejects non-uuid user_id", () => {
    expect(
      rotaEntryFormSchema.safeParse({
        user_id: "not-a-uuid",
        starts_at: "2026-05-21T09:00",
        ends_at: "2026-05-21T17:00",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed datetimes", () => {
    expect(
      rotaEntryFormSchema.safeParse({
        user_id: "00000000-0000-0000-0000-000000000001",
        starts_at: "2026-05-21",
        ends_at: "2026-05-21T17:00",
      }).success,
    ).toBe(false);
  });
});

describe("leaveRequestFormSchema", () => {
  it("accepts a valid 3-day holiday", () => {
    const r = leaveRequestFormSchema.safeParse({
      type: "holiday",
      starts_at: "2026-06-01",
      ends_at: "2026-06-03",
      reason: "Annual leave",
    });
    expect(r.success).toBe(true);
  });

  it("rejects end_at before start_at", () => {
    const r = leaveRequestFormSchema.safeParse({
      type: "holiday",
      starts_at: "2026-06-03",
      ends_at: "2026-06-01",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unsupported leave type", () => {
    expect(
      leaveRequestFormSchema.safeParse({
        type: "study",
        starts_at: "2026-06-01",
        ends_at: "2026-06-02",
      }).success,
    ).toBe(false);
  });
});

describe("rota conflict detection", () => {
  const a = { starts_at: "2026-05-21T09:00:00Z", ends_at: "2026-05-21T13:00:00Z" };
  const b = { starts_at: "2026-05-21T12:00:00Z", ends_at: "2026-05-21T17:00:00Z" }; // overlaps a
  const c = { starts_at: "2026-05-21T17:00:00Z", ends_at: "2026-05-21T20:00:00Z" }; // adjacent, no overlap
  const d = { starts_at: "2026-05-21T10:00:00Z", ends_at: "2026-05-21T12:00:00Z" }; // contained in a

  it("intervalsOverlap detects overlaps and ignores adjacent/non-overlapping", () => {
    expect(intervalsOverlap(a, b)).toBe(true);
    expect(intervalsOverlap(a, d)).toBe(true);
    expect(intervalsOverlap(a, c)).toBe(false);
    expect(intervalsOverlap(b, c)).toBe(false);
  });

  it("findRotaConflicts returns indexes of overlapping existing entries", () => {
    expect(findRotaConflicts(a, [b, c, d])).toEqual([0, 2]);
    expect(findRotaConflicts(c, [a, b, d])).toEqual([]);
  });
});
