import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ADMIN_ONLY_NOTIFICATION_CATEGORIES,
  memberEligibleForNotification,
} from "@/lib/notifications/eligibility";
import { resolveSmsRecipients } from "@/lib/notifications/sms";
import type { NotificationCategory, NotificationRow } from "@/lib/notifications/types";

/**
 * FEATURE 3 — staff notification privacy, trust-boundary guards.
 *
 * The in-app READ boundary is RLS (proven in the integration-RLS suite). The
 * OTHER channels — web push, SMS, email digest — fan out with the service-role
 * client, which bypasses RLS, so EACH must apply the same eligibility rule
 * before delivering. This file:
 *   1. pins the shared rule into every delivery channel's source (regression
 *      guard: a refactor that drops the gate fails here), and the migration's
 *      read-side predicate;
 *   2. behaviourally proves the pure rule denies staff every sensitive org-wide
 *      category and that the SMS resolver honours the eligibility gate.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PUSH_SRC = read("lib/notifications/push.ts");
const SMS_SRC = read("lib/notifications/sms.ts");
const DIGEST_SRC = read("server/services/notification-preferences-service.ts");
const MIG_SRC = read(
  "supabase/migrations/20261263000000_notifications_staff_privacy.sql",
);

describe("delivery channels wire the eligibility gate (source)", () => {
  it("push loads the context and gates each recipient", () => {
    expect(PUSH_SRC).toContain("loadNotificationEligibilityContext");
    expect(PUSH_SRC).toContain("isMemberEligible");
  });
  it("sms loads the context and passes the gate into the resolver", () => {
    expect(SMS_SRC).toContain("loadNotificationEligibilityContext");
    expect(SMS_SRC).toContain("isMemberEligible");
    expect(SMS_SRC).toMatch(/isEligible:/);
  });
  it("email digest loads the context and gates each row", () => {
    expect(DIGEST_SRC).toContain("loadNotificationEligibilityContext");
    expect(DIGEST_SRC).toContain("isMemberEligible");
  });
});

describe("migration read-side predicate (source)", () => {
  it("rewrites both SELECT and UPDATE policies", () => {
    expect(MIG_SRC).toContain("create policy notifications_select");
    expect(MIG_SRC).toContain("create policy notifications_update");
  });
  it("gates org-wide rows on role, category and assignment", () => {
    expect(MIG_SRC).toContain("public.is_org_admin(org_id)");
    expect(MIG_SRC).toContain("public.my_assigned_job_ids()");
    // the sensitive-category hard gate is present in the predicate.
    expect(MIG_SRC).toMatch(/category not in \(/);
    for (const c of ["billing", "stripe", "onboarding", "migration", "support"]) {
      expect(MIG_SRC).toContain(`'${c}'`);
    }
  });
  it("adds audience_scope deny-by-default ('admins')", () => {
    expect(MIG_SRC).toMatch(/audience_scope text not null default 'admins'/);
  });
});

describe("pure rule — staff privacy invariant", () => {
  it("denies a non-admin staff member EVERY admin-only category when org-wide", () => {
    for (const category of ADMIN_ONLY_NOTIFICATION_CATEGORIES) {
      const eligible = memberEligibleForNotification({
        row: {
          user_id: null,
          category,
          audience_scope: "all", // even the most permissive scope
          source_module: null,
          source_id: null,
        },
        userId: "staff",
        isAdmin: false,
        assignedJobIds: new Set(),
      });
      expect(eligible, `staff must never receive org-wide '${category}'`).toBe(false);
    }
  });

  it("admins still receive org-wide sensitive rows (capabilities preserved)", () => {
    expect(
      memberEligibleForNotification({
        row: {
          user_id: null,
          category: "billing",
          audience_scope: "admins",
          source_module: "billing",
          source_id: null,
        },
        userId: "owner",
        isAdmin: true,
        assignedJobIds: new Set(),
      }),
    ).toBe(true);
  });
});

describe("resolveSmsRecipients honours the eligibility gate", () => {
  const row = (over: Partial<NotificationRow>): NotificationRow => ({
    id: "n1",
    org_id: "orgA",
    user_id: null,
    audience: "customer",
    audience_scope: "admins",
    type: "stripe.payment_failed",
    category: "stripe" as NotificationCategory,
    title: "Payment failed",
    body: null,
    priority: "urgent",
    source_module: "stripe",
    source_id: null,
    action_url: null,
    read_at: null,
    dismissed_at: null,
    metadata: {},
    created_at: "2026-10-31T00:00:00Z",
    updated_at: "2026-10-31T00:00:00Z",
    ...over,
  });

  const members = new Map([["orgA", new Set(["owner", "staff"])]]);
  const phoned = new Set(["orgA::owner", "orgA::staff"]);
  const prefs = new Map(); // default prefs → channel allowed

  it("drops the staff member from an org-wide sensitive fan-out, keeps the admin", () => {
    const out = resolveSmsRecipients({
      rows: [row({})],
      membersByOrg: members,
      phonedKeys: phoned,
      prefIndex: prefs,
      isEligible: (r, u) =>
        memberEligibleForNotification({
          row: r,
          userId: u,
          isAdmin: u === "owner",
          assignedJobIds: new Set(),
        }),
    });
    const users = out.map((r) => r.userId);
    expect(users).toContain("owner");
    expect(users).not.toContain("staff");
  });

  it("without the gate the leak would reach staff (proves the gate is load-bearing)", () => {
    const out = resolveSmsRecipients({
      rows: [row({})],
      membersByOrg: members,
      phonedKeys: phoned,
      prefIndex: prefs,
    });
    expect(out.map((r) => r.userId)).toContain("staff"); // old behaviour
  });
});
