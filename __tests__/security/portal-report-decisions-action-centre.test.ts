import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasOutstandingClientDecision,
  buildPortalActionItems,
} from "@/lib/customers/portal-actions";

/**
 * Portal completion R4 — report decisions surface in the overview action centre.
 *
 * buildPortalActionItems already supported a `report_decision` kind, but the
 * overview passed `reports: []`, so a report asking the customer for a decision
 * never nudged them. This wires the customer's own published, decision-bearing
 * reports in — customer + org scoped. Pure predicate/builder tested
 * behaviourally; the read + page wiring pinned on SOURCE.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const REPORTS_READ = read("app/customer-portal/_reports.ts");
const OVERVIEW = read("app/customer-portal/[token]/page.tsx");

// =====================================================================
// The pure predicate
// =====================================================================

describe("hasOutstandingClientDecision", () => {
  it("true only for non-empty, non-whitespace decision text", () => {
    expect(hasOutstandingClientDecision("Please choose tile colour")).toBe(true);
    expect(hasOutstandingClientDecision("")).toBe(false);
    expect(hasOutstandingClientDecision("   \n  ")).toBe(false);
    expect(hasOutstandingClientDecision(null)).toBe(false);
    expect(hasOutstandingClientDecision(undefined)).toBe(false);
  });
});

describe("buildPortalActionItems — surfaces decision reports it is given", () => {
  it("emits a report_decision item deep-linking to the report page", () => {
    const items = buildPortalActionItems({
      token: "tok-1",
      todayIso: "2026-08-15",
      quotes: [],
      invoices: [],
      reports: [{ id: "rep-9", title: "Week 4 progress", decisions_outstanding: true }],
    });
    const decision = items.find((i) => i.kind === "report_decision");
    expect(decision).toBeDefined();
    expect(decision?.href).toBe("/customer-portal/tok-1/reports/rep-9");
    expect(decision?.label).toContain("Week 4 progress");
  });

  it("ignores reports with no outstanding decision", () => {
    const items = buildPortalActionItems({
      token: "tok-1",
      todayIso: "2026-08-15",
      quotes: [],
      invoices: [],
      reports: [{ id: "rep-9", title: "x", decisions_outstanding: false }],
    });
    expect(items.some((i) => i.kind === "report_decision")).toBe(false);
  });
});

// =====================================================================
// The read — customer + org + visibility scoped, current reports only
// =====================================================================

describe("listPortalReportsNeedingDecision — scoped, current, decision-bearing", () => {
  it("filters by BOTH customer_id AND org_id (token-resolved identity)", () => {
    expect(REPORTS_READ).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(REPORTS_READ).toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("only CURRENT (issued, published, not withdrawn) reports", () => {
    expect(REPORTS_READ).toMatch(/\.eq\("status", "issued"\)/);
    expect(REPORTS_READ).toMatch(/\.not\("portal_published_at", "is", null\)/);
    expect(REPORTS_READ).toMatch(/\.is\("portal_withdrawn_at", null\)/);
  });

  it("re-applies portal visibility in code (defence-in-depth)", () => {
    expect(REPORTS_READ).toMatch(/isPortalVisible/);
  });

  it("gates on the shared decision predicate against the FROZEN snapshot", () => {
    expect(REPORTS_READ).toMatch(/hasOutstandingClientDecision/);
    expect(REPORTS_READ).toMatch(/snapshot\?\.content\?\.client_decisions/);
  });

  it("returns only id/title/flag — never snapshot body to the action centre", () => {
    expect(REPORTS_READ).toMatch(
      /\.map\(\(r\) => \(\{ id: r\.id, title: r\.title, decisions_outstanding: true \}\)\)/,
    );
  });
});

describe("overview page — feeds decisions in, scoped to this customer", () => {
  it("no longer passes an empty reports array", () => {
    expect(OVERVIEW).not.toMatch(/reports: \[\]/);
    expect(OVERVIEW).toMatch(/reports: reportDecisions/);
  });

  it("loads decisions via the scoped read, keyed by the resolved customer", () => {
    expect(OVERVIEW).toMatch(
      /listPortalReportsNeedingDecision\(\s*customer\.id,\s*customer\.org_id,?\s*\)/,
    );
  });
});
