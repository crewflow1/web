import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  staffCustomerContactSchema,
  customerContactSchema,
} from "@/lib/customers/contacts";

/**
 * Staff-side customer_contacts CRUD (W3 CRM finisher).
 *
 * Tier 1 — the shared validation contract (reachable-person rule, staff-only
 * notes). Tier 2 — the action's tenant isolation, pinned on source (RSC/action
 * harness, no Supabase mock) per the __tests__/security convention.
 */

const base = {
  name: "Priya Shah",
  email: "priya@example.com",
  phone: "",
  role: "site",
};

describe("staffCustomerContactSchema — the contact validation contract", () => {
  it("accepts a valid staff contact with notes", () => {
    const r = staffCustomerContactSchema.safeParse({
      ...base,
      notes: "Facilities manager — call before 4pm.",
    });
    expect(r.success).toBe(true);
  });

  it("requires a name of at least 2 characters", () => {
    const r = staffCustomerContactSchema.safeParse({ ...base, name: "A" });
    expect(r.success).toBe(false);
  });

  it("requires at least one of email or phone", () => {
    const r = staffCustomerContactSchema.safeParse({
      ...base,
      email: "",
      phone: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /email or a phone/i.test(i.message))).toBe(true);
    }
  });

  it("accepts phone-only (no email)", () => {
    const r = staffCustomerContactSchema.safeParse({
      ...base,
      email: "",
      phone: "07700 900123",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown role (no mass-assignment past the vocabulary)", () => {
    const r = staffCustomerContactSchema.safeParse({ ...base, role: "admin" });
    expect(r.success).toBe(false);
  });

  it("defaults role to 'other' when omitted", () => {
    const r = staffCustomerContactSchema.safeParse({
      name: "Sam",
      email: "sam@example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBe("other");
  });

  it("the PORTAL schema has NO notes field (staff-only note stays server-side)", () => {
    const r = customerContactSchema.safeParse({
      ...base,
      notes: "should be ignored by the portal schema",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).notes).toBeUndefined();
    }
  });
});

describe("customer contacts staff actions — tenant isolation (source pins)", () => {
  const SRC = readFileSync(
    resolve(__dirname, "..", "..", "app/(app)/customers/_contact-actions.ts"),
    "utf8",
  );

  it("every by-id write is ACTIVE-org pinned", () => {
    // Add verifies the customer is in the org; update/delete/set-primary pin the
    // row's org. No write may address a row by id alone.
    const orgPins = SRC.match(/\.eq\("org_id", ctx\.org\.id\)/g) ?? [];
    expect(orgPins.length).toBeGreaterThanOrEqual(4);
  });

  it("stamps org_id + customer_id from context, never trusts them from the form", () => {
    expect(SRC).toMatch(/org_id: ctx\.org\.id/);
    expect(SRC).toMatch(/customer_id: customerId/);
    // The customer itself must be confirmed in the active org before attaching.
    expect(SRC).toMatch(/customerInOrg\(supabase, ctx\.org\.id, customerId\)/);
  });

  it("uses count === 0 to turn an RLS/foreign miss into a friendly refusal", () => {
    expect(SRC).toMatch(/count === 0/);
  });

  it("never mints a portal credential from the staff CRUD", () => {
    expect(SRC).toMatch(/portal_access_enabled: false/);
    expect(SRC).toMatch(/portal_token: null/);
  });

  it("set-primary keeps exactly one primary (demote others, org+customer pinned)", () => {
    expect(SRC).toMatch(/\.eq\("role", "primary"\)\s*\.neq\("id", contactId\)/);
    expect(SRC).toMatch(/\.update\(\{ role: "primary" \}/);
  });
});
