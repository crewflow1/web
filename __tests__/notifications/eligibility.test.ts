import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_NOTIFICATION_CATEGORIES,
  coerceAudienceScope,
  memberEligibleForNotification,
  staffEligibleForOrgWideNotification,
} from "@/lib/notifications/eligibility";
import type { NotificationCategory } from "@/lib/notifications/types";

/**
 * FEATURE 3 — the pure staff-privacy eligibility rule. This is the single source
 * of truth shared by RLS (read) and the push / SMS / email-digest fan-outs
 * (delivery). The integration-RLS suite proves the DB mirrors it.
 */

const NONE: ReadonlySet<string> = new Set();

describe("coerceAudienceScope", () => {
  it("passes through the three known scopes", () => {
    expect(coerceAudienceScope("all")).toBe("all");
    expect(coerceAudienceScope("admins")).toBe("admins");
    expect(coerceAudienceScope("assigned")).toBe("assigned");
  });
  it("defaults unknown / null to deny-by-default 'admins'", () => {
    expect(coerceAudienceScope(null)).toBe("admins");
    expect(coerceAudienceScope(undefined)).toBe("admins");
    expect(coerceAudienceScope("everyone")).toBe("admins");
    expect(coerceAudienceScope(42)).toBe("admins");
  });
});

describe("ADMIN_ONLY_NOTIFICATION_CATEGORIES", () => {
  it("covers every category that has an org-wide customer emitter", () => {
    for (const c of [
      "support",
      "billing",
      "stripe",
      "onboarding",
      "migration",
      "demo",
      "signup",
      "health",
      "alert",
      "system",
    ] as const) {
      expect(ADMIN_ONLY_NOTIFICATION_CATEGORIES.has(c)).toBe(true);
    }
  });
});

describe("staffEligibleForOrgWideNotification (non-admin gate)", () => {
  const sensitive: NotificationCategory[] = [
    "billing",
    "stripe",
    "onboarding",
    "migration",
    "support",
    "health",
    "demo",
    "signup",
    "alert",
    "system",
  ];

  it("blocks EVERY sensitive category even when scope says 'all'", () => {
    for (const category of sensitive) {
      expect(
        staffEligibleForOrgWideNotification({
          category,
          audienceScope: "all",
          sourceModule: null,
          sourceId: null,
          assignedJobIds: NONE,
        }),
      ).toBe(false);
    }
  });

  it("admins-scope denies staff for a non-sensitive category", () => {
    expect(
      staffEligibleForOrgWideNotification({
        category: "other",
        audienceScope: "admins",
        sourceModule: null,
        sourceId: null,
        assignedJobIds: NONE,
      }),
    ).toBe(false);
  });

  it("all-scope allows staff for a non-sensitive category", () => {
    expect(
      staffEligibleForOrgWideNotification({
        category: "other",
        audienceScope: "all",
        sourceModule: null,
        sourceId: null,
        assignedJobIds: NONE,
      }),
    ).toBe(true);
  });

  it("assigned-scope allows ONLY when assigned to the referenced job", () => {
    const base = {
      category: "other" as NotificationCategory,
      audienceScope: "assigned" as const,
      sourceModule: "jobs",
    };
    expect(
      staffEligibleForOrgWideNotification({
        ...base,
        sourceId: "job-1",
        assignedJobIds: new Set(["job-1"]),
      }),
    ).toBe(true);
    expect(
      staffEligibleForOrgWideNotification({
        ...base,
        sourceId: "job-2",
        assignedJobIds: new Set(["job-1"]),
      }),
    ).toBe(false);
    // revocation: no assignments → not eligible.
    expect(
      staffEligibleForOrgWideNotification({
        ...base,
        sourceId: "job-1",
        assignedJobIds: NONE,
      }),
    ).toBe(false);
  });

  it("assigned-scope requires a jobs source (no leaking a non-job row)", () => {
    expect(
      staffEligibleForOrgWideNotification({
        category: "other",
        audienceScope: "assigned",
        sourceModule: "billing",
        sourceId: "job-1",
        assignedJobIds: new Set(["job-1"]),
      }),
    ).toBe(false);
  });
});

describe("memberEligibleForNotification (per row × member)", () => {
  const orgWideBilling = {
    user_id: null,
    category: "billing" as NotificationCategory,
    audience_scope: "admins" as const,
    source_module: "billing",
    source_id: null,
  };

  it("targeted row → only its owner, regardless of admin/scope", () => {
    const row = { ...orgWideBilling, user_id: "u1" };
    expect(
      memberEligibleForNotification({ row, userId: "u1", isAdmin: false, assignedJobIds: NONE }),
    ).toBe(true);
    expect(
      memberEligibleForNotification({ row, userId: "u2", isAdmin: true, assignedJobIds: NONE }),
    ).toBe(false);
  });

  it("org-wide billing → admin yes, staff no", () => {
    expect(
      memberEligibleForNotification({
        row: orgWideBilling,
        userId: "owner",
        isAdmin: true,
        assignedJobIds: NONE,
      }),
    ).toBe(true);
    expect(
      memberEligibleForNotification({
        row: orgWideBilling,
        userId: "staff",
        isAdmin: false,
        assignedJobIds: NONE,
      }),
    ).toBe(false);
  });
});
