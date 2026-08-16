import { describe, it, expect } from "vitest";
import {
  resolveNotificationDelivery,
  isCriticalNotification,
  indexPreferencesByCategory,
  buildDigestEmail,
  groupDigestByCategory,
  DEFAULT_DELIVERY,
  CRITICAL_CATEGORIES,
  type NotificationPreference,
  type DigestNotification,
} from "@/lib/notifications/preferences";

/**
 * P3 — per-user notification preference policy (pure).
 *
 * Pins the DECISION contract every sender + the digest cron inherit:
 *   1. DEFAULT behaviour when a user has no preference (in-app on, email now).
 *   2. Preference HONORED — opt-out suppresses, a digest cadence defers.
 *   3. CRITICAL floor — money/security categories and urgent priority ALWAYS
 *      send immediately, overriding even an explicit opt-out.
 *   4. Digest COMPOSITION — batching, grouping, empty→null, count in subject.
 */

const pref = (over: Partial<NotificationPreference>): NotificationPreference => ({
  org_id: "o1",
  user_id: "u1",
  category: "support",
  in_app_enabled: true,
  email_enabled: true,
  email_cadence: "immediate",
  push_enabled: false,
  sms_enabled: false,
  ...over,
});

// =====================================================================
// 1. Default behaviour (no preference row)
// =====================================================================

describe("resolveNotificationDelivery — default (no preference)", () => {
  it("no preference → in-app on, email immediate (today's behaviour)", () => {
    expect(
      resolveNotificationDelivery({
        category: "support",
        priority: "medium",
        preference: null,
      }),
    ).toEqual(DEFAULT_DELIVERY);
    expect(DEFAULT_DELIVERY).toEqual({ inApp: true, email: "immediate" });
  });

  it("undefined preference is treated the same as null", () => {
    expect(
      resolveNotificationDelivery({
        category: "onboarding",
        priority: "low",
      }),
    ).toEqual({ inApp: true, email: "immediate" });
  });
});

// =====================================================================
// 2. Preference honored
// =====================================================================

describe("resolveNotificationDelivery — preference honored", () => {
  it("email disabled → email 'off' (suppressed), in-app still follows toggle", () => {
    expect(
      resolveNotificationDelivery({
        category: "onboarding",
        priority: "low",
        preference: pref({ category: "onboarding", email_enabled: false }),
      }),
    ).toEqual({ inApp: true, email: "off" });
  });

  it("in-app disabled → inApp false", () => {
    expect(
      resolveNotificationDelivery({
        category: "onboarding",
        priority: "low",
        preference: pref({ category: "onboarding", in_app_enabled: false }),
      }),
    ).toEqual({ inApp: false, email: "immediate" });
  });

  it("daily cadence → email 'digest' (deferred to the cron)", () => {
    expect(
      resolveNotificationDelivery({
        category: "onboarding",
        priority: "low",
        preference: pref({ category: "onboarding", email_cadence: "daily" }),
      }),
    ).toEqual({ inApp: true, email: "digest" });
  });

  it("weekly cadence → email 'digest'", () => {
    expect(
      resolveNotificationDelivery({
        category: "migration",
        priority: "medium",
        preference: pref({ category: "migration", email_cadence: "weekly" }),
      }).email,
    ).toBe("digest");
  });

  it("immediate cadence → email 'immediate'", () => {
    expect(
      resolveNotificationDelivery({
        category: "support",
        priority: "medium",
        preference: pref({ email_cadence: "immediate" }),
      }).email,
    ).toBe("immediate");
  });
});

// =====================================================================
// 3. Critical floor — never suppressed / deferred
// =====================================================================

describe("critical notifications always send immediately", () => {
  it("critical categories are billing, stripe, alert", () => {
    expect([...CRITICAL_CATEGORIES].sort()).toEqual([
      "alert",
      "billing",
      "stripe",
    ]);
  });

  it("urgent priority in ANY category is critical", () => {
    expect(isCriticalNotification("onboarding", "urgent")).toBe(true);
    expect(isCriticalNotification("support", "high")).toBe(false);
  });

  it("critical category overrides an explicit email opt-out", () => {
    const out = resolveNotificationDelivery({
      category: "stripe",
      priority: "high",
      preference: pref({
        category: "stripe",
        email_enabled: false,
        in_app_enabled: false,
        email_cadence: "weekly",
      }),
    });
    // The opt-out is ignored — critical forces both channels immediately.
    expect(out).toEqual({ inApp: true, email: "immediate" });
  });

  it("urgent priority overrides a digest cadence in a mutable category", () => {
    const out = resolveNotificationDelivery({
      category: "support",
      priority: "urgent",
      preference: pref({ email_cadence: "daily", email_enabled: true }),
    });
    expect(out).toEqual({ inApp: true, email: "immediate" });
  });
});

// =====================================================================
// 4. Index helper
// =====================================================================

describe("indexPreferencesByCategory", () => {
  it("keys rows by category for O(1) lookup", () => {
    const map = indexPreferencesByCategory([
      pref({ category: "support" }),
      pref({ category: "onboarding", email_cadence: "daily" }),
    ]);
    expect(map.get("support")?.email_cadence).toBe("immediate");
    expect(map.get("onboarding")?.email_cadence).toBe("daily");
    expect(map.has("billing")).toBe(false);
  });
});

// =====================================================================
// 5. Digest composition + batching
// =====================================================================

const dn = (over: Partial<DigestNotification>): DigestNotification => ({
  id: "n1",
  category: "support",
  title: "A thing happened",
  body: null,
  priority: "medium",
  action_url: null,
  created_at: "2026-08-15T10:00:00.000Z",
  ...over,
});

describe("buildDigestEmail — batching one message from many notifications", () => {
  it("empty batch → null (never queue an empty email)", () => {
    expect(buildDigestEmail({ cadence: "daily", notifications: [] })).toBeNull();
  });

  it("batches N notifications into ONE email with the count in the subject", () => {
    const out = buildDigestEmail({
      cadence: "daily",
      notifications: [
        dn({ id: "1", category: "support", title: "Ticket reply" }),
        dn({ id: "2", category: "onboarding", title: "Milestone hit" }),
        dn({ id: "3", category: "support", title: "Status change" }),
      ],
      recipientName: "Sam",
    });
    expect(out).not.toBeNull();
    expect(out!.subject).toBe(
      "Your CrewFlow daily digest — 3 notifications",
    );
    // Every notification title appears exactly once in the single body.
    expect(out!.body_text).toContain("Ticket reply");
    expect(out!.body_text).toContain("Milestone hit");
    expect(out!.body_text).toContain("Status change");
    expect(out!.body_text).toContain("Hi Sam,");
    // Grouped under category headings.
    expect(out!.body_html).toContain("Support");
    expect(out!.body_html).toContain("Onboarding");
  });

  it("singular subject for a single notification", () => {
    const out = buildDigestEmail({
      cadence: "weekly",
      notifications: [dn({ id: "1", title: "Only one" })],
    });
    expect(out!.subject).toBe("Your CrewFlow weekly digest — 1 notification");
  });

  it("links each notification with an action_url back into the app", () => {
    const out = buildDigestEmail({
      cadence: "daily",
      notifications: [dn({ action_url: "/support/abc" })],
    });
    expect(out!.body_text).toContain("https://crewflow.uk/support/abc");
    expect(out!.body_html).toContain("https://crewflow.uk/support/abc");
  });

  it("escapes HTML in titles/bodies (no injection)", () => {
    const out = buildDigestEmail({
      cadence: "daily",
      notifications: [dn({ title: "<script>alert(1)</script>" })],
    });
    expect(out!.body_html).not.toContain("<script>alert(1)</script>");
    expect(out!.body_html).toContain("&lt;script&gt;");
  });
});

describe("groupDigestByCategory", () => {
  it("groups preserving first-appearance category order and within-group order", () => {
    const groups = groupDigestByCategory([
      dn({ id: "1", category: "support", title: "s1" }),
      dn({ id: "2", category: "billing", title: "b1" }),
      dn({ id: "3", category: "support", title: "s2" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["support", "billing"]);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["s1", "s2"]);
    expect(groups[1]!.items.map((i) => i.title)).toEqual(["b1"]);
  });
});
