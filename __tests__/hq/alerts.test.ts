import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALERT_RULE_IDS,
  ALERT_RULE_SEVERITY,
  ALERT_SEVERITIES,
  ALERT_SORTS,
  SEVERITY_LABEL,
  SEVERITY_PILL,
  THRESHOLDS,
  runAlertRules,
  sortAlerts,
  filterAlerts,
  applyStateToAlerts,
  pickActionCentre,
  type AlertSnapshotRow,
  type AlertsSnapshot,
  type AlertOrg,
  type AlertInvoice,
  type AlertImport,
  type AlertDemo,
  type AlertState,
} from "@/lib/hq/alert-rules";

/**
 * HQ-5 Alerts + AI COO contract tests.
 *
 * What's pinned here:
 *   1. Rule constants — every directive bucket has its rule.
 *   2. Each rule fires on the canonical positive case AND stays
 *      silent on a paired negative case.
 *   3. Sorting orders alerts the way the CEO directive said.
 *   4. pickActionCentre dedupes by org, drops info, hard-limits to
 *      THRESHOLDS.cooPanelLimit.
 *   5. State application — read/snoozed/resolved bits flip the
 *      AlertWithState fields correctly.
 *   6. Migration shape — admin_alert_state has the columns + indexes
 *      + service-role-only RLS that the actions assume.
 *   7. Server actions — every action re-checks isSuperAdminEmail,
 *      writes admin_activity_log, validates with Zod.
 *   8. Page wiring — COO panel + filters + action set per the
 *      directive.
 *   9. HQ_NAV no longer marks alerts as "Coming soon".
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260608000000_admin_alert_state.sql");
const ACTIONS = read("app/admin/alerts/actions.ts");
const PAGE = read("app/admin/alerts/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");
const SNAPSHOT = read("server/services/hq-alerts-snapshot.ts");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const NOW = new Date("2026-05-22T12:00:00Z");
const NOW_MS = NOW.getTime();
const NOW_ISO = NOW.toISOString();

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * 86_400_000).toISOString();
}
function isoDaysFromNow(days: number): string {
  return new Date(NOW_MS + days * 86_400_000).toISOString();
}

function org(overrides: Partial<AlertOrg> = {}): AlertOrg {
  return {
    id: "org-1",
    name: "Adams Roofing",
    status: "active",
    setup_fee_status: "paid",
    setup_fee_paid_at: isoDaysAgo(30),
    trial_ends_at: null,
    next_renewal_at: null,
    approved_at: isoDaysAgo(30),
    cancelled_at: null,
    suspended_at: null,
    created_at: isoDaysAgo(60),
    updated_at: isoDaysAgo(2),
    mrr_gbp: 500,
    health_score: 75,
    last_login_at: isoDaysAgo(1),
    onboarding_percent: 100,
    migration_percent: 100,
    ...overrides,
  };
}

function row(overrides: Partial<AlertSnapshotRow> = {}): AlertSnapshotRow {
  return {
    org: org(overrides.org),
    invoices: overrides.invoices ?? [],
    imports: overrides.imports ?? [],
    demos: overrides.demos ?? [],
  };
}

function snapshotOf(rows: AlertSnapshotRow[]): AlertsSnapshot {
  return { rows, now: NOW_ISO };
}

const invoice = (over: Partial<AlertInvoice> = {}): AlertInvoice => ({
  id: "inv-1",
  org_id: "org-1",
  kind: "subscription",
  status: "sent",
  amount_gbp: 500,
  due_date: isoDaysAgo(5).slice(0, 10),
  sent_at: isoDaysAgo(10),
  paid_at: null,
  failed_at: null,
  created_at: isoDaysAgo(20),
  ...over,
});

const imprt = (over: Partial<AlertImport> = {}): AlertImport => ({
  id: "imp-1",
  org_id: "org-1",
  status: "uploaded",
  created_at: isoDaysAgo(20),
  last_row_activity_at: isoDaysAgo(2),
  committed_at: null,
  ...over,
});

const demo = (over: Partial<AlertDemo> = {}): AlertDemo => ({
  id: "demo-1",
  org_id: "org-1",
  email: "a@example.com",
  company: "Adams Roofing",
  status: "demo_booked",
  booked_at: isoDaysAgo(1),
  created_at: isoDaysAgo(3),
  ...over,
});

// =====================================================================
// 1. Constants
// =====================================================================

describe("ALERT_RULE_IDS — covers every directive bucket", () => {
  it("has the directive's HQ-5 buckets + HQ-12 extensions (8 critical, 7 warning, 4 info)", () => {
    const critical = ALERT_RULE_IDS.filter(
      (r) => ALERT_RULE_SEVERITY[r] === "critical",
    );
    const warning = ALERT_RULE_IDS.filter(
      (r) => ALERT_RULE_SEVERITY[r] === "warning",
    );
    const info = ALERT_RULE_IDS.filter((r) => ALERT_RULE_SEVERITY[r] === "info");
    // HQ-5 shipped 6 critical / 5 warning / 4 info. HQ-12 adds:
    //  +2 critical (subscription_cancelled, support_urgent_open)
    //  +2 warning (demo_not_contacted, no_login_after_signup)
    expect(critical).toHaveLength(8);
    expect(warning).toHaveLength(7);
    expect(info).toHaveLength(4);
  });

  it("includes each directive-mandated rule id", () => {
    for (const required of [
      "failed_payment",
      "high_mrr_low_health",
      "migration_stalled",
      "subscription_ending",
      "customer_inactive",
      "invoice_overdue",
      "setup_fee_unpaid",
      "low_usage",
      "low_onboarding",
      "trial_ending",
      "declining_health",
      "demo_booked",
      "customer_activated",
      "migration_completed",
      "payment_received",
    ] as const) {
      expect(ALERT_RULE_IDS).toContain(required);
    }
  });

  it("each severity has a label and pill colour", () => {
    for (const s of ALERT_SEVERITIES) {
      expect(SEVERITY_LABEL[s]).toBeTruthy();
      expect(SEVERITY_PILL[s]).toBeTruthy();
    }
  });

  it("sort options cover the four directive criteria", () => {
    expect(ALERT_SORTS).toEqual(["severity", "mrr", "newest", "health"]);
  });
});

// =====================================================================
// 2. Each rule — fires on positive case, stays silent on negative
// =====================================================================

describe("failed_payment", () => {
  it("fires when there is at least one failed invoice", () => {
    const r = row({
      invoices: [invoice({ status: "failed", failed_at: isoDaysAgo(1) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("failed_payment");
  });

  it("does not fire when every invoice is paid", () => {
    const r = row({ invoices: [invoice({ status: "paid", paid_at: isoDaysAgo(1) })] });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("failed_payment");
  });
});

describe("high_mrr_low_health", () => {
  it("fires for active org with high MRR and health < 40", () => {
    const r = row({ org: org({ mrr_gbp: 1500, health_score: 32 }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("high_mrr_low_health");
  });

  it("does not fire when health is ok", () => {
    const r = row({ org: org({ mrr_gbp: 1500, health_score: 60 }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("high_mrr_low_health");
  });

  it("does not fire when health is unknown (null)", () => {
    const r = row({ org: org({ mrr_gbp: 1500, health_score: null }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("high_mrr_low_health");
  });
});

describe("migration_stalled", () => {
  it("fires when import has no row activity in > 7 days and migration < 100%", () => {
    const r = row({
      org: org({ migration_percent: 40 }),
      imports: [imprt({ last_row_activity_at: isoDaysAgo(10) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("migration_stalled");
  });

  it("does not fire when migration is complete", () => {
    const r = row({
      org: org({ migration_percent: 100 }),
      imports: [imprt({ last_row_activity_at: isoDaysAgo(15) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("migration_stalled");
  });

  it("does not fire when activity is recent", () => {
    const r = row({
      org: org({ migration_percent: 50 }),
      imports: [imprt({ last_row_activity_at: isoDaysAgo(1) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("migration_stalled");
  });
});

describe("subscription_ending", () => {
  it("fires when next_renewal_at is within window", () => {
    const r = row({ org: org({ next_renewal_at: isoDaysFromNow(5) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("subscription_ending");
  });

  it("does not fire when next renewal is far away", () => {
    const r = row({ org: org({ next_renewal_at: isoDaysFromNow(60) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("subscription_ending");
  });
});

describe("customer_inactive", () => {
  it("fires when last_login_at is > 14 days ago", () => {
    const r = row({ org: org({ last_login_at: isoDaysAgo(20) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("customer_inactive");
  });

  it("does not fire when login is recent", () => {
    const r = row({ org: org({ last_login_at: isoDaysAgo(2) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("customer_inactive");
  });
});

describe("invoice_overdue", () => {
  it("fires when sent invoice has due_date > 30 days past", () => {
    const r = row({
      invoices: [
        invoice({
          status: "sent",
          due_date: isoDaysAgo(40).slice(0, 10),
        }),
      ],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("invoice_overdue");
  });

  it("does not fire when due date is within 30 days", () => {
    const r = row({
      invoices: [
        invoice({
          status: "sent",
          due_date: isoDaysAgo(10).slice(0, 10),
        }),
      ],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("invoice_overdue");
  });
});

describe("setup_fee_unpaid", () => {
  it("fires for active org with setup_fee_status pending", () => {
    const r = row({
      org: org({ setup_fee_status: "pending", setup_fee_paid_at: null }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("setup_fee_unpaid");
  });

  it("does not fire when setup is paid", () => {
    const r = row({ org: org({ setup_fee_status: "paid" }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("setup_fee_unpaid");
  });

  it("does not fire for waived setup", () => {
    const r = row({ org: org({ setup_fee_status: "waived" }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("setup_fee_unpaid");
  });
});

describe("low_usage", () => {
  it("fires when inactive 7–13 days (before customer_inactive kicks in)", () => {
    const r = row({ org: org({ last_login_at: isoDaysAgo(10) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("low_usage");
    expect(out.map((a) => a.ruleId)).not.toContain("customer_inactive");
  });

  it("hands off to customer_inactive at 14 days", () => {
    const r = row({ org: org({ last_login_at: isoDaysAgo(16) }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("low_usage");
    expect(out.map((a) => a.ruleId)).toContain("customer_inactive");
  });
});

describe("low_onboarding", () => {
  it("fires when onboarding_percent < 40 and customer is older than 7 days", () => {
    const r = row({
      org: org({ onboarding_percent: 20, created_at: isoDaysAgo(14) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("low_onboarding");
  });

  it("stays silent in the first week (natural ramp)", () => {
    const r = row({
      org: org({ onboarding_percent: 20, created_at: isoDaysAgo(2) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("low_onboarding");
  });
});

describe("trial_ending", () => {
  it("fires when trial ends within 5 days", () => {
    const r = row({
      org: org({ status: "trial", trial_ends_at: isoDaysFromNow(3) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("trial_ending");
  });

  it("does not fire for paying customers", () => {
    const r = row({
      org: org({ status: "active", trial_ends_at: isoDaysFromNow(3) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("trial_ending");
  });
});

describe("declining_health", () => {
  it("fires when active customer has medium-band health (40–59)", () => {
    const r = row({ org: org({ health_score: 50 }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("declining_health");
  });

  it("does not fire when health is critical (<40 — handled by high_mrr_low_health)", () => {
    const r = row({ org: org({ health_score: 30, mrr_gbp: 1500 }) });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("declining_health");
  });
});

describe("demo_booked", () => {
  it("fires when a demo was booked within the info window", () => {
    const r = row({
      org: org(),
      demos: [demo({ status: "demo_booked", booked_at: isoDaysAgo(1) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("demo_booked");
  });

  it("does not fire when demo was booked > 2 days ago", () => {
    const r = row({
      demos: [demo({ status: "demo_booked", booked_at: isoDaysAgo(5) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("demo_booked");
  });
});

describe("customer_activated", () => {
  it("fires when org flipped to active within the info window", () => {
    const r = row({
      org: org({ status: "active", approved_at: isoDaysAgo(1) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("customer_activated");
  });

  it("does not fire for old activations", () => {
    const r = row({
      org: org({ status: "active", approved_at: isoDaysAgo(30) }),
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("customer_activated");
  });
});

describe("migration_completed", () => {
  it("fires when migration_percent reaches 100 and import is committed recently", () => {
    const r = row({
      org: org({ migration_percent: 100 }),
      imports: [imprt({ committed_at: isoDaysAgo(1) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("migration_completed");
  });
});

describe("payment_received", () => {
  it("fires when an invoice was paid within the info window", () => {
    const r = row({
      invoices: [invoice({ status: "paid", paid_at: isoDaysAgo(1) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).toContain("payment_received");
  });

  it("does not fire for old paid invoices", () => {
    const r = row({
      invoices: [invoice({ status: "paid", paid_at: isoDaysAgo(10) })],
    });
    const out = runAlertRules(snapshotOf([r]));
    expect(out.map((a) => a.ruleId)).not.toContain("payment_received");
  });
});

// =====================================================================
// 3. Sorting
// =====================================================================

describe("sortAlerts", () => {
  const snap = snapshotOf([
    row({
      org: org({ id: "o-A", name: "A", mrr_gbp: 100, health_score: 50 }),
      invoices: [invoice({ org_id: "o-A", status: "failed", failed_at: isoDaysAgo(1) })],
    }),
    row({
      org: org({ id: "o-B", name: "B", mrr_gbp: 2000, health_score: 30 }),
    }),
    row({
      org: org({ id: "o-C", name: "C", mrr_gbp: 50, health_score: 80, last_login_at: isoDaysAgo(20) }),
    }),
  ]);
  const base = runAlertRules(snap);

  it("severity sort puts critical alerts first", () => {
    const out = sortAlerts(base, "severity");
    expect(out[0]?.severity).toBe("critical");
  });

  it("mrr sort puts the highest-MRR alert first", () => {
    const out = sortAlerts(base, "mrr");
    expect(out[0]?.mrr).toBeGreaterThanOrEqual(out[1]?.mrr ?? 0);
  });

  it("health sort puts the sickest org first", () => {
    const out = sortAlerts(base, "health");
    expect(out[0]?.health).toBeLessThanOrEqual(out[1]?.health ?? 100);
  });
});

// =====================================================================
// 4. pickActionCentre — AI COO panel
// =====================================================================

describe("pickActionCentre", () => {
  it("returns at most THRESHOLDS.cooPanelLimit alerts", () => {
    // 4 critical orgs.
    const rows: AlertSnapshotRow[] = Array.from({ length: 4 }, (_, i) =>
      row({
        org: org({
          id: `o-${i}`,
          name: `Org ${i}`,
          mrr_gbp: 1500,
          health_score: 20,
        }),
      }),
    );
    const out = pickActionCentre(runAlertRules(snapshotOf(rows)));
    expect(out.length).toBe(THRESHOLDS.cooPanelLimit);
  });

  it("dedupes by org so we don't surface the same customer thrice", () => {
    // One org triggers multiple critical rules — should appear ONCE.
    const r = row({
      org: org({
        id: "o-only",
        name: "Solo",
        mrr_gbp: 2000,
        health_score: 20,
        last_login_at: isoDaysAgo(30),
        setup_fee_status: "pending",
      }),
      invoices: [
        invoice({
          org_id: "o-only",
          status: "failed",
          failed_at: isoDaysAgo(1),
        }),
      ],
    });
    const out = pickActionCentre(runAlertRules(snapshotOf([r])));
    expect(out).toHaveLength(1);
    expect(out[0]?.orgId).toBe("o-only");
  });

  it("skips info-only alerts so the COO panel stays critical-focused", () => {
    const r = row({
      invoices: [invoice({ status: "paid", paid_at: isoDaysAgo(1) })],
    });
    const out = pickActionCentre(runAlertRules(snapshotOf([r])));
    expect(out).toHaveLength(0);
  });
});

// =====================================================================
// 5. applyStateToAlerts — read / snoozed / resolved bits
// =====================================================================

describe("applyStateToAlerts", () => {
  const r = row({
    org: org({ mrr_gbp: 2000, health_score: 20 }),
  });
  const alerts = runAlertRules(snapshotOf([r]));
  // Force a specific alert key so the assertions are concrete.
  const key = alerts[0]?.key as string;

  it("flags unread when there is no state row", () => {
    const out = applyStateToAlerts(alerts, new Map(), NOW_ISO);
    expect(out[0]?.unread).toBe(true);
    expect(out[0]?.snoozed).toBe(false);
    expect(out[0]?.resolved).toBe(false);
  });

  it("flags read when state.read_at is set", () => {
    const states = new Map<string, AlertState>([
      [
        key,
        {
          read_at: NOW_ISO,
          snoozed_until: null,
          resolved_at: null,
          assigned_to: null,
          resolution_note: null,
        },
      ],
    ]);
    const out = applyStateToAlerts(alerts, states, NOW_ISO);
    expect(out[0]?.unread).toBe(false);
  });

  it("flags snoozed when snoozed_until is in the future", () => {
    const states = new Map<string, AlertState>([
      [
        key,
        {
          read_at: null,
          snoozed_until: isoDaysFromNow(3),
          resolved_at: null,
          assigned_to: null,
          resolution_note: null,
        },
      ],
    ]);
    const out = applyStateToAlerts(alerts, states, NOW_ISO);
    expect(out[0]?.snoozed).toBe(true);
  });

  it("flags resolved when resolved_at is set", () => {
    const states = new Map<string, AlertState>([
      [
        key,
        {
          read_at: NOW_ISO,
          snoozed_until: null,
          resolved_at: NOW_ISO,
          assigned_to: null,
          resolution_note: "Paid in full",
        },
      ],
    ]);
    const out = applyStateToAlerts(alerts, states, NOW_ISO);
    expect(out[0]?.resolved).toBe(true);
    expect(out[0]?.unread).toBe(false);
  });
});

// =====================================================================
// 6. Filtering
// =====================================================================

describe("filterAlerts", () => {
  const alerts = runAlertRules(
    snapshotOf([
      row({
        org: org({ id: "o-1", name: "Alpha Co", mrr_gbp: 1500, health_score: 25 }),
      }),
      row({
        org: org({ id: "o-2", name: "Beta Plc", status: "trial", trial_ends_at: isoDaysFromNow(2) }),
      }),
    ]),
  );

  it("severity=critical hides warning alerts", () => {
    const out = filterAlerts(alerts, { severity: "critical" });
    expect(out.every((a) => a.severity === "critical")).toBe(true);
  });

  it("q matches by customer name", () => {
    const out = filterAlerts(alerts, { q: "alpha" });
    expect(out.every((a) => a.orgName === "Alpha Co")).toBe(true);
  });
});

// =====================================================================
// 7. Migration shape
// =====================================================================

describe("migration 20260608000000 — admin_alert_state", () => {
  it("creates the table with composite uniqueness", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.admin_alert_state/,
    );
    expect(MIGRATION).toMatch(/unique \(rule_id, org_id\)/);
  });

  it("enables RLS with no policies (service-role only)", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.admin_alert_state enable row level security/,
    );
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("indexes the open set and the assignee queue", () => {
    expect(MIGRATION).toMatch(/admin_alert_state_org_idx/);
    expect(MIGRATION).toMatch(/admin_alert_state_open_idx/);
    expect(MIGRATION).toMatch(/admin_alert_state_assignee_idx/);
  });

  it("touch trigger keeps updated_at fresh", () => {
    expect(MIGRATION).toMatch(/_admin_alert_state_touch/);
    expect(MIGRATION).toMatch(/before update on public\.admin_alert_state/);
  });

  it("FK on org_id cascades on org delete", () => {
    expect(MIGRATION).toMatch(/org_id\s+uuid not null references public\.organizations\(id\)\s+on delete cascade/);
  });
});

// =====================================================================
// 8. Server actions
// =====================================================================

describe("alert server actions", () => {
  it("every action gates on HQ access via requireHq()", () => {
    expect(ACTIONS).toMatch(/import \{ requireHq \} from "@\/server\/auth\/hq"/);
    expect(ACTIONS).toMatch(/requireHq\(\)/);
  });

  it("exports every lifecycle action the page wires", () => {
    for (const fn of [
      "markAlertRead",
      "markAlertResolved",
      "snoozeAlert",
      "assignAlert",
      "reopenAlert",
    ]) {
      expect(ACTIONS).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("every action writes admin_activity_log via recordAdminActivity", () => {
    const occurrences = (ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    // 5 actions × at least 1 audit write each. markAlertResolved writes twice
    // (alert state + per-org) so the total floors at 6.
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  it("Zod schemas reject unknown rule ids on every action", () => {
    expect(ACTIONS).toMatch(/z\.enum\(ALERT_RULE_IDS\)/);
  });

  it("snooze presets are bounded (no arbitrary durations)", () => {
    expect(ACTIONS).toMatch(/z\.enum\(\["1d", "3d", "7d", "30d"\]\)/);
  });

  it("UPSERTs by (rule_id, org_id) so re-runs don't duplicate", () => {
    expect(ACTIONS).toMatch(/onConflict: "rule_id,org_id"/);
  });
});

// =====================================================================
// 9. Page wiring
// =====================================================================

describe("/admin/alerts page", () => {
  it("renders the AI COO panel ('Today needs attention')", () => {
    expect(PAGE).toMatch(/Today needs attention/);
    expect(PAGE).toMatch(/pickActionCentre/);
  });

  it("renders every directive button — Call / Email / WhatsApp / Open customer", () => {
    for (const label of ["Call", "Email", "WhatsApp", "Open customer"]) {
      expect(PAGE).toContain(label);
    }
  });

  it("renders lifecycle buttons — Mark resolved / Snooze / Mark read / Reopen", () => {
    for (const label of ["Mark resolved", "Snooze", "Mark read", "Reopen"]) {
      expect(PAGE).toContain(label);
    }
  });

  it("WhatsApp link is built via the shared whatsAppHref helper", () => {
    expect(PAGE).toMatch(/whatsAppHref/);
    expect(PAGE).toMatch(/from "@\/lib\/phone"/);
  });

  it("wires filters for severity, search, sort, and show-resolved", () => {
    expect(PAGE).toMatch(/name="severity"/);
    expect(PAGE).toMatch(/name="q"/);
    expect(PAGE).toMatch(/name="sort"/);
    expect(PAGE).toMatch(/name="show"/);
  });

  it("auto-archives resolved alerts unless ?show=resolved", () => {
    expect(PAGE).toMatch(/showResolved/);
    expect(PAGE).toMatch(/if \(a\.resolved\) return showResolved/);
  });

  it("KPI tiles cover open critical / open warning / unread / resolved 7d", () => {
    expect(PAGE).toMatch(/Open critical/);
    expect(PAGE).toMatch(/Open warning/);
    expect(PAGE).toMatch(/Unread/);
    expect(PAGE).toMatch(/Resolved this week/);
  });
});

// =====================================================================
// 10. Snapshot service shape
// =====================================================================

describe("hq-alerts-snapshot service", () => {
  it("pulls organizations + invoices + imports + import_rows + demos + alert_state in batched IN queries (no N+1)", () => {
    // Service uses untypedAdminTable(name) for tables not yet in
    // the generated Supabase types — match either shape.
    for (const tbl of [
      "organizations",
      "billing_invoices",
      "imports",
      "import_rows",
      "demo_requests",
      "admin_alert_state",
    ]) {
      expect(SNAPSHOT).toMatch(new RegExp(`untypedAdminTable\\("${tbl}"`));
    }
  });

  it("exposes a getOwnerContactsForOrgs helper for the action row", () => {
    expect(SNAPSHOT).toMatch(/export async function getOwnerContactsForOrgs/);
    expect(SNAPSHOT).toMatch(/\.in\("org_id"/);
    expect(SNAPSHOT).toMatch(/role.*owner/);
  });

  it("falls back to live computeHealthScore when health_score column is null", () => {
    expect(SNAPSHOT).toMatch(/computeHealthScore/);
  });
});

// =====================================================================
// 11. HQ_NAV — alerts is no longer Coming soon
// =====================================================================

describe("HQ_NAV — alerts is ready", () => {
  it("alerts entry has no shipsIn flag", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/alerts", label: "Alerts" \}/);
    expect(LAYOUT).not.toMatch(
      /href: "\/admin\/alerts"[^}]*shipsIn: "HQ-5"/,
    );
  });
});
