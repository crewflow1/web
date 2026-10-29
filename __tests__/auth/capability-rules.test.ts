import { describe, it, expect } from "vitest";
import {
  CAP_ACTIONS,
  CAP_MODULES,
  OWNER_WILDCARD,
  grantAllows,
  canWith,
  type Grant,
} from "@/lib/auth/capability-rules";

/**
 * Admin capability rules — the decision logic behind the founder's role model.
 * Pure functions, so this proves the policy exhaustively with no DB.
 */

describe("the taxonomy matches the founder's seven actions", () => {
  it("has exactly View/Create/Edit/Approve/Delete/Export/Manage", () => {
    expect([...CAP_ACTIONS]).toEqual([
      "view",
      "create",
      "edit",
      "approve",
      "delete",
      "export",
      "manage",
    ]);
  });
  it("exposes a non-empty, de-duplicated module list", () => {
    expect(CAP_MODULES.length).toBeGreaterThan(10);
    expect(new Set(CAP_MODULES).size).toBe(CAP_MODULES.length);
  });
});

describe("canWith — owner full, admin granted-only, everyone else none", () => {
  const none: Grant[] = [];

  it("OWNER has every capability regardless of stored grants", () => {
    for (const m of CAP_MODULES) {
      for (const a of CAP_ACTIONS) {
        expect(canWith("owner", none, m, a)).toBe(true);
      }
    }
  });

  it("STAFF has NO management capability, ever", () => {
    expect(canWith("staff", none, "jobs", "view")).toBe(false);
    expect(canWith("staff", [{ module: "jobs", action: "view" }], "jobs", "view")).toBe(false);
    expect(canWith("staff", [OWNER_WILDCARD], "money", "view")).toBe(false);
  });

  it("an unknown/new role fails closed (never silently admitted)", () => {
    expect(canWith("viewer", [OWNER_WILDCARD], "jobs", "view")).toBe(false);
    expect(canWith(null, [OWNER_WILDCARD], "jobs", "view")).toBe(false);
    expect(canWith(undefined, [OWNER_WILDCARD], "jobs", "view")).toBe(false);
  });

  it("ADMIN is DEFAULT-DENY — no grants means no access", () => {
    expect(canWith("admin", none, "jobs", "view")).toBe(false);
    expect(canWith("admin", none, "invoices", "export")).toBe(false);
  });

  it("ADMIN gets exactly the granted (module, action), nothing adjacent", () => {
    const g: Grant[] = [{ module: "jobs", action: "view" }];
    expect(canWith("admin", g, "jobs", "view")).toBe(true);
    expect(canWith("admin", g, "jobs", "edit")).toBe(false); // different action
    expect(canWith("admin", g, "invoices", "view")).toBe(false); // different module
  });

  it("'manage' implies every action on its module, but not other modules", () => {
    const g: Grant[] = [{ module: "jobs", action: "manage" }];
    for (const a of CAP_ACTIONS) expect(canWith("admin", g, "jobs", a)).toBe(true);
    expect(canWith("admin", g, "invoices", "view")).toBe(false);
  });

  it("a module '*' grant covers every module for that action", () => {
    expect(canWith("admin", [{ module: "*", action: "export" }], "reports", "export")).toBe(true);
    expect(canWith("admin", [{ module: "*", action: "export" }], "reports", "delete")).toBe(false);
  });

  it("the owner wildcard grants everything to an admin who holds it (backfill)", () => {
    for (const m of ["jobs", "money", "settings"]) {
      for (const a of CAP_ACTIONS) {
        expect(canWith("admin", [OWNER_WILDCARD], m, a)).toBe(true);
      }
    }
  });
});

describe("grantAllows — the matcher in isolation", () => {
  it("empty set permits nothing", () => {
    expect(grantAllows([], "jobs", "view")).toBe(false);
  });
  it("exact match only, with manage/* broadening", () => {
    expect(grantAllows([{ module: "jobs", action: "view" }], "jobs", "view")).toBe(true);
    expect(grantAllows([{ module: "jobs", action: "view" }], "jobs", "delete")).toBe(false);
    expect(grantAllows([{ module: "jobs", action: "*" }], "jobs", "delete")).toBe(true);
    expect(grantAllows([{ module: "*", action: "*" }], "anything", "approve")).toBe(true);
  });
  it("malformed (empty) grants never match a request", () => {
    expect(grantAllows([{ module: "", action: "view" }], "", "view")).toBe(false);
    expect(grantAllows([{ module: "jobs", action: "" }], "jobs", "view")).toBe(false);
    expect(grantAllows([{ module: "", action: "" }], "", "view")).toBe(false);
  });
});
