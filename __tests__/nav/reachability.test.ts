import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PRIMARY_NAV,
  UTILITY_NAV,
  navForRole,
  utilityForRole,
  activeAreaId,
  allNavHrefs,
} from "@/app/(app)/_nav/nav-model";
import { buildCommands } from "@/app/(app)/_nav/commands";

/**
 * Rule #1 — nothing gets lost. Machine-assisted reachability audit for the
 * product UX rebuild: every authorised major capability must have a home in the
 * shared nav model (which the sidebar, mobile nav and command palette all read),
 * OR be an intentional orphan, OR be a sub-route reachable through a parent that
 * is in the model.
 */

const ROOT = resolve(__dirname, "../..");

// Capabilities that intentionally have no nav home (see reachability-current.md).
const INTENTIONAL_ORPHANS = ["/marketplace", "/qa", "/a/"];

// Every primary/child destination the model exposes to anyone.
const HREFS = new Set(allNavHrefs());

describe("nav model shape", () => {
  it("exposes the eight primary areas + demoted utility", () => {
    const ids = PRIMARY_NAV.map((a) => a.id);
    expect(ids).toEqual([
      "home",
      "myday",
      "sales",
      "projects",
      "site-safety",
      "people",
      "money",
      "operations",
      "inbox",
    ]);
    expect(UTILITY_NAV.map((a) => a.id)).toEqual(["settings", "help"]);
  });

  it("no primary area is a giant flat list (progressive disclosure holds)", () => {
    for (const area of PRIMARY_NAV) {
      expect(area.children.length, area.id).toBeLessThanOrEqual(13);
    }
  });
});

describe("every major capability has a nav home", () => {
  // The capabilities that MUST be reachable from the shell (drawn from the
  // current inventory of 109). Sub-features (e.g. /stock/valuation) are reached
  // via their parent, which is what this list asserts is present.
  const MUST_REACH = [
    // Sales
    "/leads", "/quotes", "/customers", "/price-book", "/reviews",
    // Projects
    "/jobs", "/jobs/calendar", "/jobs/templates",
    // Site & safety
    "/health-safety", "/health-safety/permits", "/toolbox", "/diary", "/snags",
    "/quality", "/delays", "/site-reports", "/blueprints", "/documents",
    "/site-compliance", "/compliance", "/weather",
    // People
    "/staff", "/staff/rota", "/staff/leave", "/payroll", "/me",
    // Money
    "/cash", "/invoices", "/payments", "/expenses", "/finances", "/cis", "/tax",
    "/reports", "/insights",
    // Operations
    "/operations", "/assets", "/fleet", "/stock", "/materials/requests", "/sites",
    "/suppliers", "/purchase-orders",
    // Inbox + utility
    "/inbox", "/settings", "/help", "/support", "/imports",
    // Home
    "/dashboard",
  ];

  for (const href of MUST_REACH) {
    it(`${href} is in the nav model`, () => {
      expect(HREFS.has(href), `${href} has no nav home`).toBe(true);
    });
  }

  it("declares zero unintended orphans among the must-reach set", () => {
    const missing = MUST_REACH.filter(
      (h) => !HREFS.has(h) && !INTENTIONAL_ORPHANS.some((o) => h.startsWith(o)),
    );
    expect(missing).toEqual([]);
  });
});

describe("previously-orphaned surfaces are now reachable", () => {
  it("job valuations is a command-palette destination inside a job", () => {
    const cmds = buildCommands("owner", "/jobs/abc123");
    expect(cmds.some((c) => c.href === "/jobs/abc123/valuations")).toBe(true);
  });

  it("job valuations is a tab in the job workspace tab bar", () => {
    const tabs = readFileSync(
      join(ROOT, "app", "(app)", "jobs", "[id]", "_job-tabs.tsx"),
      "utf8",
    );
    expect(tabs).toMatch(/sub:\s*"\/valuations"/);
  });

  it("staff timesheet is linked from the staff member page", () => {
    const page = readFileSync(
      join(ROOT, "app", "(app)", "staff", "[id]", "page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/\/staff\/\$\{id\}\/timesheet/);
  });
});

describe("role-aware visibility", () => {
  it("staff see field areas, not the back-office money area", () => {
    const staff = navForRole("staff").map((a) => a.id);
    expect(staff).toContain("projects");
    expect(staff).toContain("site-safety");
    expect(staff).toContain("people");
    expect(staff).toContain("myday");
    expect(staff).not.toContain("money");
    expect(staff).not.toContain("sales");
    expect(staff).not.toContain("home"); // staff home is "My day"
  });

  it("owners/admins see every primary area", () => {
    const owner = navForRole("owner").map((a) => a.id);
    for (const id of ["home", "sales", "projects", "site-safety", "people", "money", "operations", "inbox"]) {
      expect(owner, id).toContain(id);
    }
    expect(owner).not.toContain("myday"); // that entry is staff-only
  });

  it("staff Money commands are suppressed (role-filtered actions)", () => {
    const staffCmds = buildCommands("staff", "/dashboard").map((c) => c.href);
    // A staff user gets no "Create invoice" action (admin-only).
    expect(staffCmds).not.toContain("/invoices/new");
    // …but does get "New job".
    expect(staffCmds).toContain("/jobs/new");
  });

  it("utility (settings/help) is visible to all roles", () => {
    expect(utilityForRole("staff").map((a) => a.id)).toEqual(["settings", "help"]);
  });
});

describe("active-area detection", () => {
  const cases: [string, string][] = [
    ["/dashboard", "home"],
    ["/jobs", "projects"],
    ["/jobs/abc/valuations", "projects"],
    ["/staff/rota", "people"],
    ["/health-safety/permits/new", "site-safety"],
    ["/cash", "money"],
    ["/stock/items", "operations"],
    ["/inbox/conversations", "inbox"],
  ];
  for (const [path, id] of cases) {
    it(`${path} → ${id}`, () => {
      expect(activeAreaId(path)).toBe(id);
    });
  }
});

describe("no orphaned page.tsx routes outside the intentional set", () => {
  // Walk the app/(app) route tree; every top-level segment should either be in
  // the nav model, be an intentional orphan, or be a sub-route of a modelled
  // parent. Guards against a whole new top-level capability shipping unlinked.
  it("every top-level (app) route segment is modelled or intentional", () => {
    const appDir = join(ROOT, "app", "(app)");
    const segments = readdirSync(appDir).filter((e) => {
      const full = join(appDir, e);
      return (
        statSync(full).isDirectory() &&
        !e.startsWith("_") &&
        e !== "layout.tsx"
      );
    });
    const modelledTop = new Set(
      [...HREFS].map((h) => "/" + h.split("/")[1]),
    );
    const intentional = new Set(["marketplace", "qa", "a", "onboarding", "activity", "notifications", "materials"]);
    const orphans = segments.filter((s) => {
      const top = "/" + s;
      return !modelledTop.has(top) && !intentional.has(s);
    });
    expect(orphans, `unmodelled top-level segments: ${orphans.join(", ")}`).toEqual([]);
  });
});
