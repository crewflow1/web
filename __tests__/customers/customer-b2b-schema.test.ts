import { describe, it, expect } from "vitest";
import {
  customerFormSchema,
  CUSTOMER_TYPES,
} from "@/lib/customers/schema";

/**
 * B2B customer classification + firmographics + parent grouping
 * (migration 20261151000000). These lock the write-boundary validation:
 * customer_type is a closed set defaulting to 'individual', company/VAT numbers
 * are format-checked, and parent_customer_id is a UUID-or-nothing — so a crafted
 * payload can't smuggle an unknown type or a malformed parent past the form
 * (no mass-assignment).
 */

const base = { name: "Acme Ltd" };

function parse(extra: Record<string, unknown>) {
  return customerFormSchema.safeParse({ ...base, ...extra });
}

describe("customer_type", () => {
  it("defaults to 'individual' when omitted (legacy rows stay valid)", () => {
    const r = parse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer_type).toBe("individual");
  });

  it("accepts both known types", () => {
    for (const t of CUSTOMER_TYPES) {
      const r = parse({ customer_type: t });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.customer_type).toBe(t);
    }
  });

  it("rejects an unknown type rather than writing it", () => {
    expect(parse({ customer_type: "enterprise" }).success).toBe(false);
    expect(parse({ customer_type: "BUSINESS" }).success).toBe(false);
  });

  it("exposes exactly the two DB-CHECK values", () => {
    expect([...CUSTOMER_TYPES]).toEqual(["individual", "business"]);
  });
});

describe("vat_number", () => {
  it("accepts 9 and 12 digit forms, with optional GB prefix", () => {
    for (const v of ["123456789", "GB123456789", "123456789012", "GB123456789012"]) {
      expect(parse({ vat_number: v }).success).toBe(true);
    }
  });

  it("treats empty string as absent (undefined)", () => {
    const r = parse({ vat_number: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.vat_number).toBeUndefined();
  });

  it("rejects malformed VAT numbers", () => {
    for (const v of ["12345", "GBAB1234567", "12-345-6789", "12345678"]) {
      expect(parse({ vat_number: v }).success).toBe(false);
    }
  });
});

describe("company_number", () => {
  it("accepts alphanumeric UK forms (incl. SC/NI prefixes)", () => {
    for (const c of ["12345678", "SC123456", "NI012345", "OC301763"]) {
      expect(parse({ company_number: c }).success).toBe(true);
    }
  });

  it("rejects punctuation and over-length values", () => {
    expect(parse({ company_number: "12/345678" }).success).toBe(false);
    expect(parse({ company_number: "x".repeat(21) }).success).toBe(false);
  });

  it("treats empty string as absent", () => {
    const r = parse({ company_number: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.company_number).toBeUndefined();
  });
});

describe("parent_customer_id", () => {
  it("accepts a UUID", () => {
    const r = parse({ parent_customer_id: "11111111-1111-4111-8111-111111111111" });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.parent_customer_id).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
  });

  it("treats empty string as 'no parent' (undefined)", () => {
    const r = parse({ parent_customer_id: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.parent_customer_id).toBeUndefined();
  });

  it("rejects a non-UUID so a garbage parent never reaches the DB", () => {
    expect(parse({ parent_customer_id: "not-a-uuid" }).success).toBe(false);
    expect(parse({ parent_customer_id: "123" }).success).toBe(false);
  });
});

describe("backward compatibility", () => {
  it("a bare {name} (the pre-B2B payload) still validates", () => {
    const r = parse({});
    expect(r.success).toBe(true);
  });
});
