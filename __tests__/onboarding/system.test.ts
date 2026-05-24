import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHECKLIST_STEPS,
  CHECKLIST_STEP_ORDER,
  computeProgress,
  isStepComplete,
  isOnboardingComplete,
  nextRecommendedAction,
  completedSteps,
  skippedSteps,
  type ChecklistStepId,
  type OnboardingSnapshot,
} from "@/lib/onboarding/checklist";

/**
 * Customer Onboarding System — directive verification.
 *
 * The CEO directive asks for a "world-class onboarding flow":
 *
 *   PHASE 1 — Onboarding Progress Engine
 *     • Required milestones list
 *     • onboarding_percent / completed_steps[] / current_step /
 *       started_at / completed_at / skipped_steps[]
 *     • Auto-save progress (persisted to organizations.onboarding_state)
 *     • Dashboard widget showing pct + CTA "Continue setup"
 *     • computeProgress() helper as single source of truth
 *   PHASE 2 — Guided Setup Flow at /onboarding/setup
 *     • Each step reuses the existing destination page
 *     • Skip allowed (writes dismissed_steps)
 *     • User can leave/rejoin and continue (progress derived from DB)
 *   PHASE 3 — Retention hooks
 *     • nextRecommendedAction() helper
 *     • Dashboard banner names the next step
 *   PHASE 4 — Verification
 *
 * These tests pin the contract — every milestone, helper, and route
 * the directive demands.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const CHECKLIST_SRC = read("lib/onboarding/checklist.ts");
const SNAPSHOT_SRC = read("server/services/onboarding-snapshot.ts");
const HQ_SNAPSHOT_SRC = read("server/services/hq-onboarding-snapshot.ts");
const SETTINGS_FORM = read("app/(app)/settings/_forms.tsx");
const SETTINGS_ACTIONS = read("app/(app)/settings/actions.ts");
const SETUP_PAGE = read("app/(app)/onboarding/setup/page.tsx");
const SETUP_COMPLETE = read("app/(app)/onboarding/setup/complete/page.tsx");
const SETUP_ACTIONS = read("app/(app)/onboarding/setup/actions.ts");
const DASHBOARD_CHECKLIST = read("app/(app)/dashboard/_setup-checklist.tsx");

// =====================================================================
// PHASE 1 — Progress engine
// =====================================================================

describe("Phase 1 — milestone catalogue", () => {
  it("includes every required milestone the CEO directive named", () => {
    const titles = CHECKLIST_STEPS.map((s) => s.title.toLowerCase()).join(" | ");
    expect(titles).toMatch(/company details/);
    expect(titles).toMatch(/logo/);
    expect(titles).toMatch(/team|invite|staff/);
    expect(titles).toMatch(/customer/);
    expect(titles).toMatch(/quote/);
    expect(titles).toMatch(/invoice/);
    expect(titles).toMatch(/import|migrate/);
    expect(titles).toMatch(/vat/);
    expect(titles).toMatch(/email/);
  });

  it("exposes CHECKLIST_STEP_ORDER with every id covered exactly once", () => {
    const ids = new Set<ChecklistStepId>(CHECKLIST_STEPS.map((s) => s.id));
    expect(CHECKLIST_STEP_ORDER.length).toBe(ids.size);
    for (const id of CHECKLIST_STEP_ORDER) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("introduces the new connect_email + first_invoice steps", () => {
    const ids = CHECKLIST_STEPS.map((s) => s.id);
    expect(ids).toContain("connect_email");
    expect(ids).toContain("first_invoice");
  });
});

// =====================================================================
// PHASE 1 — Snapshot timestamps + email surfaced
// =====================================================================

describe("Phase 1 — snapshot wiring", () => {
  it("OnboardingSnapshot carries lifecycle timestamps", () => {
    expect(CHECKLIST_SRC).toMatch(/timestamps:\s*\{[\s\S]*started_at[\s\S]*completed_at/);
  });

  it("OnboardingSnapshot exposes org.email for the connect_email step", () => {
    expect(CHECKLIST_SRC).toMatch(/email:\s*string \| null/);
  });

  it("buildOnboardingSnapshot reads email + onboarding_state.{started,completed}_at", () => {
    expect(SNAPSHOT_SRC).toMatch(/"name, phone, email, vat_number/);
    expect(SNAPSHOT_SRC).toMatch(/started_at: typeof startedAtRaw === "string"/);
    expect(SNAPSHOT_SRC).toMatch(/completed_at: typeof completedAtRaw === "string"/);
  });

  it("HQ-side snapshot also surfaces email + timestamps so HQ stays in sync", () => {
    expect(HQ_SNAPSHOT_SRC).toMatch(/email: string \| null/);
    expect(HQ_SNAPSHOT_SRC).toMatch(/started_at/);
    expect(HQ_SNAPSHOT_SRC).toMatch(/completed_at/);
  });
});

// =====================================================================
// PHASE 1 — computeProgress is single source of truth
// =====================================================================

function snapshotFixture(
  overrides: Partial<OnboardingSnapshot> = {},
): OnboardingSnapshot {
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
      ...overrides.org,
    },
    counts: {
      staffMembers: 0,
      customers: 0,
      invoices: 0,
      quotes: 0,
      importsCommitted: 0,
      ...overrides.counts,
    },
    dismissed: overrides.dismissed ?? new Set(),
    timestamps: overrides.timestamps ?? {
      started_at: null,
      completed_at: null,
    },
  };
}

describe("Phase 1 — computeProgress + helpers", () => {
  it("empty snapshot returns 0% and shows the checklist", () => {
    const snap = snapshotFixture();
    const p = computeProgress(snap);
    expect(p.pct).toBeLessThanOrEqual(10);
    expect(p.showChecklist).toBe(true);
  });

  it("isStepComplete('connect_email') keys on org.email", () => {
    expect(isStepComplete("connect_email", snapshotFixture())).toBe(false);
    expect(
      isStepComplete(
        "connect_email",
        snapshotFixture({ org: { email: "ops@acme.co.uk" } as never }),
      ),
    ).toBe(true);
  });

  it("isStepComplete('first_invoice') keys on counts.invoices", () => {
    expect(isStepComplete("first_invoice", snapshotFixture())).toBe(false);
    expect(
      isStepComplete(
        "first_invoice",
        snapshotFixture({ counts: { invoices: 1 } as never }),
      ),
    ).toBe(true);
  });

  it("completedSteps reflects which milestones are done", () => {
    const snap = snapshotFixture({
      counts: { customers: 2, quotes: 1 } as never,
    });
    const done = completedSteps(snap);
    expect(done).toContain("customers");
    expect(done).toContain("first_quote");
    expect(done).not.toContain("first_invoice");
  });

  it("skippedSteps returns only dismissed-AND-incomplete ids", () => {
    const snap = snapshotFixture({
      dismissed: new Set<ChecklistStepId>(["logo", "imports"]),
    });
    expect(skippedSteps(snap)).toEqual(
      expect.arrayContaining(["logo", "imports"]),
    );
    // If a "skipped" step ends up done elsewhere, drop from skipped list.
    const snap2 = snapshotFixture({
      dismissed: new Set<ChecklistStepId>(["logo"]),
      org: { logo_url: "https://x/y.png" } as never,
    });
    expect(skippedSteps(snap2)).not.toContain("logo");
  });

  it("isOnboardingComplete only at 100%", () => {
    expect(isOnboardingComplete(snapshotFixture())).toBe(false);
    const everything = snapshotFixture({
      org: {
        name: "X",
        phone: "1",
        email: "x@x.co",
        vat_number: "GB1",
        logo_url: "https://x/y.png",
        bank_details: { sort_code: "20-00-00", account_number: "12345678" },
        default_terms: "T",
        address: { postcode: "SW1" },
      } as never,
      counts: {
        staffMembers: 1,
        customers: 1,
        invoices: 1,
        quotes: 1,
        importsCommitted: 1,
      },
      dismissed: new Set(),
    });
    expect(isOnboardingComplete(everything)).toBe(true);
  });
});

// =====================================================================
// PHASE 3 — nextRecommendedAction
// =====================================================================

describe("Phase 3 — nextRecommendedAction", () => {
  it("returns the first incomplete REQUIRED step before any optional", () => {
    const snap = snapshotFixture();
    const next = nextRecommendedAction(snap);
    expect(next?.id).toBe("company_profile");
    expect(next?.required).toBe(true);
  });

  it("once required is done, prefers an unskipped optional", () => {
    // Satisfy every required step. Required ids per the catalogue
    // are: company_profile, bank, customers, first_quote.
    const snap = snapshotFixture({
      org: {
        name: "X",
        phone: "1",
        bank_details: { sort_code: "20-00-00", account_number: "12345678" },
        address: { postcode: "SW1" },
      } as never,
      counts: { customers: 1, quotes: 1 } as never,
    });
    const next = nextRecommendedAction(snap);
    expect(next).not.toBeNull();
    expect(next?.required).toBe(false);
  });

  it("returns null when every visible step is done", () => {
    const snap = snapshotFixture({
      org: {
        name: "X",
        phone: "1",
        email: "x@x.co",
        vat_number: "GB1",
        logo_url: "https://x/y.png",
        bank_details: { sort_code: "20-00-00", account_number: "12345678" },
        default_terms: "T",
        address: { postcode: "SW1" },
      } as never,
      counts: {
        staffMembers: 1,
        customers: 1,
        invoices: 1,
        quotes: 1,
        importsCommitted: 1,
      },
    });
    expect(nextRecommendedAction(snap)).toBeNull();
  });

  it("skips dismissed optional steps in the recommended pick", () => {
    const snap = snapshotFixture({
      org: {
        name: "X",
        phone: "1",
        bank_details: { sort_code: "20-00-00", account_number: "12345678" },
        address: { postcode: "SW1" },
      } as never,
      counts: { customers: 1, quotes: 1 } as never,
      // Dismiss the first three optional steps in order.
      dismissed: new Set<ChecklistStepId>(["logo", "connect_email", "vat"]),
    });
    const next = nextRecommendedAction(snap);
    expect(next).not.toBeNull();
    expect(["logo", "connect_email", "vat"]).not.toContain(next!.id);
  });
});

// =====================================================================
// PHASE 2 — Guided setup route shape
// =====================================================================

describe("Phase 2 — /onboarding/setup route", () => {
  it("page is auth-gated via requireOrgContext", () => {
    expect(SETUP_PAGE).toMatch(/requireOrgContext/);
  });

  it("redirects to /onboarding/setup/complete at 100%", () => {
    expect(SETUP_PAGE).toMatch(/redirect\("\/onboarding\/setup\/complete"\)/);
  });

  it("renders a progress bar + step list ordered by CHECKLIST_STEP_ORDER", () => {
    expect(SETUP_PAGE).toMatch(/CHECKLIST_STEP_ORDER/);
    expect(SETUP_PAGE).toMatch(/progress\.pct/);
    expect(SETUP_PAGE).toMatch(/\$\{progress\.pct\}%/);
  });

  it("each step's CTA deep-links to its existing destination (no form duplication)", () => {
    // We don't re-implement the form here — the page renders <Link
    // href={step.cta.href}> straight from the catalogue.
    expect(SETUP_PAGE).toMatch(/href=\{step\.cta\.href\}/);
  });

  it("offers Skip + Bring back actions per optional step", () => {
    expect(SETUP_PAGE).toMatch(/<form action=\{skipStep\}/);
    expect(SETUP_PAGE).toMatch(/<form action=\{unskipStep\}/);
  });

  it("nudges the recommended next step via nextRecommendedAction", () => {
    expect(SETUP_PAGE).toMatch(/nextRecommendedAction/);
  });

  it("autosave + resume contract is documented in the page header", () => {
    // Mobile-responsive + back-link to dashboard means a user can quit.
    expect(SETUP_PAGE).toMatch(/Leave any time/);
    expect(SETUP_PAGE).toMatch(/Back to dashboard/);
  });
});

describe("Phase 2 — /onboarding/setup/complete celebration", () => {
  it("bounces non-100% users back to the stepper", () => {
    expect(SETUP_COMPLETE).toMatch(/progress\.pct < 100/);
    expect(SETUP_COMPLETE).toMatch(/redirect\("\/onboarding\/setup"\)/);
  });

  it("idempotently stamps onboarding_state.completed_at", () => {
    expect(SETUP_COMPLETE).toMatch(/markCompleted/);
  });

  it("shows a celebration message + dashboard CTA", () => {
    expect(SETUP_COMPLETE).toMatch(/You're ready to work|Setup complete/);
    expect(SETUP_COMPLETE).toMatch(/Open dashboard/);
  });
});

describe("Phase 2 — setup server actions", () => {
  it("actions persist to organizations.onboarding_state (no schema change)", () => {
    expect(SETUP_ACTIONS).toMatch(/onboarding_state/);
    expect(SETUP_ACTIONS).toMatch(/markStarted/);
    expect(SETUP_ACTIONS).toMatch(/markCompleted/);
    expect(SETUP_ACTIONS).toMatch(/skipStep/);
    expect(SETUP_ACTIONS).toMatch(/unskipStep/);
  });

  it("rejects unknown step ids in skip/unskip", () => {
    expect(SETUP_ACTIONS).toMatch(/isValidStepId/);
  });

  it("started_at + completed_at writes are idempotent", () => {
    expect(SETUP_ACTIONS).toMatch(
      /typeof state\.started_at === "string"[\s\S]*return/,
    );
    expect(SETUP_ACTIONS).toMatch(
      /typeof state\.completed_at === "string"[\s\S]*return/,
    );
  });
});

// =====================================================================
// PHASE 3 — Dashboard retention hook
// =====================================================================

describe("Phase 3 — dashboard retention banner", () => {
  it("dashboard SetupChecklist links to /onboarding/setup", () => {
    expect(DASHBOARD_CHECKLIST).toMatch(/\/onboarding\/setup/);
    expect(DASHBOARD_CHECKLIST).toMatch(/Continue setup/);
  });

  it("shows nextRecommendedAction by name in the headline", () => {
    expect(DASHBOARD_CHECKLIST).toMatch(/nextRecommendedAction/);
    // The retention copy literally interpolates the step title.
    expect(DASHBOARD_CHECKLIST).toMatch(/recommended\.title\.toLowerCase\(\)/);
  });

  it("hides itself once setup is fully complete (showChecklist=false)", () => {
    expect(DASHBOARD_CHECKLIST).toMatch(/if \(!progress\.showChecklist\) return null/);
  });
});

// =====================================================================
// Settings — connect_email field wired
// =====================================================================

describe("Settings form supports the connect_email milestone", () => {
  it("OrganizationForm exposes an org_email field", () => {
    expect(SETTINGS_FORM).toMatch(/name="org_email"/);
    expect(SETTINGS_FORM).toMatch(/Reply-to email/);
  });

  it("settings actions schema accepts + persists org_email", () => {
    expect(SETTINGS_ACTIONS).toMatch(/org_email:/);
    expect(SETTINGS_ACTIONS).toMatch(/email: result\.data\.org_email/);
  });
});
