import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOFILL_FORMS, autofillFormConfig, isAutofillFormType } from "@/lib/imports/autofill/registry";
import { AUTOFILL_FORM_TYPES } from "@/lib/imports/autofill/types";

/**
 * FEATURE 2 — the registry is the single source of truth, and it must agree with
 * the DB CHECK (migration 20261265000000) and with each form's extraction schema.
 * Drift between the code set and the database set is exactly how a form type gets
 * a button with no storable draft (or a storable draft with no button), so it is
 * pinned here.
 */

const ROOT = resolve(__dirname, "..", "..");

describe("autofill registry alignment", () => {
  it("every form type has a config, and the registry is closed", () => {
    for (const t of AUTOFILL_FORM_TYPES) {
      expect(AUTOFILL_FORMS[t].type).toBe(t);
      expect(autofillFormConfig(t)).not.toBeNull();
    }
    expect(autofillFormConfig("not_a_form")).toBeNull();
    expect(isAutofillFormType("customer")).toBe(true);
    expect(isAutofillFormType("nope")).toBe(false);
  });

  it("the form-type set equals the DB CHECK in the drafts migration", () => {
    const sql = readFileSync(
      resolve(ROOT, "supabase/migrations/20261265000000_form_import_drafts.sql"),
      "utf8",
    );
    const m = /form_type\s+text\s+not\s+null\s+check\s*\(\s*form_type\s+in\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
    expect(m, "could not find the form_type CHECK in the migration").not.toBeNull();
    const dbTypes = Array.from((m![1] ?? "").matchAll(/'([a-z_]+)'/g)).map((x) => x[1]).sort();
    expect(dbTypes).toEqual([...AUTOFILL_FORM_TYPES].sort());
  });

  it("each config's field keys equal its schema's keys", () => {
    for (const t of AUTOFILL_FORM_TYPES) {
      const config = AUTOFILL_FORMS[t];
      const fieldKeys = config.fields.map((f) => f.key).sort();
      // Parse an empty object: the schema yields every key (as null), so its
      // output keys ARE the schema's declared fields.
      const schemaKeys = Object.keys(config.schema.parse({})).sort();
      expect(schemaKeys, `schema/field mismatch for ${t}`).toEqual(fieldKeys);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length); // no dupes
    }
  });

  it("every prompt carries the injection-safety rule and the output shape", () => {
    for (const t of AUTOFILL_FORM_TYPES) {
      const p = AUTOFILL_FORMS[t].systemPrompt;
      expect(p, `${t} prompt must name the JSON output shape`).toContain('"fields"');
      expect(p, `${t} prompt must forbid inventing values`).toMatch(/NEVER guess|not guess|never guess/i);
      expect(p, `${t} prompt must treat the document as data`).toMatch(/DATA, not instructions/);
    }
  });

  it("the staff invite prompt explicitly forbids pay/role/emergency extraction", () => {
    const p = AUTOFILL_FORMS.staff_invite.systemPrompt;
    expect(p).toMatch(/pay|salary|rate/i);
    expect(p).toMatch(/emergency/i);
    expect(p).toMatch(/role|permission/i);
  });

  it("each target is a usable route or a window event", () => {
    for (const t of AUTOFILL_FORM_TYPES) {
      const target = AUTOFILL_FORMS[t].target;
      if (target.kind === "route") {
        expect(target.newPath.startsWith("/")).toBe(true);
      } else {
        expect(target.eventName.length).toBeGreaterThan(0);
      }
    }
  });

  it("auth mirrors the create action: customer needs capability, staff is admin-only, the rest are member-open", () => {
    expect(AUTOFILL_FORMS.customer.auth).toEqual({
      mode: "capability",
      module: "customers",
      action: "create",
    });
    expect(AUTOFILL_FORMS.lead.auth).toEqual({
      mode: "capability",
      module: "leads",
      action: "create",
    });
    // variation create = createVariation → requireCapabilityFor(quotes, create).
    expect(AUTOFILL_FORMS.variation.auth).toEqual({
      mode: "capability",
      module: "quotes",
      action: "create",
    });
    expect(AUTOFILL_FORMS.staff_invite.auth).toEqual({ mode: "manageStaff" });
    expect(AUTOFILL_FORMS.site.auth).toEqual({ mode: "orgAdmin" });
    // Coverage-completion wave: warranty + qualification create actions call
    // requireAdmin, so their import mirrors it (owner/admin only).
    expect(AUTOFILL_FORMS.warranty.auth).toEqual({ mode: "orgAdmin" });
    expect(AUTOFILL_FORMS.qualification.auth).toEqual({ mode: "orgAdmin" });
    for (const t of [
      "supplier",
      "job",
      "risk_assessment",
      "permit",
      "toolbox_talk",
      "snag",
      "diary",
      "compliance_document",
      "itp",
      "stock_item",
      "vehicle",
      "asset",
      "delay",
      "site_report",
      "material_request",
    ] as const) {
      expect(AUTOFILL_FORMS[t].auth).toEqual({ mode: "member" });
    }
  });

  it("a line-item form's lineItem columns parse from its lineItem schema, and never carry money", () => {
    const config = AUTOFILL_FORMS.material_request;
    expect(config.lineItem, "material_request must declare a lineItem").toBeTruthy();
    // The row schema yields exactly the columns the review table renders.
    const sampleRow = { description: "Cement 25kg", qty: "10", unit: "bag" };
    const parsed = config.lineItem!.schema.parse([sampleRow]) as Record<string, string>[];
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual(
      config.lineItem!.fields.map((f) => f.key).sort(),
    );
    // A request carries no cost — no price column may leak in.
    expect(config.lineItem!.fields.map((f) => f.key)).not.toContain("unit_price");
    // Invented/empty rows are dropped, never fabricated.
    expect(config.lineItem!.schema.parse([{ qty: "5" }])).toEqual([]);
    expect(config.lineItem!.schema.parse("not an array")).toEqual([]);
  });
});
