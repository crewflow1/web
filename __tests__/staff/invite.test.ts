import { describe, it, expect } from "vitest";
import { inviteStaffSchema } from "@/lib/staff/schema";

describe("inviteStaffSchema", () => {
  it("accepts a minimal valid invite (email + role)", () => {
    const r = inviteStaffSchema.safeParse({ email: "jane@x.test", role: "staff" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("jane@x.test");
      expect(r.data.role).toBe("staff");
      expect(r.data.full_name).toBeUndefined();
      expect(r.data.hourly_pay).toBeUndefined();
    }
  });

  it("trims + lowercases the email", () => {
    const r = inviteStaffSchema.safeParse({ email: "  JANE@X.TEST ", role: "admin" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("jane@x.test");
  });

  it("rejects an invalid email", () => {
    const r = inviteStaffSchema.safeParse({ email: "nope", role: "staff" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    const r = inviteStaffSchema.safeParse({ email: "x@x.test", role: "manager" });
    expect(r.success).toBe(false);
  });

  it("permits owner at schema level (action layer rejects it)", () => {
    // Schema only enforces shape; the policy ('owner' onboarding-only) is
    // enforced by the inviteStaff server action.
    const r = inviteStaffSchema.safeParse({ email: "x@x.test", role: "owner" });
    expect(r.success).toBe(true);
  });

  it("coerces hourly_pay from string + clamps below 1000", () => {
    const r = inviteStaffSchema.safeParse({
      email: "x@x.test",
      role: "staff",
      hourly_pay: "18.50",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hourly_pay).toBe(18.5);
    const bad = inviteStaffSchema.safeParse({
      email: "x@x.test",
      role: "staff",
      hourly_pay: "9999",
    });
    expect(bad.success).toBe(false);
  });

  it("treats empty employment_type / emergency fields as undefined", () => {
    const r = inviteStaffSchema.safeParse({
      email: "x@x.test",
      role: "staff",
      employment_type: "",
      emergency_contact_name: "  ",
      emergency_contact_phone: "",
      emergency_contact_relationship: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.employment_type).toBeUndefined();
      expect(r.data.emergency_contact_name).toBeUndefined();
    }
  });

  it("accepts a valid employment_type enum", () => {
    const r = inviteStaffSchema.safeParse({
      email: "x@x.test",
      role: "staff",
      employment_type: "apprentice",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.employment_type).toBe("apprentice");
  });

  it("accepts emergency contact triple", () => {
    const r = inviteStaffSchema.safeParse({
      email: "x@x.test",
      role: "staff",
      emergency_contact_name: "Jane Smith",
      emergency_contact_phone: "07700 900 222",
      emergency_contact_relationship: "spouse",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.emergency_contact_name).toBe("Jane Smith");
      expect(r.data.emergency_contact_phone).toBe("07700 900 222");
    }
  });
});
