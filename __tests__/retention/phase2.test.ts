import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OnboardingSnapshot } from "@/lib/onboarding/checklist";
import {
  buildNudges,
  computeCustomerHealth,
  INACTIVE_RISK_DAYS,
  INACTIVE_SOFT_DAYS,
  INACTIVE_STRONG_DAYS,
  inactiveSignal,
  inactivitySeverity,
  type MilestoneId,
  type NudgeId,
  type RetentionSignals,
} from "@/lib/retention/signals";

/**
 * Phase 2 — Retention OS verification.
 *
 * The Phase 1-era retention layer (PR #94) shipped the core five
 * widgets. Phase 2 adds:
 *
 *   - Support + alerts inputs to RetentionSignals
 *   - Health score returns `reasons[]` + `actions[]`
 *   - Nudge priority order matching directive's 10-step list
 *   - Persistent nudge dismissal (onboarding_state.dismissed_nudges)
 *   - Inactivity ladder: 7d / 14d / 30d
 *   - Milestone notification + audit log on first crossing
 *     (server-side; idempotent)
 *
 * Source-content + pure-function tests pin every contract.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SNAPSHOT_SRC = read("server/services/retention-snapshot.ts");
const MILESTONES_SRC = read("server/services/retention-milestones.ts");
const ACTIONS_SRC = read("app/(app)/dashboard/_retention-actions.ts");
const PANEL_SRC = read("app/(app)/dashboard/_retention.tsx");
const DASHBOARD_SRC = read("app/(app)/dashboard/page.tsx");

// =====================================================================
// Fixture
// =====================================================================

function emptyOnboarding(): OnboardingSnapshot {
  return {
    org: {
      name: null,
      phone: null,
      email: null,
      vat_number: null,
      logo_url: null,
      bank_details: null,
      default_terms: null,
      address: null,
    },
    counts: {
      staffMembers: 0,
      customers: 0,
      invoices: 0,
      quotes: 0,
      importsCommitted: 0,
    },
    dismissed: new Set(),
    timestamps: { started_at: null, completed_at: null },
  };
}

function makeSignals(
  override: Partial<RetentionSignals> = {},
): RetentionSignals {
  return {
    onboarding: override.onboarding ?? emptyOnboarding(),
    windows: override.windows ?? {
      last_7d: {
        customers_added: 0,
        quotes_created: 0,
        quotes_accepted: 0,
        invoices_sent: 0,
        invoiced_gbp: 0,
        payments_received_gbp: 0,
      },
    },
    last_activity_at: override.last_activity_at ?? null,
    overdue_invoice_count: override.overdue_invoice_count ?? 0,
    support_open_count: override.support_open_count ?? 0,
    unresolved_alerts_count: override.unresolved_alerts_count ?? 0,
    invoiced_total_gbp: override.invoiced_total_gbp ?? 0,
    celebrated_milestones:
      override.celebrated_milestones ?? new Set<MilestoneId>(),
    dismissed_nudges: override.dismissed_nudges ?? new Set<NudgeId>(),
    now: override.now ?? "2026-05-24T12:00:00.000Z",
  };
}

// =====================================================================
// 1. Signals shape extended
// =====================================================================

describe("Phase 2 — RetentionSignals carries support + alerts + dismissed_nudges", () => {
  it("snapshot service queries support_tickets + admin_alert_state", () => {
    expect(SNAPSHOT_SRC).toMatch(/support_tickets/);
    expect(SNAPSHOT_SRC).toMatch(/admin_alert_state/);
    expect(SNAPSHOT_SRC).toMatch(/support_open_count:/);
    expect(SNAPSHOT_SRC).toMatch(/unresolved_alerts_count:/);
  });

  it("snapshot service reads dismissed_nudges from onboarding_state", () => {
    expect(SNAPSHOT_SRC).toMatch(/dismissed_nudges/);
    expect(SNAPSHOT_SRC).toMatch(/DISMISSED_NUDGES_KEY/);
  });
});

// =====================================================================
// 2. Health: reasons + actions
// =====================================================================

describe("Phase 2 — computeCustomerHealth returns reasons + actions", () => {
  it("returns up to 3 reasons + 3 actions", () => {
    const h = computeCustomerHealth(
      makeSignals({
        overdue_invoice_count: 5,
        support_open_count: 2,
      }),
    );
    expect(h.reasons.length).toBeLessThanOrEqual(3);
    expect(h.actions.length).toBeLessThanOrEqual(3);
    expect(h.reasons.length).toBeGreaterThan(0);
    expect(h.actions.length).toBeGreaterThan(0);
  });

  it("ranks reasons by score impact — overdue beats 'no customers'", () => {
    // Set up a near-complete org so the overdue-invoice driver
    // (delta 20) wins over the small "no customers" driver (delta 3).
    const onb = emptyOnboarding();
    onb.org = {
      name: "X",
      phone: "1",
      email: "x@x.co",
      vat_number: "GB1",
      logo_url: "https://x/y.png",
      bank_details: { sort_code: "20-00-00", account_number: "12345678" },
      default_terms: "T",
      address: { postcode: "SW1" },
    };
    onb.counts = {
      staffMembers: 1,
      customers: 1,
      invoices: 1,
      quotes: 1,
      importsCommitted: 1,
    };
    const h = computeCustomerHealth(
      makeSignals({ onboarding: onb, overdue_invoice_count: 5 }),
    );
    expect(h.reasons[0]).toMatch(/overdue/i);
  });

  it("surfaces 'open support ticket' reason when support_open > 0", () => {
    const h = computeCustomerHealth(makeSignals({ support_open_count: 3 }));
    expect(h.reasons.some((r) => /support ticket/i.test(r))).toBe(true);
    expect(h.actions.some((a) => a.href === "/support")).toBe(true);
  });

  it("de-duplicates actions by href", () => {
    // Two reasons could both point to /quotes/new; ensure we only
    // see it once in actions.
    const h = computeCustomerHealth(makeSignals());
    const hrefs = h.actions.map((a) => a.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("support tickets drag the score down", () => {
    const a = computeCustomerHealth(makeSignals());
    const b = computeCustomerHealth(makeSignals({ support_open_count: 4 }));
    expect(b.score).toBeLessThan(a.score);
  });

  it("unresolved alerts drag the score down", () => {
    const a = computeCustomerHealth(makeSignals());
    const b = computeCustomerHealth(
      makeSignals({ unresolved_alerts_count: 5 }),
    );
    expect(b.score).toBeLessThan(a.score);
  });
});

// =====================================================================
// 3. Nudge priority order + new nudges
// =====================================================================

describe("Phase 2 — nudges: priority order + new ids", () => {
  it("introduces add_staff / reply_support / review_alerts / weekly_summary / soft-drought nudges", () => {
    // The unions in lib/retention/signals.ts must include all five.
    const src = read("lib/retention/signals.ts");
    for (const id of [
      "add_staff",
      "reply_support",
      "review_alerts",
      "weekly_summary",
      "inactive_quote_drought_soft",
    ]) {
      expect(src).toMatch(new RegExp(`"${id}"`));
    }
  });

  it("reply_support fires only when support_open > 0", () => {
    const a = buildNudges(makeSignals()).map((n) => n.id);
    expect(a).not.toContain("reply_support");

    const b = buildNudges(makeSignals({ support_open_count: 2 })).map(
      (n) => n.id,
    );
    expect(b).toContain("reply_support");
  });

  it("review_alerts fires only when unresolved_alerts > 0", () => {
    const b = buildNudges(
      makeSignals({ unresolved_alerts_count: 3 }),
    ).map((n) => n.id);
    expect(b).toContain("review_alerts");
  });

  it("add_staff fires when staffMembers === 0 + not dismissed", () => {
    const ids = buildNudges(makeSignals()).map((n) => n.id);
    expect(ids).toContain("add_staff");
  });

  it("dismissed_nudges suppress their nudges", () => {
    const ids = buildNudges(
      makeSignals({
        support_open_count: 2,
        dismissed_nudges: new Set<NudgeId>(["reply_support"]),
      }),
    ).map((n) => n.id);
    expect(ids).not.toContain("reply_support");
  });
});

// =====================================================================
// 4. Inactivity ladder (7 / 14 / 30 days)
// =====================================================================

describe("Phase 2 — inactivity ladder", () => {
  it("exports the three thresholds (7, 14, 30)", () => {
    expect(INACTIVE_SOFT_DAYS).toBe(7);
    expect(INACTIVE_STRONG_DAYS).toBe(14);
    expect(INACTIVE_RISK_DAYS).toBe(30);
  });

  it("inactivitySeverity returns 'ok' for active orgs and brand-new orgs", () => {
    expect(inactivitySeverity(makeSignals())).toBe("ok");

    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    expect(
      inactivitySeverity(
        makeSignals({
          onboarding: onb,
          last_activity_at: "2026-05-23T12:00:00.000Z", // 1 day ago
        }),
      ),
    ).toBe("ok");
  });

  it("'soft' at 7..13 days inactive", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    // 9 days ago
    const sev = inactivitySeverity(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-15T12:00:00.000Z",
      }),
    );
    expect(sev).toBe("soft");
  });

  it("'strong' at 14..29 days inactive", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    // 20 days ago
    const sev = inactivitySeverity(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-04T12:00:00.000Z",
      }),
    );
    expect(sev).toBe("strong");
  });

  it("'risk' at 30+ days inactive", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    // 45 days ago
    const sev = inactivitySeverity(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-04-09T12:00:00.000Z",
      }),
    );
    expect(sev).toBe("risk");
  });

  it("inactiveSignal returns the soft-drought variant at 7..13 days", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    const nudge = inactiveSignal(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-15T12:00:00.000Z",
      }),
    );
    expect(nudge?.id).toBe("inactive_quote_drought_soft");
    expect(nudge?.impact).toBe("medium");
  });

  it("inactiveSignal returns strong variant at 14..29 days", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    const nudge = inactiveSignal(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-04T12:00:00.000Z",
      }),
    );
    expect(nudge?.id).toBe("inactive_quote_drought");
    expect(nudge?.impact).toBe("high");
  });

  it("inactiveSignal upgrades urgency to 'high' at 30+ days (risk)", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    const nudge = inactiveSignal(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-04-09T12:00:00.000Z",
      }),
    );
    expect(nudge?.id).toBe("inactive_quote_drought");
    expect(nudge?.urgency).toBe("high");
    expect(nudge?.body).toMatch(/over a month/i);
  });
});

// =====================================================================
// 5. Milestone notification side effect
// =====================================================================

describe("Phase 2 — milestone notification + audit log", () => {
  it("ensureMilestoneNotifications service exists and is idempotent", () => {
    expect(MILESTONES_SRC).toMatch(/ensureMilestoneNotifications/);
    expect(MILESTONES_SRC).toMatch(/notified_milestones/);
    expect(MILESTONES_SRC).toMatch(/previouslyNotified/);
    expect(MILESTONES_SRC).toMatch(
      /toEmit = reached\.filter\(\(id\) => !previouslyNotified\.has\(id\)\)/,
    );
  });

  it("emits a customer-audience notification per milestone", () => {
    expect(MILESTONES_SRC).toMatch(/audience: "customer"/);
    expect(MILESTONES_SRC).toMatch(/type: `milestone\.\$\{id\}`/);
    expect(MILESTONES_SRC).toMatch(/emitNotifications/);
  });

  it("writes an admin_activity_log row per milestone", () => {
    expect(MILESTONES_SRC).toMatch(/recordAdminActivity/);
    expect(MILESTONES_SRC).toMatch(/action: `milestone\.\$\{id\}`/);
  });

  it("persists the notified set so side effects never repeat", () => {
    expect(MILESTONES_SRC).toMatch(/nextNotified = \[\.\.\.previouslyNotified/);
    expect(MILESTONES_SRC).toMatch(/onboarding_state: nextState/);
  });

  it("is wired into the dashboard server-render", () => {
    expect(DASHBOARD_SRC).toMatch(/ensureMilestoneNotifications/);
  });

  it("errors are swallowed (dashboard never crashes on a milestone failure)", () => {
    expect(MILESTONES_SRC).toMatch(
      /catch \(e\) \{[\s\S]*\[retention-milestones\] ensure failed/,
    );
  });
});

// =====================================================================
// 6. Persistent nudge dismissal
// =====================================================================

describe("Phase 2 — dismissNudge server action", () => {
  it("writes to onboarding_state.dismissed_nudges (no schema change)", () => {
    expect(ACTIONS_SRC).toMatch(/export async function dismissNudge/);
    expect(ACTIONS_SRC).toMatch(/dismissed_nudges/);
    expect(ACTIONS_SRC).toMatch(/onboarding_state/);
  });

  it("rejects unknown / non-dismissible nudge ids silently", () => {
    expect(ACTIONS_SRC).toMatch(/DISMISSIBLE_NUDGES/);
    expect(ACTIONS_SRC).toMatch(
      /if \(!\(DISMISSIBLE_NUDGES as ReadonlyArray<string>\)\.includes\(id\)\) return;/,
    );
  });

  it("retention panel renders a dismiss button per non-primary nudge", () => {
    expect(PANEL_SRC).toMatch(/<form action=\{dismissNudge\}/);
    expect(PANEL_SRC).toMatch(/name="nudge_id"/);
  });
});

// =====================================================================
// 7. Health drivers surface "Why" + "Actions" in the UI
// =====================================================================

describe("Phase 2 — health panel UI surfaces reasons + actions", () => {
  it("renders the Why list when health.reasons is non-empty", () => {
    expect(PANEL_SRC).toMatch(/health\.reasons\.length > 0/);
    expect(PANEL_SRC).toMatch(/health\.reasons\.map/);
  });

  it("renders the Actions row when health.actions is non-empty", () => {
    expect(PANEL_SRC).toMatch(/health\.actions\.length > 0/);
    expect(PANEL_SRC).toMatch(/health\.actions\.map/);
  });

  it("includes support_open in the driver subtitle", () => {
    expect(PANEL_SRC).toMatch(/support_open > 0/);
  });
});
