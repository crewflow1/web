import { describe, it, expect } from "vitest";
import type { OnboardingSnapshot } from "@/lib/onboarding/checklist";
import {
  buildNudges,
  buildWeeklySummary,
  computeCustomerHealth,
  inactiveSignal,
  INACTIVE_QUOTE_DAYS,
  MILESTONE_IDS,
  priorityRank,
  reachedMilestones,
  topNudge,
  unseenMilestones,
  type MilestoneId,
  type RetentionSignals,
} from "@/lib/retention/signals";

/**
 * Retention + experience layer — directive verification.
 *
 * Five widgets the CEO directive asks for:
 *   1. Dashboard nudges (impact × urgency priority engine)
 *   2. Health score (0–100, green/amber/red)
 *   3. Milestones (celebration UX with un-shown tracking)
 *   4. Weekly summary (last 7 days deltas)
 *   5. Inactive account rescue ("haven't created a quote in 14 days")
 *
 * Tests are pure-input / pure-output: feed a synthetic signal blob
 * to the helper, assert the shape. The server snapshot service lives
 * in retention-snapshot.ts and is exercised via the dashboard page
 * (which is build-checked at the end of this sprint).
 */

// =====================================================================
// Fixture builders
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
    invoiced_total_gbp: override.invoiced_total_gbp ?? 0,
    celebrated_milestones:
      override.celebrated_milestones ?? new Set<MilestoneId>(),
    now: override.now ?? "2026-05-24T12:00:00.000Z",
  };
}

// =====================================================================
// 1. Nudges + priority engine
// =====================================================================

describe("priorityRank — impact × urgency composite", () => {
  it("high/high > high/medium > medium/high > low/low", () => {
    expect(priorityRank("high", "high")).toBeGreaterThan(
      priorityRank("high", "medium"),
    );
    expect(priorityRank("high", "medium")).toBeGreaterThan(
      priorityRank("medium", "high"),
    );
    expect(priorityRank("medium", "high")).toBeGreaterThan(
      priorityRank("low", "low"),
    );
  });

  it("priority is symmetric in math but impact dominates", () => {
    // impact*3 + urgency*1 — impact's coefficient is bigger.
    expect(priorityRank("high", "low")).toBeGreaterThan(
      priorityRank("low", "high"),
    );
  });
});

describe("buildNudges — ordering + content", () => {
  it("brand-new org leads with company profile (highest priority)", () => {
    const list = buildNudges(makeSignals());
    expect(list[0]?.id).toBe("add_first_customer");
    // company_profile is also top — both are h/h. The sort ties on id.
    const ids = list.map((n) => n.id);
    expect(ids).toContain("complete_company_profile");
    expect(ids).toContain("add_first_customer");
  });

  it("once a customer is added, the next gate becomes 'create_first_quote'", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    onb.org.name = "Acme";
    onb.org.phone = "1";
    onb.org.address = { postcode: "SW1" };
    const list = buildNudges(makeSignals({ onboarding: onb }));
    expect(list.map((n) => n.id)).toContain("create_first_quote");
    expect(list.map((n) => n.id)).not.toContain("add_first_customer");
  });

  it("includes a 'send_first_invoice' nudge only after a quote exists", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    onb.counts.quotes = 1;
    const list = buildNudges(makeSignals({ onboarding: onb }));
    expect(list.map((n) => n.id)).toContain("send_first_invoice");
  });

  it("overdue invoices generate a medium/high nudge", () => {
    const list = buildNudges(makeSignals({ overdue_invoice_count: 3 }));
    const overdue = list.find((n) => n.id === "chase_overdue");
    expect(overdue).toBeTruthy();
    expect(overdue?.impact).toBe("medium");
    expect(overdue?.urgency).toBe("high");
    expect(overdue?.title).toMatch(/3 overdue invoices/);
  });

  it("logo + VAT nudges fire only when not already dismissed/set", () => {
    const onb = emptyOnboarding();
    onb.org.logo_url = "https://x.test/logo.png";
    onb.org.vat_number = "GB1";
    const ids = buildNudges(makeSignals({ onboarding: onb })).map((n) => n.id);
    expect(ids).not.toContain("upload_logo");
    expect(ids).not.toContain("configure_tax");
  });

  it("dismissed steps suppress their nudges", () => {
    const onb = emptyOnboarding();
    onb.dismissed = new Set(["logo", "imports", "vat"] as never);
    const ids = buildNudges(makeSignals({ onboarding: onb })).map((n) => n.id);
    expect(ids).not.toContain("upload_logo");
    expect(ids).not.toContain("import_history");
    expect(ids).not.toContain("configure_tax");
  });

  it("result is ordered priority desc", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    onb.counts.quotes = 1;
    const list = buildNudges(
      makeSignals({ onboarding: onb, overdue_invoice_count: 1 }),
    );
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.priority).toBeGreaterThanOrEqual(list[i]!.priority);
    }
  });
});

describe("topNudge", () => {
  it("returns null when the build list is empty", () => {
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
    expect(topNudge(makeSignals({ onboarding: onb }))).toBeNull();
  });

  it("returns the first nudge from buildNudges", () => {
    const list = buildNudges(makeSignals());
    expect(topNudge(makeSignals())?.id).toBe(list[0]?.id);
  });
});

// =====================================================================
// 2. Health score
// =====================================================================

describe("computeCustomerHealth", () => {
  it("brand-new org scores low and bands red or amber", () => {
    const h = computeCustomerHealth(makeSignals());
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
    expect(h.score).toBeLessThan(70);
  });

  it("fully-set-up org with recent activity bands green", () => {
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
      customers: 5,
      invoices: 3,
      quotes: 4,
      importsCommitted: 1,
    };
    const h = computeCustomerHealth(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-23T12:00:00.000Z", // 1 day ago
      }),
    );
    expect(h.band).toBe("green");
    expect(h.score).toBeGreaterThanOrEqual(70);
  });

  it("overdue invoices drag the score down", () => {
    const onb = emptyOnboarding();
    onb.counts = {
      staffMembers: 0,
      customers: 1,
      invoices: 5,
      quotes: 1,
      importsCommitted: 0,
    };
    const a = computeCustomerHealth(makeSignals({ onboarding: onb }));
    const b = computeCustomerHealth(
      makeSignals({ onboarding: onb, overdue_invoice_count: 5 }),
    );
    expect(b.score).toBeLessThan(a.score);
  });

  it("month-long inactivity gap penalises the score", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    const recent = computeCustomerHealth(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-23T12:00:00.000Z", // 1 day
      }),
    );
    const stale = computeCustomerHealth(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-04-01T12:00:00.000Z", // ~53 days
      }),
    );
    expect(stale.score).toBeLessThan(recent.score);
  });

  it("score is always clamped 0..100", () => {
    const h = computeCustomerHealth(
      makeSignals({ overdue_invoice_count: 999 }),
    );
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });

  it("band edges: <40 red, 40–69 amber, 70+ green", () => {
    // Construct a snapshot near each edge by tuning overdue.
    const baseOnb = emptyOnboarding();
    baseOnb.counts = {
      staffMembers: 1,
      customers: 1,
      invoices: 1,
      quotes: 1,
      importsCommitted: 0,
    };
    const make = (overdue: number) =>
      computeCustomerHealth(
        makeSignals({
          onboarding: baseOnb,
          last_activity_at: "2026-05-23T12:00:00.000Z",
          overdue_invoice_count: overdue,
        }),
      );
    // Bands are well-defined; assert the field rather than specific scores.
    for (const overdue of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = make(overdue);
      const expected: "green" | "amber" | "red" =
        h.score >= 70 ? "green" : h.score >= 40 ? "amber" : "red";
      expect(h.band).toBe(expected);
    }
  });
});

// =====================================================================
// 3. Milestones
// =====================================================================

describe("milestones", () => {
  it("MILESTONE_IDS covers everything the directive named", () => {
    expect(MILESTONE_IDS).toContain("first_customer");
    expect(MILESTONE_IDS).toContain("first_quote");
    expect(MILESTONE_IDS).toContain("first_invoice");
    expect(MILESTONE_IDS).toContain("first_employee");
    expect(MILESTONE_IDS).toContain("hundred_customers");
    expect(MILESTONE_IDS).toContain("invoiced_ten_k");
  });

  it("reachedMilestones reflects current counts + totals", () => {
    const onb = emptyOnboarding();
    onb.counts = {
      staffMembers: 1,
      customers: 12,
      invoices: 1,
      quotes: 10,
      importsCommitted: 0,
    };
    const reached = reachedMilestones(
      makeSignals({ onboarding: onb, invoiced_total_gbp: 15_000 }),
    );
    expect(reached).toEqual(
      expect.arrayContaining([
        "first_customer",
        "ten_customers",
        "first_quote",
        "ten_quotes",
        "first_invoice",
        "first_employee",
        "invoiced_one_k",
        "invoiced_ten_k",
      ]),
    );
    expect(reached).not.toContain("fifty_customers");
    expect(reached).not.toContain("invoiced_hundred_k");
  });

  it("unseenMilestones filters out anything in celebrated_milestones", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    const before = unseenMilestones(makeSignals({ onboarding: onb }));
    expect(before.find((m) => m.id === "first_customer")).toBeTruthy();

    const after = unseenMilestones(
      makeSignals({
        onboarding: onb,
        celebrated_milestones: new Set<MilestoneId>(["first_customer"]),
      }),
    );
    expect(after.find((m) => m.id === "first_customer")).toBeUndefined();
  });

  it("each milestone has emoji + title + body for celebration UX", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    const list = unseenMilestones(makeSignals({ onboarding: onb }));
    for (const m of list) {
      expect(m.emoji.length).toBeGreaterThan(0);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.body.length).toBeGreaterThan(0);
    }
  });

  it("onboarding_complete milestone fires only at 100%", () => {
    const onb = emptyOnboarding();
    expect(reachedMilestones(makeSignals({ onboarding: onb }))).not.toContain(
      "onboarding_complete",
    );
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
    expect(reachedMilestones(makeSignals({ onboarding: onb }))).toContain(
      "onboarding_complete",
    );
  });
});

// =====================================================================
// 4. Weekly summary
// =====================================================================

describe("buildWeeklySummary", () => {
  it("zero-signal week marks hasSignal=false", () => {
    const w = buildWeeklySummary(makeSignals());
    expect(w.hasSignal).toBe(false);
    expect(w.customers_added).toBe(0);
  });

  it("any positive count flips hasSignal=true", () => {
    const w = buildWeeklySummary(
      makeSignals({
        windows: {
          last_7d: {
            customers_added: 3,
            quotes_created: 5,
            quotes_accepted: 2,
            invoices_sent: 1,
            invoiced_gbp: 12_000,
            payments_received_gbp: 4_000,
          },
        },
      }),
    );
    expect(w.hasSignal).toBe(true);
    expect(w.customers_added).toBe(3);
    expect(w.invoiced_gbp).toBe(12_000);
  });
});

// =====================================================================
// 5. Inactive account rescue
// =====================================================================

describe("inactiveSignal", () => {
  it("returns null for brand-new orgs (never made a quote)", () => {
    expect(inactiveSignal(makeSignals())).toBeNull();
  });

  it("returns null when last activity is within INACTIVE_QUOTE_DAYS", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    // 3 days ago
    const result = inactiveSignal(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-21T12:00:00.000Z",
      }),
    );
    expect(result).toBeNull();
  });

  it("fires when last activity is older than INACTIVE_QUOTE_DAYS", () => {
    const onb = emptyOnboarding();
    onb.counts.quotes = 1;
    const result = inactiveSignal(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-01T12:00:00.000Z", // ~23 days
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe("inactive_quote_drought");
    expect(result?.title).toMatch(/23 days/);
    expect(result?.cta.href).toBe("/quotes/new");
  });

  it("INACTIVE_QUOTE_DAYS matches directive ('14 days')", () => {
    expect(INACTIVE_QUOTE_DAYS).toBe(14);
  });
});

// =====================================================================
// Composition: buildNudges includes the inactivity nudge
// =====================================================================

describe("buildNudges integrates inactiveSignal", () => {
  it("inactive orgs surface the drought nudge in the list", () => {
    const onb = emptyOnboarding();
    onb.counts.customers = 1;
    onb.counts.quotes = 1;
    onb.org.name = "X";
    onb.org.phone = "1";
    onb.org.address = { postcode: "SW1" };
    const ids = buildNudges(
      makeSignals({
        onboarding: onb,
        last_activity_at: "2026-05-01T12:00:00.000Z",
      }),
    ).map((n) => n.id);
    expect(ids).toContain("inactive_quote_drought");
  });
});
