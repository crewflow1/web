import { describe, it, expect } from "vitest";
import {
  ALERT_RULE_IDS,
  ALERT_RULE_SEVERITY,
  THRESHOLDS,
  runAlertRules,
  type AlertSnapshotRow,
  type AlertOrg,
  type AlertDemo,
  type AlertsSnapshot,
} from "@/lib/hq/alert-rules";

/**
 * HQ-12 — new alert rules (positive + negative cases).
 *
 *   subscription_cancelled  (critical)
 *   support_urgent_open     (critical)
 *   demo_not_contacted      (warning)
 *   no_login_after_signup   (warning)
 *
 * The HQ-5 rules engine grows additively; existing rules stay
 * exactly as they were.
 */

const NOW = new Date("2026-05-24T12:00:00Z");
const NOW_ISO = NOW.toISOString();

function isoDaysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function org(over: Partial<AlertOrg> = {}): AlertOrg {
  return {
    id: "org-1",
    name: "Test Co",
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
    ...over,
  };
}

function row(over: Partial<AlertSnapshotRow> = {}): AlertSnapshotRow {
  return {
    org: org(over.org),
    invoices: overrides_or_default(over.invoices, []),
    imports: overrides_or_default(over.imports, []),
    demos: overrides_or_default(over.demos, []),
  };
}
function overrides_or_default<T>(v: T | undefined, d: T): T {
  return v === undefined ? d : v;
}

const demo = (over: Partial<AlertDemo> = {}): AlertDemo => ({
  id: "d1",
  org_id: "org-1",
  email: "lead@example.com",
  company: "Acme Co",
  status: "pending_demo",
  booked_at: null,
  created_at: isoDaysAgo(5),
  ...over,
});

function snap(rows: AlertSnapshotRow[]): AlertsSnapshot {
  return { rows, now: NOW_ISO };
}

// =====================================================================
// Registry sanity
// =====================================================================

describe("HQ-12 rule registry", () => {
  it("registers the 4 new rule ids", () => {
    for (const id of [
      "subscription_cancelled",
      "support_urgent_open",
      "demo_not_contacted",
      "no_login_after_signup",
    ]) {
      expect(ALERT_RULE_IDS).toContain(id);
    }
  });

  it("severities: 2 critical (subscription_cancelled, support_urgent_open) + 2 warning (demo_not_contacted, no_login_after_signup)", () => {
    expect(ALERT_RULE_SEVERITY.subscription_cancelled).toBe("critical");
    expect(ALERT_RULE_SEVERITY.support_urgent_open).toBe("critical");
    expect(ALERT_RULE_SEVERITY.demo_not_contacted).toBe("warning");
    expect(ALERT_RULE_SEVERITY.no_login_after_signup).toBe("warning");
  });

  it("THRESHOLDS adds demoNotContactedDays + noLoginAfterSignupDays", () => {
    expect(THRESHOLDS.demoNotContactedDays).toBe(3);
    expect(THRESHOLDS.noLoginAfterSignupDays).toBe(3);
  });
});

// =====================================================================
// subscription_cancelled
// =====================================================================

describe("subscription_cancelled", () => {
  it("fires when org.status='cancelled' AND cancelled within 90d", () => {
    const r = row({
      org: org({
        status: "cancelled",
        cancelled_at: isoDaysAgo(10),
      }),
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).toContain("subscription_cancelled");
  });

  it("does NOT fire for ancient cancellations (>90d)", () => {
    const r = row({
      org: org({
        status: "cancelled",
        cancelled_at: isoDaysAgo(120),
      }),
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).not.toContain("subscription_cancelled");
  });

  it("does NOT fire for active customers", () => {
    const r = row({
      org: org({ status: "active", cancelled_at: null }),
    });
    expect(
      runAlertRules(snap([r])).map((a) => a.ruleId),
    ).not.toContain("subscription_cancelled");
  });
});

// =====================================================================
// support_urgent_open
// =====================================================================

describe("support_urgent_open", () => {
  it("fires when org carries an urgent_support_count side-channel > 0", () => {
    const r = row({
      org: { ...org(), urgent_support_count: 2 } as AlertOrg & {
        urgent_support_count: number;
      },
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).toContain("support_urgent_open");
  });

  it("stays silent when no urgent support count attached", () => {
    const r = row();
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).not.toContain("support_urgent_open");
  });
});

// =====================================================================
// demo_not_contacted
// =====================================================================

describe("demo_not_contacted", () => {
  it("fires for a demo > 3 days old in pending_demo", () => {
    const r = row({
      demos: [demo({ created_at: isoDaysAgo(5) })],
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).toContain("demo_not_contacted");
  });

  it("also fires for stale demo_booked", () => {
    const r = row({
      demos: [demo({ status: "demo_booked", created_at: isoDaysAgo(5) })],
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).toContain("demo_not_contacted");
  });

  it("does NOT fire for fresh demos (< 3 days)", () => {
    const r = row({
      demos: [demo({ created_at: isoDaysAgo(1) })],
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).not.toContain("demo_not_contacted");
  });

  it("does NOT fire for demos already contacted (status=contacted / won / lost)", () => {
    const r = row({
      demos: [demo({ status: "contacted", created_at: isoDaysAgo(10) })],
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).not.toContain("demo_not_contacted");
  });
});

// =====================================================================
// no_login_after_signup
// =====================================================================

describe("no_login_after_signup", () => {
  it("fires for active org, never logged in, signed up > 3 days ago", () => {
    const r = row({
      org: org({
        status: "active",
        last_login_at: null,
        created_at: isoDaysAgo(7),
      }),
    });
    const ids = runAlertRules(snap([r])).map((a) => a.ruleId);
    expect(ids).toContain("no_login_after_signup");
  });

  it("also fires for trial customers", () => {
    const r = row({
      org: org({
        status: "trial",
        last_login_at: null,
        created_at: isoDaysAgo(5),
      }),
    });
    expect(runAlertRules(snap([r])).map((a) => a.ruleId)).toContain(
      "no_login_after_signup",
    );
  });

  it("does NOT fire when last_login_at is set", () => {
    const r = row({
      org: org({
        status: "active",
        last_login_at: isoDaysAgo(1),
        created_at: isoDaysAgo(10),
      }),
    });
    expect(runAlertRules(snap([r])).map((a) => a.ruleId)).not.toContain(
      "no_login_after_signup",
    );
  });

  it("does NOT fire in the first 3 days (natural ramp)", () => {
    const r = row({
      org: org({
        status: "active",
        last_login_at: null,
        created_at: isoDaysAgo(1),
      }),
    });
    expect(runAlertRules(snap([r])).map((a) => a.ruleId)).not.toContain(
      "no_login_after_signup",
    );
  });

  it("does NOT fire for cancelled/suspended orgs", () => {
    const r = row({
      org: org({
        status: "cancelled",
        last_login_at: null,
        created_at: isoDaysAgo(10),
      }),
    });
    expect(runAlertRules(snap([r])).map((a) => a.ruleId)).not.toContain(
      "no_login_after_signup",
    );
  });
});
