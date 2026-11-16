import { describe, it, expect } from "vitest";
import {
  canWith,
  FIELD_MODULES,
  FIELD_PARENT,
  isFieldModule,
  type CapAction,
} from "@/lib/auth/capability-rules";

/**
 * D-17 — the staff FIELD capability baseline. Pure decision logic; the database
 * mirror (public.has_org_capability, migration 20261346) is proved by the
 * integration suite adversarial/staff-field-operations.
 */
const ALL: CapAction[] = ["view", "create", "edit", "approve", "delete", "export", "manage"];

describe("field capability baseline (D-17)", () => {
  it.each(FIELD_MODULES)("%s: staff and admin hold view/create/edit, nothing else", (m) => {
    for (const role of ["staff", "admin"]) {
      for (const a of ALL) {
        expect(canWith(role, [], m, a)).toBe(["view", "create", "edit"].includes(a));
      }
    }
  });

  it("the owner holds everything", () => {
    for (const m of FIELD_MODULES) for (const a of ALL) expect(canWith("owner", [], m, a)).toBe(true);
  });

  it("the baseline never reaches a parent / money module", () => {
    for (const role of ["staff", "admin"]) {
      for (const m of ["stock", "assets", "fleet", "purchase_orders", "expenses", "site_safety",
        "payroll", "settings", "reports", "cash", "invoices", "suppliers", "integrations", "staff"]) {
        for (const a of ALL) expect(canWith(role, [], m, a)).toBe(false);
      }
    }
  });

  it("a parent-module grant held by an ADMIN (not the baseline) confers approve / manage on a field module", () => {
    expect(canWith("admin", [], "stock_field", "approve")).toBe(false);
    expect(canWith("admin", [{ module: "stock", action: "approve" }], "stock_field", "approve")).toBe(true);
    expect(canWith("admin", [{ module: "stock", action: "manage" }], "stock_field", "delete")).toBe(true);
    // ...and a field grant never leaks upward.
    expect(canWith("admin", [{ module: "stock_field", action: "manage" }], "stock", "view")).toBe(false);
  });

  it("a STAFF member never holds more than the baseline — stray grant rows are ignored", () => {
    const stray = [{ module: "*", action: "*" }, { module: "stock", action: "manage" }, { module: "jobs", action: "create" }];
    expect(canWith("staff", stray, "stock_field", "approve")).toBe(false);
    expect(canWith("staff", stray, "stock_field", "delete")).toBe(false);
    expect(canWith("staff", stray, "jobs", "create")).toBe(false);
    expect(canWith("staff", stray, "stock", "view")).toBe(false);
    expect(canWith("staff", stray, "stock_field", "create")).toBe(true);
  });

  it("other roles hold nothing, even with grants", () => {
    for (const role of ["viewer", "portal", "", null, undefined]) {
      expect(canWith(role as string, [{ module: "*", action: "*" }], "stock_field", "view")).toBe(false);
    }
  });

  it("every field module has a parent and is recognised", () => {
    for (const m of FIELD_MODULES) {
      expect(isFieldModule(m)).toBe(true);
      expect(FIELD_PARENT[m]).toBeTruthy();
    }
    expect(isFieldModule("stock")).toBe(false);
  });
});
