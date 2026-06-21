import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 8 — Polish + launch readiness verification.
 *
 * The directive's 9 steps map to:
 *   1-5 (loading/empty/error/mobile/copy)  — incrementally polished
 *        across prior phases; pinned by per-phase tests
 *   6   (speed)                            — pagination/limits already
 *        in place across list pages
 *   7   (launch checklist page)            — NEW in this phase
 *   8   (full lifecycle test)              — re-uses scripts/e2e-lifecycle.sql
 *   9   (final report)                     — delivered in PR body
 *
 * This file pins the launch-readiness service shape + the page +
 * the existence of every artefact the readiness service checks.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const exists = (p: string) => existsSync(resolve(ROOT, p));

const READINESS = read("server/services/launch-readiness.ts");
const PAGE = read("app/admin/launch-checklist/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");

// =====================================================================
// 1. Launch readiness service
// =====================================================================

describe("Phase 8 — buildLaunchReadiness service", () => {
  it("aggregates ops + automation health", () => {
    expect(READINESS).toMatch(/buildOpsSnapshot/);
    expect(READINESS).toMatch(/readAutomationHealth/);
  });

  it("returns overall status + rows[]", () => {
    expect(READINESS).toMatch(/overall: ChecklistRowStatus/);
    expect(READINESS).toMatch(/rows: ReadonlyArray<ChecklistRow>/);
  });

  it("overall is red when any row is red", () => {
    expect(READINESS).toMatch(
      /const anyRed = rows\.some\(\(r\) => r\.status === "red"\)/,
    );
  });

  it("required env missing = red row", () => {
    expect(READINESS).toMatch(
      /missingRequired\.length === 0 \? "green" : "red"/,
    );
  });
});

// =====================================================================
// 2. Page is HQ-only
// =====================================================================

describe("Phase 8 — /admin/launch-checklist page", () => {
  it("auth-gates via requireHqPage()", () => {
    expect(PAGE).toMatch(/requireHqPage\(\)/);
  });

  it("renders overall traffic-light + per-row pills", () => {
    expect(PAGE).toMatch(/readiness\.overall/);
    expect(PAGE).toMatch(/STATUS_LABEL\[readiness\.overall\]/);
    expect(PAGE).toMatch(/readiness\.rows\.map/);
  });

  it("HQ_NAV exposes /admin/launch-checklist", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/launch-checklist"/);
  });

  it("references the lifecycle script in the page footer", () => {
    expect(PAGE).toMatch(/scripts\/e2e-lifecycle\.sql/);
  });
});

// =====================================================================
// 3. Every artefact the readiness service checks actually exists
// =====================================================================

describe("Phase 8 — every readiness artefact exists on disk", () => {
  const required = [
    "docs/SECURITY.md",
    "lib/security/rate-limit.ts",
    "scripts/e2e-lifecycle.sql",
    "app/admin/ops/page.tsx",
    "app/admin/automations/page.tsx",
    "app/customer-portal/[token]/jobs/page.tsx",
    "app/customer-portal/[token]/messages/page.tsx",
    "app/(app)/onboarding/setup/page.tsx",
    "app/api/ai/question/route.ts",
  ];
  for (const f of required) {
    it(`${f} exists`, () => {
      expect(exists(f)).toBe(true);
    });
  }
});

// =====================================================================
// 4. HQ_NAV now covers every operator section the directive listed
// =====================================================================

describe("Phase 8 — HQ_NAV completeness", () => {
  const labels = [
    "Overview",
    "Demos CRM",
    "Customers",
    "Onboarding & migration",
    "Billing",
    "Support queue",
    "Notifications",
    "Alerts",
    "Analytics",
    "Impersonation log",
    "Internal notes",
    "Customer health",
    "Ops",
    "Automations",
    "Launch checklist",
    "Settings",
  ];
  for (const label of labels) {
    it(`HQ_NAV includes "${label}"`, () => {
      expect(LAYOUT).toMatch(new RegExp(`label:\\s*"${label}"`));
    });
  }
});

// =====================================================================
// 5. Loading + error shells from Phase 5 sweep still present
// =====================================================================

describe("Phase 8 — Polish: loading + error shells live where they should", () => {
  it("/admin/loading.tsx exists (no blank screen on cold instance)", () => {
    expect(exists("app/admin/loading.tsx")).toBe(true);
  });
  it("/admin/error.tsx exists (no fall-through to unstyled root)", () => {
    expect(exists("app/admin/error.tsx")).toBe(true);
  });
  it("/(app)/error.tsx exists (tenant boundary)", () => {
    expect(exists("app/(app)/error.tsx")).toBe(true);
  });
});
