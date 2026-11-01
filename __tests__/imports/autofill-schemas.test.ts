import { describe, it, expect } from "vitest";
import {
  customerExtractionSchema,
  supplierExtractionSchema,
  jobExtractionSchema,
  riskAssessmentExtractionSchema,
  staffInviteExtractionSchema,
} from "@/lib/imports/autofill/schemas";

/**
 * FEATURE 2 — the strict extraction schemas.
 *
 * These are the allowlist + the "never invent" guarantee. The tests prove each
 * cleaner nulls a malformed value rather than passing a plausible lie, strips
 * unknown keys (no mass-assignment), and never throws.
 */

describe("customer extraction schema", () => {
  it("keeps well-formed values and normalises them", () => {
    const out = customerExtractionSchema.parse({
      name: "  Acme Roofing Ltd  ",
      email: "INFO@Acme.CO.UK",
      phone: "tel: 028 9024 1234",
      customer_type: "Business",
      company_number: "NI 012345",
      vat_number: "gb 123456789",
      postcode: "bt1 5gs",
      city: "Belfast",
    });
    expect(out.name).toBe("Acme Roofing Ltd");
    expect(out.email).toBe("info@acme.co.uk");
    expect(out.phone).toBe("028 9024 1234");
    expect(out.customer_type).toBe("business");
    expect(out.company_number).toBe("NI012345");
    expect(out.vat_number).toBe("GB123456789");
    expect(out.postcode).toBe("BT1 5GS");
  });

  it("nulls malformed values rather than inventing them", () => {
    const out = customerExtractionSchema.parse({
      name: "   ", // blank → null
      email: "not-an-email",
      vat_number: "12", // too short
      postcode: "ZZ", // not a postcode
      customer_type: "charity", // not in the enum
    });
    expect(out.name).toBeNull();
    expect(out.email).toBeNull();
    expect(out.vat_number).toBeNull();
    expect(out.postcode).toBeNull();
    expect(out.customer_type).toBeNull();
  });

  it("strips unknown keys (no mass-assignment)", () => {
    const out = customerExtractionSchema.parse({
      name: "Acme",
      org_id: "evil",
      id: "evil",
      is_admin: true,
      parent_customer_id: "11111111-1111-1111-1111-111111111111",
    }) as Record<string, unknown>;
    expect(out.name).toBe("Acme");
    expect("org_id" in out).toBe(false);
    expect("id" in out).toBe(false);
    expect("is_admin" in out).toBe(false);
    // parent_customer_id is NOT in the customer extraction schema (relational).
    expect("parent_customer_id" in out).toBe(false);
  });

  it("never throws on bad per-field values (field cleaners catch)", () => {
    // Object-shaped input with hostile per-field values must parse cleanly,
    // nulling each bad field — this is the shape the extractor always passes.
    expect(() => customerExtractionSchema.parse({ name: 42, email: [], postcode: {} })).not.toThrow();
    const out = customerExtractionSchema.parse({ name: 42, email: [], postcode: {} });
    expect(out.name).toBeNull();
    expect(out.email).toBeNull();
    expect(out.postcode).toBeNull();
  });

  it("non-object input is rejected by safeParse, never thrown (the extractor's guard)", () => {
    expect(customerExtractionSchema.safeParse(null).success).toBe(false);
    expect(customerExtractionSchema.safeParse("a string").success).toBe(false);
  });
});

describe("supplier extraction schema", () => {
  it("parses payment terms to a whole-number string", () => {
    expect(supplierExtractionSchema.parse({ payment_terms_days: "net 30 days" }).payment_terms_days).toBe("30");
    expect(supplierExtractionSchema.parse({ payment_terms_days: "999" }).payment_terms_days).toBeNull();
    expect(supplierExtractionSchema.parse({ payment_terms_days: "lots" }).payment_terms_days).toBeNull();
  });
});

describe("job extraction schema", () => {
  it("only carries site-address + notes, never relational ids or schedule", () => {
    const out = jobExtractionSchema.parse({
      site_postcode: "bt1 5gs",
      notes: "Re-roof the rear extension",
      customer_id: "x",
      assigned_to: "x",
      scheduled_date: "2026-01-01",
      status: "in-progress",
    }) as Record<string, unknown>;
    expect(out.site_postcode).toBe("BT1 5GS");
    expect(out.notes).toBe("Re-roof the rear extension");
    for (const forbidden of ["customer_id", "assigned_to", "scheduled_date", "status"]) {
      expect(forbidden in out).toBe(false);
    }
  });
});

describe("risk assessment extraction schema", () => {
  it("parses dates to ISO and drops bad ones", () => {
    const out = riskAssessmentExtractionSchema.parse({
      title: "Working at height",
      assessmentDate: "2026-03-01T09:00:00Z",
      reviewDate: "not a date",
    });
    expect(out.title).toBe("Working at height");
    expect(out.assessmentDate).toBe("2026-03-01");
    expect(out.reviewDate).toBeNull();
  });

  it("does not carry hazards or scores", () => {
    const out = riskAssessmentExtractionSchema.parse({
      title: "T",
      hazards: [{ hazard: "fall", likelihood: 5 }],
      likelihood: 5,
    }) as Record<string, unknown>;
    expect("hazards" in out).toBe(false);
    expect("likelihood" in out).toBe(false);
  });
});

describe("staff invite extraction schema — the field-scoping boundary", () => {
  it("carries ONLY identity fields", () => {
    const keys = Object.keys(staffInviteExtractionSchema.parse({ full_name: "Jane" }));
    expect(keys.sort()).toEqual(["email", "employment_type", "full_name", "phone"]);
  });

  it("NEVER emits pay, emergency contacts, or role — even when the document states them", () => {
    const out = staffInviteExtractionSchema.parse({
      full_name: "Jane Smith",
      email: "jane@x.co.uk",
      hourly_pay: "250",
      role: "owner",
      emergency_contact_name: "John",
      emergency_contact_phone: "07700900000",
      emergency_contact_relationship: "spouse",
    }) as Record<string, unknown>;
    expect(out.full_name).toBe("Jane Smith");
    for (const forbidden of [
      "hourly_pay",
      "role",
      "emergency_contact_name",
      "emergency_contact_phone",
      "emergency_contact_relationship",
    ]) {
      expect(forbidden in out).toBe(false);
    }
  });

  it("validates employment type against the fixed set", () => {
    expect(staffInviteExtractionSchema.parse({ employment_type: "Contractor" }).employment_type).toBe("contractor");
    expect(staffInviteExtractionSchema.parse({ employment_type: "director" }).employment_type).toBeNull();
  });
});
