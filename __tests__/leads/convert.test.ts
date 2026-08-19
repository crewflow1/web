import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideConversion,
  deriveCustomerName,
  buildCustomerFromLead,
  type ConvertibleLead,
} from "@/lib/leads/convert";

/**
 * Lead → customer conversion (W3 CRM finisher).
 *
 * Two tiers:
 *   1. PURE — the idempotency decision + payload derivation, which is where the
 *      "one lead converts to at most one customer" and "never write an empty
 *      name" invariants actually live.
 *   2. SOURCE — the action's org-scoping + concurrency guard, pinned on source
 *      (the RSC/action harness has no Supabase mock), the documented convention
 *      used across __tests__/security.
 */

const lead = (over: Partial<ConvertibleLead> = {}): ConvertibleLead => ({
  id: "lead-1",
  customer_id: null,
  contact_name: "Sarah Murphy",
  contact_email: "sarah@example.com",
  contact_phone: "07700 900222",
  ...over,
});

describe("lead conversion — idempotency decision", () => {
  it("converts a fresh lead with a name", () => {
    const d = decideConversion(lead());
    expect(d).toEqual({ kind: "convert", name: "Sarah Murphy" });
  });

  it("is a NO-OP when the lead is already converted (returns the existing customer)", () => {
    const d = decideConversion(lead({ customer_id: "cust-existing" }));
    expect(d).toEqual({ kind: "already", customerId: "cust-existing" });
  });

  it("prefers the already-converted branch even when contact fields are present", () => {
    // Idempotency must not depend on the contact fields — a linked lead never
    // mints a second customer, whatever else it carries.
    const d = decideConversion(lead({ customer_id: "cust-x", contact_name: "New Name" }));
    expect(d.kind).toBe("already");
  });

  it("refuses a lead with no reachable identity", () => {
    const d = decideConversion(
      lead({ contact_name: "  ", contact_email: "", contact_phone: null }),
    );
    expect(d).toEqual({ kind: "no_contact" });
  });
});

describe("lead conversion — name derivation (customers.name is NOT NULL)", () => {
  it("uses the contact name when present", () => {
    expect(deriveCustomerName(lead())).toBe("Sarah Murphy");
  });
  it("falls back to email, then phone", () => {
    expect(deriveCustomerName(lead({ contact_name: "" }))).toBe("sarah@example.com");
    expect(
      deriveCustomerName(lead({ contact_name: "", contact_email: "" })),
    ).toBe("07700 900222");
  });
  it("returns null when nothing is reachable", () => {
    expect(
      deriveCustomerName(lead({ contact_name: " ", contact_email: "", contact_phone: "" })),
    ).toBeNull();
  });
});

describe("lead conversion — customer payload", () => {
  it("stamps the ACTIVE org and normalises blanks to null", () => {
    const payload = buildCustomerFromLead(
      "org-A",
      "Sarah Murphy",
      lead({ contact_email: "", contact_phone: "  " }),
    );
    expect(payload).toEqual({
      org_id: "org-A",
      name: "Sarah Murphy",
      email: null,
      phone: null,
      country: "United Kingdom",
    });
  });

  it("carries email + phone through when set", () => {
    const payload = buildCustomerFromLead("org-A", "Sarah Murphy", lead());
    expect(payload.email).toBe("sarah@example.com");
    expect(payload.phone).toBe("07700 900222");
    expect(payload.org_id).toBe("org-A");
  });
});

describe("lead conversion — action org-scoping + concurrency (source pins)", () => {
  const SRC = readFileSync(
    resolve(__dirname, "..", "..", "app/(app)/leads/actions.ts"),
    "utf8",
  );

  it("reads the lead ACTIVE-org pinned", () => {
    expect(SRC).toMatch(
      /convertLeadToCustomer[\s\S]*?\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("no-ops on an already-converted lead via decideConversion", () => {
    expect(SRC).toMatch(/decideConversion\(lead\)/);
    expect(SRC).toMatch(/decision\.kind === "already"/);
  });

  it("stamps the new customer with the active org (never a form-supplied org)", () => {
    expect(SRC).toMatch(/buildCustomerFromLead\(ctx\.org\.id,/);
  });

  it("backfills customer_id ONLY while still unconverted (the race guard)", () => {
    expect(SRC).toMatch(/\.is\("customer_id", null\)/);
  });

  it("rolls the orphan customer back when the link finds zero rows", () => {
    expect(SRC).toMatch(/count === 0/);
    expect(SRC).toMatch(/from\("customers"\)\s*\.delete\(\)/);
  });
});
