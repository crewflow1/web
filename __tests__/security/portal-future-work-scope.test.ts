import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildFutureWorkNotes,
  buildPortalFutureWorkView,
  futureWorkRequestSchema,
  FUTURE_WORK_PORTAL_KEYS,
  timingToUrgency,
  toPortalRequestStage,
} from "@/lib/leads/portal";
import { LEAD_SOURCES } from "@/lib/leads/schema";

/**
 * Customer-portal future-work requests — identity stamping, read-back scoping,
 * and the coarse-stage projection.
 *
 * The request becomes a row in the EXISTING leads table. Two invariants make
 * that safe on a token-only auth surface:
 *
 *   • WRITE: every identity-bearing field (org_id, customer_id, contact_*) is
 *     stamped from the token-resolved customer record — the form contributes
 *     title/details/timing ONLY, so a crafted field cannot plant a phishing
 *     callback number or file a lead into another org;
 *   • READ-BACK: leads carries org_id AND customer_id, so the acknowledgement
 *     list filters on both PLUS source='portal', and rows exit through a
 *     projection that has no field where staff notes, values, assignment or
 *     the raw pipeline status could sit.
 */

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const read = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ACTION = read("app/customer-portal/_future-work-action.ts");
const LOADER = read("app/customer-portal/_future-work.ts");
const PAGE = read("app/customer-portal/[token]/requests/page.tsx");

describe("input validation is bounded", () => {
  it("accepts a well-formed request", () => {
    expect(
      futureWorkRequestSchema.safeParse({
        title: "Rewire the garage",
        details: "Full rewire of the detached garage, two circuits.",
        timing: "1_3_months",
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-bounds and malformed input", () => {
    const base = {
      title: "Rewire",
      details: "Long enough details here.",
      timing: "flexible",
    };
    expect(futureWorkRequestSchema.safeParse({ ...base, title: "ab" }).success).toBe(false);
    expect(futureWorkRequestSchema.safeParse({ ...base, title: "x".repeat(201) }).success).toBe(false);
    expect(futureWorkRequestSchema.safeParse({ ...base, details: "too short" }).success).toBe(false);
    expect(futureWorkRequestSchema.safeParse({ ...base, details: "x".repeat(5001) }).success).toBe(false);
    expect(futureWorkRequestSchema.safeParse({ ...base, timing: "yesterday" }).success).toBe(false);
    expect(futureWorkRequestSchema.safeParse({ ...base, timing: "id.eq.x" }).success).toBe(false);
  });

  it("only ASAP maps to a raised urgency", () => {
    expect(timingToUrgency("asap")).toBe("high");
    for (const t of ["within_1_month", "1_3_months", "3_6_months", "flexible"] as const) {
      expect(timingToUrgency(t)).toBe("normal");
    }
  });

  it("the notes body carries provenance + timing + details", () => {
    const notes = buildFutureWorkNotes({
      title: "t",
      details: "New patio doors",
      timing: "asap",
    });
    expect(notes).toContain("customer portal");
    expect(notes).toContain("As soon as possible");
    expect(notes).toContain("New patio doors");
  });
});

describe("the write stamps identity from the token-resolved customer only", () => {
  it("org_id, customer_id and every contact field come from the customer record", () => {
    expect(ACTION).toMatch(/org_id: customer\.org_id/);
    expect(ACTION).toMatch(/customer_id: customer\.id/);
    expect(ACTION).toMatch(/contact_name: customer\.name/);
    expect(ACTION).toMatch(/contact_email: customer\.email/);
    expect(ACTION).toMatch(/contact_phone: customer\.phone/);
    expect(ACTION).toMatch(/source: "portal"/);
  });

  it("the form is never consulted for identity", () => {
    for (const field of ["customer_id", "org_id", "contact_name", "contact_email", "contact_phone", "source", "status", "urgency"]) {
      expect(ACTION, `formData.get("${field}") must not exist`).not.toContain(
        `formData.get("${field}")`,
      );
    }
  });

  it("resolves the token through the single auth chokepoint before writing", () => {
    expect(ACTION).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(ACTION.indexOf("loadCustomerByPortalToken")).toBeLessThan(
      ACTION.indexOf('.insert({'),
    );
  });

  it("is rate-limited on the shared portal_write budget", () => {
    expect(ACTION).toMatch(
      /consume\("portal_write", token, DEFAULT_LIMITS\.portal_write\)/,
    );
  });

  it("'portal' is a recognised lead source, so the staff pipeline can filter it", () => {
    expect(LEAD_SOURCES).toContain("portal");
  });
});

describe("the read-back is provably customer-scoped and projection-limited", () => {
  it("filters on org_id AND customer_id AND source", () => {
    expect(LOADER).toMatch(
      /\.eq\("org_id", orgId\)\s*\n?\s*\.eq\("customer_id", customerId\)\s*\n?\s*\.eq\("source", "portal"\)/,
    );
  });

  it("selects only the projected columns — staff fields are never read", () => {
    expect(LOADER).toMatch(/select\("id, service, status, created_at"\)/);
    for (const internal of ["notes", "ai_summary", "estimated_value", "assigned_to", "preferred_callback_at"]) {
      expect(LOADER, `must not read leads.${internal}`).not.toContain(internal);
    }
  });

  it("fails loud rather than rendering an empty list over a failed read", () => {
    expect(LOADER).toMatch(/throw readFailure\("portal future-work: requests", error\)/);
  });

  it("rows exit through the projection only", () => {
    expect(LOADER).toMatch(/buildPortalFutureWorkView\(row\)/);
    expect(LOADER).not.toMatch(/\.\.\.row/);
  });
});

describe("the coarse stage word — pipeline internals never round-trip", () => {
  const view = buildPortalFutureWorkView({
    id: "l1",
    service: "New patio",
    status: "lost",
    created_at: "2026-07-30T12:00:00.000Z",
    // The whole-row shape a spread or select("*") would produce.
    notes: "SENTINEL-STAFF-NOTES",
    ai_summary: "SENTINEL-AI-SUMMARY",
    estimated_value: 123456,
    assigned_to: "SENTINEL-STAFF-UUID",
    org_id: "SENTINEL-ORG-UUID",
  } as Parameters<typeof buildPortalFutureWorkView>[0]);

  it("has exactly the declared key set", () => {
    expect(Object.keys(view).sort()).toEqual([...FUTURE_WORK_PORTAL_KEYS].sort());
  });

  it("a customer never reads 'lost' about themselves — nor any raw status", () => {
    expect(view.stage).toBe("closed");
    expect(JSON.stringify(view)).not.toContain("lost");
    expect(toPortalRequestStage("SENTINEL-INTERNAL-STAGE")).toBe("received");
  });

  it("sentinel staff fields never serialise", () => {
    const json = JSON.stringify(view);
    for (const v of ["SENTINEL-STAFF-NOTES", "SENTINEL-AI-SUMMARY", "123456", "SENTINEL-STAFF-UUID", "SENTINEL-ORG-UUID"]) {
      expect(json).not.toContain(v);
    }
  });
});

describe("the page surface", () => {
  it("loads through the chokepoint and lists by the token-resolved pair", () => {
    expect(PAGE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(PAGE).toMatch(
      /listPortalFutureWorkRequests\(\s*customer\.id,\s*customer\.org_id,?\s*\)/,
    );
    expect(PAGE).toMatch(/InvalidLinkPage kind="portal"/);
  });

  it("renders stage labels from the projection, never a raw status", () => {
    expect(PAGE).toMatch(/PORTAL_REQUEST_STAGE_LABELS\[r\.stage\]/);
    expect(PAGE).not.toMatch(/\br\.status\b/);
  });
});
