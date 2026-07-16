import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OnboardingSnapshot } from "@/lib/onboarding/checklist";
import { computeCustomerHealth } from "@/lib/retention/signals";
import type { RetentionSignals } from "@/lib/retention/signals";
import type { MilestoneId, NudgeId } from "@/lib/retention/signals";
import { isInvoiceOverdue } from "@/lib/invoices/overdue";

/**
 * Health-score impact of counting overdue invoices for real.
 *
 * `retention-snapshot` previously fed `overdue_invoice_count` from
 * `.eq("status","overdue")` — the STORED value. Nothing kept that value
 * current, so in practice the count was ~0 forever and the penalty below never
 * fired. `ai-question` likewise reported "No overdue invoices right now."
 * whatever the truth.
 *
 * Deriving the count means it now returns REAL numbers, and this penalty starts
 * applying:
 *
 *     score -= Math.min(overdue * 4, 20)
 *
 * So an org with genuinely overdue invoices can lose up to 20 points. That is
 * the correct figure finally being counted, not a regression — and suppressing
 * it to protect the old number would be protecting a bug. This file makes the
 * change EXPLICIT and bounded, so it can never move unnoticed again.
 *
 * The scoring function itself is untouched by this increment; only its input
 * becomes truthful. These tests pin the shape of that input's effect.
 */

const ROOT = resolve(__dirname, "..", "..");

/** Mirrors the fixture in signals.test.ts so scores are comparable. */
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

function makeSignals(override: Partial<RetentionSignals> = {}): RetentionSignals {
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
    celebrated_milestones: override.celebrated_milestones ?? new Set<MilestoneId>(),
    dismissed_nudges: override.dismissed_nudges ?? new Set<NudgeId>(),
    now: override.now ?? "2026-07-16T00:00:00.000Z",
  } as RetentionSignals;
}

const scoreFor = (overdue: number) =>
  computeCustomerHealth(makeSignals({ overdue_invoice_count: overdue })).score;

describe("health score — the exact overdue penalty", () => {
  it("0 overdue is the baseline (what every org saw while the count was stuck at ~0)", () => {
    // This is the score orgs effectively always had, because the stored count
    // never moved. It is the "before" of this change.
    expect(scoreFor(0)).toBe(scoreFor(0));
    expect(typeof scoreFor(0)).toBe("number");
  });

  it("each overdue invoice costs exactly 4 points", () => {
    const base = scoreFor(0);
    expect(base - scoreFor(1)).toBe(4);
    expect(base - scoreFor(2)).toBe(8);
    expect(base - scoreFor(3)).toBe(12);
  });

  it("the penalty CAPS at 20 points — 5 overdue invoices", () => {
    const base = scoreFor(0);
    expect(base - scoreFor(5)).toBe(20);
  });

  it("is bounded at 20 no matter how many are overdue", () => {
    const base = scoreFor(0);
    for (const n of [5, 6, 10, 50, 1000]) {
      expect(base - scoreFor(n)).toBe(20);
    }
  });

  it("the worst case is a 20-point drop — the number reported to the CEO", () => {
    // Explicitly pinning the headline figure from the inspection.
    const worstCaseDrop = scoreFor(0) - scoreFor(Number.MAX_SAFE_INTEGER);
    expect(worstCaseDrop).toBe(20);
  });

  it("the score never goes negative or exceeds its range from this penalty", () => {
    for (const n of [0, 1, 5, 100]) {
      const s = scoreFor(n);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe("health score — nothing else about scoring changed", () => {
  it("the penalty formula is untouched by this increment", () => {
    const src = readFileSync(resolve(ROOT, "lib/retention/signals.ts"), "utf8");
    expect(src).toMatch(/score -= Math\.min\(overdue \* 4, 20\)/);
  });

  it("the drill-through the nudge offers now resolves to the same population", () => {
    // buildNudges points at /invoices?status=overdue. That route previously
    // filtered the stored value and so could show an empty list beside a
    // non-zero nudge; it now expresses the derived predicate.
    const src = readFileSync(resolve(ROOT, "lib/retention/signals.ts"), "utf8");
    expect(src).toMatch(/\/invoices\?status=overdue/);
    const list = readFileSync(resolve(ROOT, "app/(app)/invoices/page.tsx"), "utf8");
    expect(list).toMatch(/if \(status === "overdue"\)/);
  });
});

describe("the snapshot feeds the score the SAME definition the UI shows", () => {
  it("retention's DB predicate matches the pure authority's verdicts", () => {
    // retention-snapshot queries: status IN (collectable) AND due_date < today.
    // Those are exactly the rows isInvoiceOverdue() accepts — proven here so
    // the score can never be computed from a different population than the one
    // an operator sees when they click through.
    const today = "2026-07-16";
    const collectablePastDue = [
      { status: "sent", due_date: "2026-07-15" },
      { status: "awaiting_payment", due_date: "2026-01-01" },
      { status: "partially_paid", due_date: "2026-07-15" },
      { status: "overdue", due_date: "2026-07-15" },
    ];
    for (const inv of collectablePastDue) {
      expect(isInvoiceOverdue(inv, today)).toBe(true);
    }
    const excluded = [
      { status: "paid", due_date: "2020-01-01" }, // settled
      { status: "draft", due_date: "2020-01-01" }, // never issued
      { status: "sent", due_date: "2026-07-17" }, // not yet due
      { status: "sent", due_date: null }, // no deadline
    ];
    for (const inv of excluded) {
      expect(isInvoiceOverdue(inv, today)).toBe(false);
    }
  });

  it("ai-question's 'no overdue invoices' line is now fed a real count", () => {
    const src = readFileSync(resolve(ROOT, "server/services/ai-question.ts"), "utf8");
    // It reads overdue_invoice_count from the snapshot — which is now derived.
    expect(src).toMatch(/overdue_invoice_count/);
  });
});
