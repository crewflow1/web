import { describe, it, expect } from "vitest";
import { createLeadSchema, updateLeadSchema } from "@/lib/leads/schema";

/**
 * Lead validation contract — CEO bugfix directive.
 *
 * Required rules (failure must NOT save the lead, must surface inline):
 *   - contact_name is required (non-empty after trim)
 *   - contact_email OR contact_phone is required (at least one)
 *
 * These tests pin the contract at the schema layer so the action can't
 * accidentally bypass it — the action delegates parsing to `validateFormData`
 * which calls the schema directly.
 */

function base() {
  return {
    contact_name: "Sarah Murphy",
    contact_email: "sarah@example.com",
    contact_phone: "",
    source: "phone",
    urgency: "normal",
  };
}

describe("createLeadSchema", () => {
  it("accepts a fully populated lead", () => {
    const r = createLeadSchema.safeParse(base());
    expect(r.success).toBe(true);
  });

  it("rejects an empty contact_name", () => {
    const r = createLeadSchema.safeParse({ ...base(), contact_name: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path[0] === "contact_name")?.message;
      expect(msg).toBeTruthy();
    }
  });

  it("rejects a whitespace-only contact_name", () => {
    const r = createLeadSchema.safeParse({ ...base(), contact_name: "   " });
    expect(r.success).toBe(false);
  });

  it("rejects a lead with neither email nor phone", () => {
    const r = createLeadSchema.safeParse({
      ...base(),
      contact_email: "",
      contact_phone: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(
        (i) => i.path.includes("contact_phone") || i.message.toLowerCase().includes("email or"),
      );
      expect(issue).toBeTruthy();
    }
  });

  it("accepts phone-only contact (no email)", () => {
    const r = createLeadSchema.safeParse({
      ...base(),
      contact_email: "",
      contact_phone: "07700 900222",
    });
    expect(r.success).toBe(true);
  });

  it("accepts email-only contact (no phone)", () => {
    const r = createLeadSchema.safeParse({
      ...base(),
      contact_email: "sarah@example.com",
      contact_phone: "",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed email", () => {
    const r = createLeadSchema.safeParse({
      ...base(),
      contact_email: "not-an-email",
      contact_phone: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path[0] === "contact_email")?.message;
      expect(msg).toBeTruthy();
    }
  });

  it("blank-everything submission cannot save", () => {
    // The canonical "user clicked Save with nothing filled in" case.
    // Must produce a failure with at least one error on contact_name.
    const r = createLeadSchema.safeParse({
      contact_name: "",
      contact_email: "",
      contact_phone: "",
      source: "phone",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const keys = r.error.issues.map((i) => i.path[0]);
      expect(keys).toContain("contact_name");
    }
  });

  it("requires a valid source", () => {
    const r = createLeadSchema.safeParse({
      ...base(),
      source: "carrier-pigeon",
    });
    expect(r.success).toBe(false);
  });
});

describe("updateLeadSchema", () => {
  it("keeps the same contact gating on edit (can't strip name)", () => {
    const r = updateLeadSchema.safeParse({
      ...base(),
      contact_name: "",
    });
    expect(r.success).toBe(false);
  });

  it("keeps the email-or-phone rule on edit", () => {
    const r = updateLeadSchema.safeParse({
      ...base(),
      contact_email: "",
      contact_phone: "",
    });
    expect(r.success).toBe(false);
  });

  it("allows editing service/notes while contact stays valid", () => {
    const r = updateLeadSchema.safeParse({
      ...base(),
      service: "Roof repair",
      notes: "Customer prefers morning calls.",
    });
    expect(r.success).toBe(true);
  });
});
