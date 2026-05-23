import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITY_RANK,
  type NotificationRow,
  type NotificationPriority,
  type NotificationCategory,
} from "@/lib/notifications/types";
import {
  prioritySort,
  filterNotifications,
  groupByDate,
  badgeText,
} from "@/lib/notifications/sort";
import {
  EVENT_HELPERS,
  notifyOnSupportReplyToCustomer,
  notifyOnSupportReplyToHq,
  notifyOnSupportPriorityUrgent,
  notifyOnFailedPayment,
  notifyOnOverdueInvoice,
  notifyOnSetupFeePaid,
  notifyOnSubscriptionStarted,
  notifyOnSubscriptionCancelled,
  notifyOnOnboardingMilestone,
  notifyOnMigrationProgress,
  notifyOnMigrationStalled,
  notifyOnHealthDropped,
  notifyOnDemoRequested,
  notifyOnCustomerSignup,
  notifyOnUrgentHqAlert,
} from "@/lib/notifications/events";

/**
 * HQ-8 Notifications OS contract tests.
 *
 * What's pinned:
 *   1. Vocab: 3 audiences, 4 priorities, 11 categories.
 *   2. Pure compute: prioritySort + filterNotifications + groupByDate
 *      handle edge cases (empty, all read, dismissed) without crash.
 *   3. Event helpers: 16 of them, each producing the directive's
 *      required shape — title, body, priority, action_url, audience,
 *      source_module, metadata, category.
 *   4. Migration shape: notifications extended with new columns +
 *      RLS rewritten + email queue table created.
 *   5. Service: createNotification + createBulkNotifications +
 *      emitNotifications wrap safely; mark/dismiss available on
 *      both client paths.
 *   6. Wire points: every directive-required event has a
 *      `emitNotifications(notifyOn...)` call in the real action
 *      that fires it.
 *   7. UI: customer + HQ routes exist and import their actions.
 *   8. Nav: customer sidebar + HQ_NAV both wire notifications +
 *      badge.
 *   9. Email queue: stub queues a row with status='queued', stub
 *      sender returns 'skipped' with no provider configured.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260611000000_notifications_os.sql");
const SVC = read("server/services/notifications-service.ts");
const EVENTS_LIB = read("lib/notifications/events.ts");
const EMAIL_LIB = read("lib/notifications/email.ts");
const CUSTOMER_PAGE = read("app/(app)/notifications/page.tsx");
const HQ_PAGE = read("app/admin/notifications/page.tsx");
const CUSTOMER_ACTIONS = read("app/(app)/notifications/actions.ts");
const HQ_ACTIONS = read("app/admin/notifications/actions.ts");
const SIDEBAR = read("app/(app)/_components/sidebar.tsx");
const HQ_LAYOUT = read("app/admin/layout.tsx");
const SUPPORT_HQ = read("app/admin/support/actions.ts");
const SUPPORT_CUSTOMER = read("app/(app)/support/actions.ts");
const BILLING_ACTIONS = read("app/admin/billing/actions.ts");
const STRIPE_HANDLER = read("server/services/stripe-webhook-handler.ts");
const DEMO_ROUTE = read("app/api/demo/route.ts");
const ORG_CREATE = read("app/onboarding/company/actions.ts");
const HEALTH = read("server/services/hq-health-recompute.ts");
const CUSTOMER_PROGRESS = read("app/admin/customers/actions.ts");

// =====================================================================
// 1. Vocab
// =====================================================================

describe("notifications vocab", () => {
  it("audience = customer | hq | both", () => {
    expect(NOTIFICATION_AUDIENCES).toEqual(["customer", "hq", "both"]);
  });
  it("priorities = low | medium | high | urgent", () => {
    expect(NOTIFICATION_PRIORITIES).toEqual(["low", "medium", "high", "urgent"]);
  });
  it("11 categories covering every directive bucket", () => {
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
      "other",
    ]) {
      expect(NOTIFICATION_CATEGORIES).toContain(c as NotificationCategory);
    }
  });
  it("priority rank: urgent < high < medium < low", () => {
    expect(NOTIFICATION_PRIORITY_RANK.urgent).toBeLessThan(
      NOTIFICATION_PRIORITY_RANK.high,
    );
    expect(NOTIFICATION_PRIORITY_RANK.high).toBeLessThan(
      NOTIFICATION_PRIORITY_RANK.medium,
    );
    expect(NOTIFICATION_PRIORITY_RANK.medium).toBeLessThan(
      NOTIFICATION_PRIORITY_RANK.low,
    );
  });
});

// =====================================================================
// 2. Pure compute
// =====================================================================

function notif(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n1",
    org_id: "o1",
    user_id: null,
    audience: "customer",
    type: "test",
    category: "other",
    title: "test",
    body: null,
    priority: "medium",
    source_module: null,
    source_id: null,
    action_url: null,
    read_at: null,
    dismissed_at: null,
    metadata: {},
    created_at: "2026-05-23T12:00:00Z",
    updated_at: "2026-05-23T12:00:00Z",
    ...over,
  };
}

describe("prioritySort", () => {
  it("unread + un-dismissed first; urgent before low; newest first within priority", () => {
    const rows: NotificationRow[] = [
      notif({ id: "a", priority: "low", created_at: "2026-05-23T12:00:00Z" }),
      notif({ id: "b", priority: "urgent", created_at: "2026-05-22T12:00:00Z" }),
      notif({
        id: "c",
        priority: "urgent",
        created_at: "2026-05-23T12:00:00Z",
        read_at: "2026-05-23T12:01:00Z",
      }),
      notif({ id: "d", priority: "high", created_at: "2026-05-23T11:00:00Z" }),
    ];
    const sorted = prioritySort(rows);
    expect(sorted[0]?.id).toBe("b"); // unread urgent
    expect(sorted[1]?.id).toBe("d"); // unread high
    expect(sorted[2]?.id).toBe("a"); // unread low
    expect(sorted[3]?.id).toBe("c"); // read urgent (last)
  });

  it("handles empty input", () => {
    expect(prioritySort([])).toEqual([]);
  });
});

describe("filterNotifications", () => {
  const rows = [
    notif({ id: "1", category: "support", priority: "urgent" }),
    notif({ id: "2", category: "billing", priority: "medium", read_at: "2026-05-23" }),
    notif({
      id: "3",
      category: "stripe",
      priority: "high",
      dismissed_at: "2026-05-23",
    }),
  ];

  it("state=unread hides read AND dismissed", () => {
    expect(filterNotifications(rows, { state: "unread" }).map((r) => r.id)).toEqual(
      ["1"],
    );
  });
  it("state=dismissed shows only dismissed", () => {
    expect(
      filterNotifications(rows, { state: "dismissed" }).map((r) => r.id),
    ).toEqual(["3"]);
  });
  it("category narrows", () => {
    expect(
      filterNotifications(rows, { category: "billing" }).map((r) => r.id),
    ).toEqual(["2"]);
  });
  it("priority narrows", () => {
    expect(
      filterNotifications(rows, { priority: "urgent" }).map((r) => r.id),
    ).toEqual(["1"]);
  });
  it("q matches title", () => {
    const out = filterNotifications(
      [notif({ id: "x", title: "Hello world" })],
      { q: "WORLD" },
    );
    expect(out).toHaveLength(1);
  });
});

describe("groupByDate", () => {
  const NOW = new Date("2026-05-23T12:00:00Z");
  it("buckets today / yesterday / earlier this week / older", () => {
    const rows = [
      notif({ id: "today", created_at: "2026-05-23T08:00:00Z" }),
      notif({ id: "yest", created_at: "2026-05-22T08:00:00Z" }),
      notif({ id: "week", created_at: "2026-05-19T08:00:00Z" }),
      notif({ id: "old", created_at: "2026-05-01T08:00:00Z" }),
    ];
    const groups = groupByDate(rows, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Earlier this week",
      "Older",
    ]);
    expect(groups[0]?.rows[0]?.id).toBe("today");
  });

  it("omits empty buckets", () => {
    const onlyToday = [notif({ created_at: "2026-05-23T08:00:00Z" })];
    expect(groupByDate(onlyToday, NOW).map((g) => g.label)).toEqual(["Today"]);
  });
});

describe("badgeText", () => {
  it("0 → null", () => expect(badgeText(0)).toBeNull());
  it("1..99 → str", () => expect(badgeText(42)).toBe("42"));
  it(">99 → 99+", () => expect(badgeText(150)).toBe("99+"));
});

// =====================================================================
// 3. Event helpers — each produces a useful shape
// =====================================================================

describe("event helpers — every directive-mandated event has a helper", () => {
  it("EVENT_HELPERS lists all 16 helper names", () => {
    expect(EVENT_HELPERS.length).toBeGreaterThanOrEqual(16);
    for (const name of [
      "notifyOnSupportReplyToCustomer",
      "notifyOnSupportReplyToHq",
      "notifyOnSupportStatusChanged",
      "notifyOnSupportPriorityUrgent",
      "notifyOnFailedPayment",
      "notifyOnOverdueInvoice",
      "notifyOnSetupFeePaid",
      "notifyOnSubscriptionStarted",
      "notifyOnSubscriptionCancelled",
      "notifyOnOnboardingMilestone",
      "notifyOnMigrationProgress",
      "notifyOnMigrationStalled",
      "notifyOnHealthDropped",
      "notifyOnDemoRequested",
      "notifyOnCustomerSignup",
      "notifyOnUrgentHqAlert",
    ]) {
      expect(EVENT_HELPERS).toContain(name);
    }
  });

  it("support reply (HQ → customer) → customer audience, action_url to /support/[id]", () => {
    const n = notifyOnSupportReplyToCustomer({
      org_id: "o1",
      ticket_id: "t1",
      ticket_number: 42,
      subject: "Help",
      body_preview: "x",
    });
    expect(n.audience).toBe("customer");
    expect(n.category).toBe("support");
    expect(n.action_url).toBe("/support/t1");
    expect(n.title).toContain("#42");
  });

  it("support reply (customer → HQ) → hq audience, high priority", () => {
    const n = notifyOnSupportReplyToHq({
      org_id: "o1",
      ticket_id: "t1",
      ticket_number: 42,
      subject: "Help",
      body_preview: "x",
    });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("high");
    expect(n.action_url).toBe("/admin/support/t1");
  });

  it("support priority urgent → hq audience, urgent priority", () => {
    const n = notifyOnSupportPriorityUrgent({
      org_id: "o1",
      ticket_id: "t1",
      ticket_number: 1,
      subject: "test",
    });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("urgent");
  });

  it("failed payment fans out to BOTH customer + HQ", () => {
    const out = notifyOnFailedPayment({
      org_id: "o1",
      amount_gbp: 500,
      reason: "Card declined",
    });
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.audience).sort()).toEqual(["customer", "hq"]);
    expect(out[0]?.category).toBe("stripe");
    expect(out[0]?.priority).toBe("urgent");
  });

  it("setup fee paid fans out to BOTH", () => {
    const out = notifyOnSetupFeePaid({ org_id: "o1", amount_gbp: 1000 });
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.audience).sort()).toEqual(["customer", "hq"]);
  });

  it("subscription started fans out to BOTH", () => {
    const out = notifyOnSubscriptionStarted({
      org_id: "o1",
      stripe_subscription_id: "sub_1",
    });
    expect(out).toHaveLength(2);
  });

  it("subscription cancelled → hq URGENT (high-blast decision)", () => {
    const n = notifyOnSubscriptionCancelled({
      org_id: "o1",
      stripe_subscription_id: "sub_1",
    });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("urgent");
    expect(n.action_url).toContain("/admin/customers/");
  });

  it("overdue invoice priority scales with days_overdue", () => {
    const mild = notifyOnOverdueInvoice({
      org_id: "o1",
      amount_gbp: 500,
      days_overdue: 5,
      invoice_id: "inv1",
    });
    const bad = notifyOnOverdueInvoice({
      org_id: "o1",
      amount_gbp: 500,
      days_overdue: 40,
      invoice_id: "inv1",
    });
    expect(mild[0]?.priority).toBe("high");
    expect(bad[0]?.priority).toBe("urgent");
  });

  it("health dropped → hq, urgent when critical band", () => {
    const critical = notifyOnHealthDropped({
      org_id: "o1",
      old_score: 60,
      new_score: 30,
    });
    expect(critical.audience).toBe("hq");
    expect(critical.priority).toBe("urgent");
    const watch = notifyOnHealthDropped({
      org_id: "o1",
      old_score: 80,
      new_score: 65,
    });
    expect(watch.priority).toBe("medium");
  });

  it("demo received → hq, demo category, deep-link to /admin/demos", () => {
    const n = notifyOnDemoRequested({
      demo_id: "d1",
      company: "Acme Co",
    });
    expect(n.audience).toBe("hq");
    expect(n.category).toBe("demo");
    expect(n.action_url).toBe("/admin/demos");
    expect(n.title).toContain("Acme Co");
  });

  it("customer signup → hq, signup category, deep-link to customer page", () => {
    const n = notifyOnCustomerSignup({
      org_id: "o1",
      org_name: "Acme Co",
      owner_email: "owner@example.com",
    });
    expect(n.audience).toBe("hq");
    expect(n.category).toBe("signup");
    expect(n.action_url).toBe("/admin/customers/o1");
  });

  it("onboarding milestone → customer, deep-link to /dashboard", () => {
    const n = notifyOnOnboardingMilestone({
      org_id: "o1",
      milestone: "Profile",
      percent: 25,
    });
    expect(n.audience).toBe("customer");
    expect(n.action_url).toBe("/dashboard");
    expect(n.title).toContain("25%");
  });

  it("migration progress at 100 → action_url /imports", () => {
    const done = notifyOnMigrationProgress({ org_id: "o1", percent: 100 });
    expect(done.title).toContain("complete");
    expect(done.action_url).toBe("/imports");
  });

  it("migration stalled → hq, high priority, deep-link to onboarding", () => {
    const n = notifyOnMigrationStalled({ org_id: "o1", days_stalled: 12 });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("high");
    expect(n.action_url).toBe("/admin/onboarding");
  });

  it("urgent HQ alert → hq, urgent priority", () => {
    const n = notifyOnUrgentHqAlert({
      org_id: "o1",
      alert_label: "Payment failed",
    });
    expect(n.audience).toBe("hq");
    expect(n.priority).toBe("urgent");
  });

  it("every helper sets source_module + category for downstream filtering", () => {
    const ns = [
      notifyOnSupportReplyToCustomer({
        org_id: "o1",
        ticket_id: "t1",
        ticket_number: 1,
        subject: "x",
        body_preview: "y",
      }),
      notifyOnHealthDropped({ org_id: "o1", old_score: 90, new_score: 85 }),
      notifyOnDemoRequested({ demo_id: "d1", company: "x" }),
    ];
    for (const n of ns) {
      expect(n.source_module).toBeTruthy();
      expect(n.category).toBeTruthy();
    }
  });
});

// =====================================================================
// 4. Migration shape
// =====================================================================

describe("migration 20260611000000 — notifications OS", () => {
  it("user_id becomes nullable for org-wide notifications", () => {
    expect(MIGRATION).toMatch(/alter column user_id drop not null/);
  });

  it("adds every directive-required column", () => {
    for (const col of [
      "audience",
      "category",
      "priority",
      "source_module",
      "source_id",
      "dismissed_at",
      "metadata",
      "updated_at",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`add column if not exists\\s+${col}`));
    }
  });

  it("audience CHECK matches NOTIFICATION_AUDIENCES", () => {
    expect(MIGRATION).toMatch(/audience\s+text not null default 'customer'/);
    expect(MIGRATION).toMatch(/'customer'.*'hq'.*'both'/s);
  });

  it("priority CHECK matches NOTIFICATION_PRIORITIES", () => {
    expect(MIGRATION).toMatch(
      /priority\s+text not null default 'medium'/,
    );
    expect(MIGRATION).toMatch(/'low'.*'medium'.*'high'.*'urgent'/s);
  });

  it("RLS rewritten — drops legacy policies, recreates with audience + nullable user_id awareness", () => {
    expect(MIGRATION).toMatch(/drop policy if exists "notifications: own select"/);
    expect(MIGRATION).toMatch(/create policy notifications_select/);
    // The new policy gates by audience and supports both user-targeted
    // and org-wide rows.
    expect(MIGRATION).toMatch(/audience in \('customer', 'both'\)/);
    expect(MIGRATION).toMatch(/user_id is null and org_id in/);
  });

  it("touch trigger keeps updated_at fresh", () => {
    expect(MIGRATION).toMatch(/notifications_touch/);
  });

  it("indexes cover the directive's access patterns", () => {
    for (const idx of [
      "notifications_org_recent_idx",
      "notifications_audience_idx",
      "notifications_priority_idx",
      "notifications_source_idx",
      "notifications_unread_active_idx",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(idx));
    }
  });

  it("creates notification_email_queue with the directive's state machine", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.notification_email_queue/);
    for (const status of ["queued", "sent", "failed", "skipped"]) {
      expect(MIGRATION).toMatch(new RegExp(`'${status}'`));
    }
    expect(MIGRATION).toMatch(/retry_count\s+integer not null default 0/);
    expect(MIGRATION).toMatch(/last_error\s+text/);
  });

  it("notification_email_queue is service-role only (RLS enabled, no policies)", () => {
    expect(MIGRATION).toMatch(/alter table public\.notification_email_queue enable row level security/);
    // No policy is created for the email queue (we keep service-role
    // access only).
    expect(
      MIGRATION.split("notification_email_queue").pop() ?? "",
    ).not.toMatch(/create policy/);
  });
});

// =====================================================================
// 5. Service
// =====================================================================

describe("notifications service", () => {
  it("exports createNotification, createBulkNotifications, emitNotifications", () => {
    expect(SVC).toMatch(/export async function createNotification/);
    expect(SVC).toMatch(/export async function createBulkNotifications/);
    expect(SVC).toMatch(/export async function emitNotifications/);
  });

  it("exports both unread counts (customer + HQ)", () => {
    expect(SVC).toMatch(/export async function getUnreadCountForCustomer/);
    expect(SVC).toMatch(/export async function getUnreadCountForHq/);
  });

  it("exports mark / dismiss helpers with audience routing", () => {
    expect(SVC).toMatch(/export async function markNotificationRead/);
    expect(SVC).toMatch(/export async function markAllNotificationsRead/);
    expect(SVC).toMatch(/export async function dismissNotification/);
  });

  it("writes BOTH new and legacy column names so existing NotificationsBell keeps working", () => {
    expect(SVC).toMatch(/related_table: input\.source_module/);
    expect(SVC).toMatch(/related_id: input\.source_id/);
  });
});

// =====================================================================
// 6. Wire points (directive's "Real actions must create real notifications")
// =====================================================================

describe("wire points — real events emit real notifications", () => {
  it("support replyAsHq emits customer notification", () => {
    expect(SUPPORT_HQ).toMatch(/notifyOnSupportReplyToCustomer/);
    expect(SUPPORT_HQ).toMatch(/emitNotifications\(/);
  });
  it("support customer reply emits HQ notification", () => {
    expect(SUPPORT_CUSTOMER).toMatch(/notifyOnSupportReplyToHq/);
    expect(SUPPORT_CUSTOMER).toMatch(/emitNotifications\(/);
  });
  it("support status change emits customer notification", () => {
    expect(SUPPORT_HQ).toMatch(/notifyOnSupportStatusChanged/);
  });
  it("support priority=urgent emits HQ urgent notification", () => {
    expect(SUPPORT_HQ).toMatch(/notifyOnSupportPriorityUrgent/);
    expect(SUPPORT_HQ).toMatch(/parsed\.data\.priority === "urgent"/);
  });
  it("Stripe failed payment emits to both", () => {
    expect(STRIPE_HANDLER).toMatch(/notifyOnFailedPayment/);
  });
  it("Stripe setup fee paid emits to both", () => {
    expect(STRIPE_HANDLER).toMatch(/notifyOnSetupFeePaid/);
  });
  it("Stripe subscription started emits to both", () => {
    expect(STRIPE_HANDLER).toMatch(/notifyOnSubscriptionStarted/);
  });
  it("Stripe subscription cancelled emits HQ urgent", () => {
    expect(STRIPE_HANDLER).toMatch(/notifyOnSubscriptionCancelled/);
  });
  it("HQ manual setup-fee paid flip emits setup-fee notification", () => {
    expect(BILLING_ACTIONS).toMatch(/notifyOnSetupFeePaid/);
  });
  it("demo request endpoint emits HQ notification", () => {
    expect(DEMO_ROUTE).toMatch(/notifyOnDemoRequested/);
  });
  it("customer signup emits HQ notification", () => {
    expect(ORG_CREATE).toMatch(/notifyOnCustomerSignup/);
  });
  it("health recompute emits HQ notification on drop", () => {
    expect(HEALTH).toMatch(/notifyOnHealthDropped/);
    // Pinned to fire only when the score actually dropped.
    expect(HEALTH).toMatch(/newScore < oldScore/);
  });
  it("onboarding milestone crossing emits customer notification", () => {
    expect(CUSTOMER_PROGRESS).toMatch(/notifyOnOnboardingMilestone/);
  });
  it("migration progress emits customer notification on milestone crossing", () => {
    expect(CUSTOMER_PROGRESS).toMatch(/notifyOnMigrationProgress/);
  });
});

// =====================================================================
// 7. UI
// =====================================================================

describe("customer page wiring", () => {
  it("loads RLS-scoped via getLatestNotificationsForCustomer", () => {
    expect(CUSTOMER_PAGE).toMatch(/getLatestNotificationsForCustomer/);
  });
  it("renders state/category/priority filters", () => {
    expect(CUSTOMER_PAGE).toMatch(/name="state"/);
    expect(CUSTOMER_PAGE).toMatch(/name="category"/);
    expect(CUSTOMER_PAGE).toMatch(/name="priority"/);
  });
  it("wires mark-read + mark-all + dismiss actions", () => {
    expect(CUSTOMER_PAGE).toMatch(/action=\{markRead\}/);
    expect(CUSTOMER_PAGE).toMatch(/action=\{markAllRead\}/);
    expect(CUSTOMER_PAGE).toMatch(/action=\{dismiss\}/);
  });
  it("actions require org context (RLS belt-and-braces)", () => {
    expect(CUSTOMER_ACTIONS).toMatch(/requireOrgContext/);
  });
});

describe("HQ page wiring", () => {
  it("loads cross-tenant via getLatestNotificationsForHq", () => {
    expect(HQ_PAGE).toMatch(/getLatestNotificationsForHq/);
  });
  it("renders org filter + KPI tiles", () => {
    expect(HQ_PAGE).toMatch(/name="org_id"/);
    expect(HQ_PAGE).toMatch(/Unread/);
    expect(HQ_PAGE).toMatch(/Urgent/);
  });
  it("actions re-check isSuperAdminEmail + dual-write admin_activity_log", () => {
    expect(HQ_ACTIONS).toMatch(/isSuperAdminEmail/);
    expect(HQ_ACTIONS).toMatch(/recordAdminActivity/);
  });
  it("HQ actions use hq audience routing for mark/dismiss", () => {
    expect(HQ_ACTIONS).toMatch(/audience: "hq"/);
  });
});

// =====================================================================
// 8. Nav + badge
// =====================================================================

describe("nav wiring", () => {
  it("customer sidebar has /notifications for both roles", () => {
    expect(SIDEBAR).toMatch(/href: "\/notifications"/);
    const occurrences = (SIDEBAR.match(/"\/notifications"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
  it("HQ_NAV has /admin/notifications without shipsIn", () => {
    expect(HQ_LAYOUT).toMatch(/href: "\/admin\/notifications", label: "Notifications" \}/);
    expect(HQ_LAYOUT).not.toMatch(/href: "\/admin\/notifications"[^}]*shipsIn:/);
  });
  it("HQ_NAV badge wired to getUnreadCountForHq", () => {
    expect(HQ_LAYOUT).toMatch(/getUnreadCountForHq/);
    expect(HQ_LAYOUT).toMatch(/notifBadge/);
  });
  it("badge fetch is best-effort (catches errors)", () => {
    expect(HQ_LAYOUT).toMatch(/\.catch\(\(\) => 0\)/);
  });
});

// =====================================================================
// 9. Email queue stub
// =====================================================================

describe("email queue stub", () => {
  it("exports queueNotificationEmail + sendNotificationEmail", () => {
    expect(EMAIL_LIB).toMatch(/export async function queueNotificationEmail/);
    expect(EMAIL_LIB).toMatch(/export async function sendNotificationEmail/);
  });
  it("queueNotificationEmail inserts with status='queued'", () => {
    expect(EMAIL_LIB).toMatch(/status:\s*"queued"/);
  });
  it("sendNotificationEmail returns 'skipped' (no provider yet)", () => {
    expect(EMAIL_LIB).toMatch(/no_provider_configured/);
    expect(EMAIL_LIB).toMatch(/status:\s*"skipped"/);
  });
});

// =====================================================================
// 10. Suppress-warning sanity checks
// =====================================================================

describe("event helpers — unused-imports sanity", () => {
  it("notifyOnFailedPayment/OverdueInvoice/SetupFeePaid/SubscriptionStarted return arrays", () => {
    const a = notifyOnFailedPayment({ org_id: "o1", amount_gbp: 500 });
    const b = notifyOnOverdueInvoice({
      org_id: "o1",
      amount_gbp: 100,
      days_overdue: 5,
      invoice_id: "i1",
    });
    const c = notifyOnSetupFeePaid({ org_id: "o1" });
    const d = notifyOnSubscriptionStarted({
      org_id: "o1",
      stripe_subscription_id: "sub1",
    });
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);
    expect(Array.isArray(c)).toBe(true);
    expect(Array.isArray(d)).toBe(true);
  });
  it("notifyOnMigrationStalled / Subscription cancelled return single objects", () => {
    const a = notifyOnMigrationStalled({ org_id: "o1", days_stalled: 7 });
    const b = notifyOnSubscriptionCancelled({
      org_id: "o1",
      stripe_subscription_id: "sub1",
    });
    expect(Array.isArray(a)).toBe(false);
    expect(Array.isArray(b)).toBe(false);
  });
  // Silence type-narrowing warnings on imports we don't otherwise
  // exercise — the contract is "they exist + are typed", not "we
  // assert their values here".
  void EVENTS_LIB;
  void NOTIFICATION_PRIORITIES;
  void (null as NotificationPriority | null);
});
