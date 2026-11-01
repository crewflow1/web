import { describe, it, expect } from "vitest";
import { AUTOFILL_FORMS } from "@/lib/imports/autofill/registry";
import { AUTOFILL_FORM_TYPES } from "@/lib/imports/autofill/types";
import { AI_FEATURES } from "@/lib/ai/governor/registry";

/**
 * FEATURE 2 — trust-boundary proofs for document autofill.
 *
 * The security contract this feature must hold, independent of the UI:
 *   1. The extraction schema is a strict ALLOWLIST — no crafted document can
 *      make a form carry a field the schema does not declare (mass-assignment).
 *   2. Staff autofill NEVER yields pay, emergency contacts, or a role, which are
 *      column-ACL-restricted or privileged. This is the field-level half of
 *      "staff must not extract financial/admin fields they can't see".
 *   3. The AI call is GOVERNED — the feature is registered so spend is metered.
 */

// A deliberately hostile blob: it names every sensitive/privileged key we can
// think of, plus a prototype-pollution probe. A correct schema emits none of it.
const HOSTILE = {
  // privilege / tenancy
  id: "x",
  org_id: "x",
  created_by: "x",
  role: "owner",
  is_admin: true,
  // money / compensation
  hourly_pay: "9999",
  salary: "9999",
  amount: "9999",
  // emergency contact (staff PII)
  emergency_contact_name: "x",
  emergency_contact_phone: "x",
  emergency_contact_relationship: "x",
  // relational ids that must never come from a document
  customer_id: "x",
  assigned_to: "x",
  parent_customer_id: "x",
  // prototype pollution probe
  __proto__: { polluted: true },
  constructor: { evil: true },
};

describe("extraction schemas are a strict allowlist", () => {
  for (const type of AUTOFILL_FORM_TYPES) {
    it(`${type}: a hostile blob yields ONLY declared fields`, () => {
      const config = AUTOFILL_FORMS[type];
      const allowed = new Set(config.fields.map((f) => f.key));
      const out = config.schema.parse(HOSTILE) as Record<string, unknown>;
      for (const key of Object.keys(out)) {
        expect(allowed.has(key), `${type} leaked a key outside its allowlist: ${key}`).toBe(true);
      }
      // And the obviously-sensitive keys never appear — UNLESS a form legitimately
      // declares one as a benign, value-constrained field (customer_contact's
      // "role" is a contact category: billing/site/partner/tenant/other, never a
      // privilege). A declared field is already allowlisted + reviewed; the first
      // loop proves nothing escapes the allowlist, and the staff-specific test
      // below hard-guards that staff_invite declares NO role at all.
      for (const forbidden of ["hourly_pay", "salary", "role", "is_admin", "org_id", "id", "created_by"]) {
        if (allowed.has(forbidden)) continue;
        expect(forbidden in out, `${type} emitted forbidden key ${forbidden}`).toBe(false);
      }
    });
  }

  it("customer_contact's role is a benign contact category, never a privilege", () => {
    const parse = (v: unknown) =>
      (AUTOFILL_FORMS.customer_contact.schema.parse({ role: v }) as { role: string | null }).role;
    // A privilege value can never survive — it is not in the oneOf.
    expect(parse("owner")).toBeNull();
    expect(parse("admin")).toBeNull();
    expect(parse("primary")).toBeNull(); // app-set designation, not extractable
    // A real contact category passes.
    expect(parse("billing")).toBe("billing");
    expect(parse("site")).toBe("site");
  });

  it("object prototype is not polluted by parsing a hostile blob", () => {
    AUTOFILL_FORMS.customer.schema.parse(HOSTILE);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("staff autofill field scoping (R5 / column-ACL boundary)", () => {
  it("the staff schema declares only identity fields", () => {
    const keys = AUTOFILL_FORMS.staff_invite.fields.map((f) => f.key).sort();
    expect(keys).toEqual(["email", "employment_type", "full_name", "phone"]);
  });

  it("no pay / emergency-contact / role key exists anywhere in the staff form config", () => {
    const serialized = JSON.stringify({
      fields: AUTOFILL_FORMS.staff_invite.fields,
      // the prompt is allowed to NAME these only to forbid them — check the field keys, not the prose
    });
    for (const banned of ["hourly_pay", "emergency_contact", "salary"]) {
      expect(serialized.includes(banned)).toBe(false);
    }
  });

  it("staff invite is admin-only; customer requires the create capability", () => {
    expect(AUTOFILL_FORMS.staff_invite.auth).toEqual({ mode: "manageStaff" });
    expect(AUTOFILL_FORMS.customer.auth).toEqual({
      mode: "capability",
      module: "customers",
      action: "create",
    });
  });
});

describe("the autofill AI call is governed", () => {
  it("document.form_autofill is a registered classification feature (metered + ceilinged)", () => {
    const def = (AI_FEATURES as Record<string, { taskClass: string; degradesTo: string } | undefined>)[
      "document.form_autofill"
    ];
    expect(def, "document.form_autofill must be in the governor registry").toBeTruthy();
    expect(def!.taskClass).toBe("classification");
    // An honest degraded path is stated (not a reassuring fiction).
    expect(def!.degradesTo.length).toBeGreaterThan(20);
  });
});
