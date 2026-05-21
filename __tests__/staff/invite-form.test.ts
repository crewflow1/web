import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inviteStaffSchema } from "@/lib/staff/schema";

/**
 * CEO bugfix — staff section UX.
 *
 * The staff page must show a prominent "+ Add staff" button to admins,
 * NEVER to plain staff. The invite modal must collect every required
 * field: name, email, role, phone, hourly pay, employment type, and
 * the emergency contact triplet.
 *
 * Vitest runs in a Node environment (see vitest.config.ts) — we can't
 * mount React here. Instead we pin the contract three ways:
 *
 *   1. Schema accepts every required field including the new `phone`.
 *   2. The staff page source contains the conditional render
 *      `{isAdmin ? <AddStaffButton ...` — so non-admins never see it.
 *   3. The invite modal source has an input for every required field.
 *
 * Source-level assertions are unusual but the simplest way to guarantee
 * the UI contract without dragging JSDOM + testing-library into the
 * dependency tree just for one button.
 */

const ROOT = resolve(__dirname, "..", "..");
const STAFF_PAGE = readFileSync(
  resolve(ROOT, "app/(app)/staff/page.tsx"),
  "utf8",
);
const INVITE_MODAL = readFileSync(
  resolve(ROOT, "app/(app)/staff/_invite-modal.tsx"),
  "utf8",
);

describe("inviteStaffSchema — accepts every CEO-required field", () => {
  it("accepts the new phone field", () => {
    const r = inviteStaffSchema.safeParse({
      email: "sarah@example.com",
      role: "staff",
      phone: "07700 900222",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe("07700 900222");
  });

  it("treats blank phone as undefined (optional pre-fill)", () => {
    const r = inviteStaffSchema.safeParse({
      email: "sarah@example.com",
      role: "staff",
      phone: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBeUndefined();
  });

  it("rejects an empty role", () => {
    const r = inviteStaffSchema.safeParse({
      email: "sarah@example.com",
      role: "",
    });
    expect(r.success).toBe(false);
  });

  it("happy path covers name / email / role / phone / hourly_pay / employment_type / emergency contact", () => {
    const r = inviteStaffSchema.safeParse({
      full_name: "Sarah Murphy",
      email: "sarah@example.com",
      role: "staff",
      phone: "07700 900222",
      hourly_pay: "18.50",
      employment_type: "employee",
      emergency_contact_name: "Joe Murphy",
      emergency_contact_phone: "07700 900333",
      emergency_contact_relationship: "spouse",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.full_name).toBe("Sarah Murphy");
      expect(r.data.phone).toBe("07700 900222");
      expect(r.data.hourly_pay).toBe(18.5);
      expect(r.data.employment_type).toBe("employee");
      expect(r.data.emergency_contact_name).toBe("Joe Murphy");
    }
  });
});

describe("Staff page — admin-only Add Staff button (page-level role gate)", () => {
  it("renders <AddStaffButton/> only inside an isAdmin conditional", () => {
    // The pattern `{isAdmin ? <AddStaffButton` (with optional whitespace)
    // proves the button is rendered conditionally on isAdmin. Without
    // this gate, staff users would see the button.
    expect(STAFF_PAGE).toMatch(/\{\s*isAdmin\s*\?\s*\(?\s*<AddStaffButton/);
  });

  it("uses a prominent size for the button (size=\"lg\")", () => {
    expect(STAFF_PAGE).toMatch(/<AddStaffButton[^>]*size="lg"/);
  });

  it("attaches the add-staff-button test id for downstream automation", () => {
    expect(STAFF_PAGE).toMatch(/testId="add-staff-button"/);
  });

  it("never renders <AddStaffButton/> unconditionally (staff must not see it)", () => {
    // Matches `<AddStaffButton ...` NOT preceded by `isAdmin ?`.
    // The full file must have exactly ONE AddStaffButton occurrence (the
    // gated one).
    const matches = STAFF_PAGE.match(/<AddStaffButton/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("Invite modal — collects every CEO-required field", () => {
  for (const name of [
    "full_name",
    "email",
    "role",
    "phone",
    "hourly_pay",
    "employment_type",
    "emergency_contact_name",
    "emergency_contact_phone",
    "emergency_contact_relationship",
  ]) {
    it(`has an input named "${name}"`, () => {
      expect(INVITE_MODAL).toMatch(new RegExp(`name="${name}"`));
    });
  }
});
