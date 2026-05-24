import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHECKLIST_STEPS,
  isStepComplete,
  computeProgress,
  type OnboardingSnapshot,
  type ChecklistStepId,
} from "@/lib/onboarding/checklist";

/**
 * Onboarding checklist contract tests.
 *
 * Pins the 10-step state machine the dashboard depends on. Each step's
 * `isStepComplete` rule is exercised against synthetic snapshots so a
 * future refactor can't silently mark something done that isn't.
 *
 * Also confirms the /access-pending lock screen has dedicated copy for
 * the `cancelled` status — without it the page falls through to
 * pending copy and a cancelled customer sees the wrong message.
 */

function emptySnapshot(): OnboardingSnapshot {
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
    dismissed: new Set<ChecklistStepId>(),
    timestamps: { started_at: null, completed_at: null },
  };
}

describe("CHECKLIST_STEPS shape", () => {
  it("contains exactly 12 steps after the customer-onboarding sprint", () => {
    // Original directive Part 3 listed 10 steps. The customer-
    // onboarding sprint added `connect_email` and `first_invoice`
    // (also CEO-directive items) — total 12.
    expect(CHECKLIST_STEPS.length).toBe(12);
  });

  it("step ids are unique", () => {
    const ids = CHECKLIST_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every step has a heading + description + CTA + required flag", () => {
    for (const step of CHECKLIST_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(0);
      expect(step.cta.label.length).toBeGreaterThan(0);
      expect(step.cta.href.startsWith("/")).toBe(true);
      expect(typeof step.required).toBe("boolean");
    }
  });

  it("at least one step is required (so dismiss-everything can't bypass setup)", () => {
    expect(CHECKLIST_STEPS.some((s) => s.required)).toBe(true);
  });
});

describe("isStepComplete — per-step rules", () => {
  it("company_profile: needs name + phone + postcode", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("company_profile", snap)).toBe(false);

    snap.org.name = "Sarah Build Ltd";
    expect(isStepComplete("company_profile", snap)).toBe(false);

    snap.org.phone = "07700 900222";
    expect(isStepComplete("company_profile", snap)).toBe(false);

    snap.org.address = { postcode: "BT15 1AA" };
    expect(isStepComplete("company_profile", snap)).toBe(true);
  });

  it("logo: needs a non-empty URL", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("logo", snap)).toBe(false);
    snap.org.logo_url = "";
    expect(isStepComplete("logo", snap)).toBe(false);
    snap.org.logo_url = "https://example.com/logo.png";
    expect(isStepComplete("logo", snap)).toBe(true);
  });

  it("vat: needs a non-empty vat_number", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("vat", snap)).toBe(false);
    snap.org.vat_number = "GB123456789";
    expect(isStepComplete("vat", snap)).toBe(true);
  });

  it("bank: needs sort_code + account_number (jsonb)", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("bank", snap)).toBe(false);

    snap.org.bank_details = { name: "Sarah Build Ltd" };
    expect(isStepComplete("bank", snap)).toBe(false);

    snap.org.bank_details = { sort_code: "20-00-00" };
    expect(isStepComplete("bank", snap)).toBe(false);

    snap.org.bank_details = { sort_code: "20-00-00", account_number: "12345678" };
    expect(isStepComplete("bank", snap)).toBe(true);
  });

  it("terms: needs non-empty default_terms", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("terms", snap)).toBe(false);
    snap.org.default_terms = "Payment due in 30 days.";
    expect(isStepComplete("terms", snap)).toBe(true);
  });

  it("staff: counts only NON-owner memberships", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("staff", snap)).toBe(false);
    snap.counts.staffMembers = 1;
    expect(isStepComplete("staff", snap)).toBe(true);
  });

  it("customers: at least one customer row", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("customers", snap)).toBe(false);
    snap.counts.customers = 1;
    expect(isStepComplete("customers", snap)).toBe(true);
  });

  it("imports: only COMMITTED imports count", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("imports", snap)).toBe(false);
    snap.counts.importsCommitted = 1;
    expect(isStepComplete("imports", snap)).toBe(true);
  });

  it("invoices_import: at least one invoice", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("invoices_import", snap)).toBe(false);
    snap.counts.invoices = 1;
    expect(isStepComplete("invoices_import", snap)).toBe(true);
  });

  it("first_quote: at least one quote", () => {
    const snap = emptySnapshot();
    expect(isStepComplete("first_quote", snap)).toBe(false);
    snap.counts.quotes = 1;
    expect(isStepComplete("first_quote", snap)).toBe(true);
  });
});

describe("computeProgress — visibility + percentage", () => {
  it("brand-new org shows all 12 steps at 0%", () => {
    // 12 = original 10 directive steps + connect_email + first_invoice
    // added in the customer-onboarding sprint.
    const progress = computeProgress(emptySnapshot());
    expect(progress.done).toBe(0);
    expect(progress.total).toBe(12);
    expect(progress.pct).toBe(0);
    expect(progress.showChecklist).toBe(true);
    expect(progress.steps.length).toBe(12);
  });

  it("fully-set-up org hides the checklist (showChecklist=false)", () => {
    const snap: OnboardingSnapshot = {
      org: {
        name: "Done Ltd",
        phone: "07700 900222",
        email: "ops@done.test",
        vat_number: "GB1",
        logo_url: "https://x.test/logo.png",
        bank_details: { sort_code: "20-00-00", account_number: "12345678" },
        default_terms: "Pay in 30.",
        address: { postcode: "BT15 1AA" },
      },
      counts: {
        staffMembers: 1,
        customers: 1,
        invoices: 1,
        quotes: 1,
        importsCommitted: 1,
      },
      dismissed: new Set(),
      timestamps: { started_at: null, completed_at: null },
    };
    const progress = computeProgress(snap);
    expect(progress.done).toBe(12);
    expect(progress.total).toBe(12);
    expect(progress.pct).toBe(100);
    expect(progress.showChecklist).toBe(false);
  });

  it("dismissed optional steps drop out of the visible total", () => {
    const snap = emptySnapshot();
    // Dismiss every optional step. After this only required steps
    // remain visible: company_profile, bank, customers, first_quote = 4.
    snap.dismissed = new Set<ChecklistStepId>([
      "logo",
      "connect_email",
      "vat",
      "terms",
      "staff",
      "imports",
      "invoices_import",
      "first_invoice",
    ]);
    const progress = computeProgress(snap);
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(0);
    expect(progress.pct).toBe(0);
  });

  it("required steps CANNOT be dismissed (still show even if in the set)", () => {
    const snap = emptySnapshot();
    // Bank is required — dismissing it must not hide it.
    snap.dismissed = new Set<ChecklistStepId>(["bank"]);
    const progress = computeProgress(snap);
    const bankRow = progress.steps.find((s) => s.step.id === "bank");
    expect(bankRow).toBeTruthy();
  });

  it("dismissed-and-then-completed optional step still renders with a tick", () => {
    const snap = emptySnapshot();
    snap.dismissed = new Set<ChecklistStepId>(["logo"]);
    snap.org.logo_url = "https://x.test/logo.png";
    const progress = computeProgress(snap);
    const logoRow = progress.steps.find((s) => s.step.id === "logo");
    expect(logoRow).toBeTruthy();
    expect(logoRow?.complete).toBe(true);
  });

  it("progress percentage rounds to integers", () => {
    const snap = emptySnapshot();
    snap.org.name = "x";
    snap.org.phone = "1";
    snap.org.address = { postcode: "BT1 1AA" };
    const progress = computeProgress(snap);
    // 1 / 12 → 8.33… → rounds to 8
    expect(progress.pct).toBe(8);
  });
});

describe("/access-pending — cancelled copy contract", () => {
  const ACCESS_PENDING = readFileSync(
    resolve(__dirname, "..", "..", "app/access-pending/page.tsx"),
    "utf8",
  );

  it("COPY map has a dedicated 'cancelled' entry", () => {
    // Pattern matches `cancelled: { … }` in the COPY record literal.
    expect(ACCESS_PENDING).toMatch(/cancelled:\s*\{\s*\n?\s*title:/);
  });

  it("cancelled copy references the 30-day data retention so users know what to do", () => {
    expect(ACCESS_PENDING).toMatch(/30 days/);
  });
});
