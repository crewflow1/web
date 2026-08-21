import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Sprint A — friction removal contract tests.
 *
 * 8 items in the directive, one assertion file. Source-level pins are
 * the right tool here because every change is a UI/copy/wiring fix —
 * exercising them end-to-end would require a full Next.js server +
 * Supabase + a real session. The contract is "the directive says X,
 * the codebase now reflects X".
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// The 2026 website redesign moved the homepage to the (site) route group and
// composed it from "beat" components; the entry-CTA is BookDemoButton and the
// pricing copy lives in the pricing beat. The friction CONTRACT (no free tier,
// book-a-demo entry, premium £1k/£500 positioning) is unchanged — only the
// files it lives in moved.
const LANDING = read("app/(site)/page.tsx");
const PRICING_BLOCK = read("components/marketing/home/pricing-block.tsx");
const ACCESS_PENDING = read("app/access-pending/page.tsx");
const REFRESH_BUTTON = read("app/access-pending/_refresh-button.tsx");
const ADMIN_ACTIONS = read("app/admin/actions.ts");
const ONBOARDING = read("app/onboarding/company/page.tsx");
const QUOTES_BUILDER = read("app/(app)/quotes/_builder.tsx");
const FORM_SHELL = read("components/forms/FormShell.tsx");
const SETTINGS = read("app/(app)/settings/page.tsx");
const PORTAL_INVOICES = read("app/customer-portal/[token]/invoices/page.tsx");
const PORTAL_PDF_ROUTE = read(
  "app/customer-portal/[token]/invoices/[id]/pdf/route.ts",
);
const CHECK_EMAIL = read("app/(auth)/check-email/page.tsx");

describe("Sprint A item 1 — landing positioning (CEO directive 2026-05-22)", () => {
  // CrewFlow is premium onboarding (£1k setup + £500/mo). The earlier
  // "Start free" CTAs were removed because they conflicted with the
  // positioning. "Book a demo" is the only entry CTA.
  //
  // The Blueprint redesign renamed the entry-CTA component
  // (BookDemoButton -> BookDemoCta) and refined the pricing copy to
  // "£500/month" + "£1,000 one-time setup & onboarding". The three
  // guarantees below are unchanged — only the literal pins track the copy.
  it("landing does NOT advertise a free tier", () => {
    expect(LANDING).not.toMatch(/Start free/);
  });

  it("landing leads with 'Book a demo' as the primary CTA", () => {
    // Redesigned homepage: BookDemoButton in the hero + the final CTA beat.
    expect(LANDING).toMatch(/BookDemoButton/);
    const matches = LANDING.match(/Book a demo/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("landing copy reflects premium £1k/£500-mo positioning (pricing beat)", () => {
    expect(PRICING_BLOCK).toMatch(/£1,000 one-time setup/);
    expect(PRICING_BLOCK).toMatch(/£500/);
    expect(PRICING_BLOCK).toMatch(/month/);
  });
});

describe("Sprint A item 2 — /access-pending refresh + estimated wait + email-on-approve", () => {
  it("renders a Refresh status button", () => {
    expect(ACCESS_PENDING).toMatch(/RefreshStatusButton/);
    expect(REFRESH_BUTTON).toMatch(/router\.refresh\(\)/);
    expect(REFRESH_BUTTON).toMatch(/Refresh status/);
  });

  it("surfaces hours-elapsed since signup so the user knows things are moving", () => {
    expect(ACCESS_PENDING).toMatch(/elapsedHours/);
    expect(ACCESS_PENDING).toMatch(/Submitted:/);
  });

  it("promises email notification on approval", () => {
    expect(ACCESS_PENDING).toMatch(/email/i);
  });

  it("admin action emails the org owner when status flips to active/trial/suspended/rejected", () => {
    expect(ADMIN_ACTIONS).toMatch(/notifyOrgOwner/);
    expect(ADMIN_ACTIONS).toMatch(/sendEmail/);
    expect(ADMIN_ACTIONS).toMatch(/STATUS_EMAIL/);
    // skipping pending->pending is the intended no-op
    expect(ADMIN_ACTIONS).toMatch(/parsed\.data\.status !== "pending"/);
  });
});

describe("Sprint A item 3 — fake 'Step 1 of 3' removed", () => {
  it("onboarding page no longer claims to be step 1 of 3", () => {
    expect(ONBOARDING).not.toMatch(/Step 1 of 3/);
    expect(ONBOARDING).not.toMatch(/Step 2 of/);
  });

  it("replacement copy ('Set up your company') is present", () => {
    expect(ONBOARDING).toMatch(/Set up your company/);
  });
});

describe("Sprint A item 4 — zero-customer quote dead-end fixed", () => {
  it("QuoteBuilder defines a noCustomers flag from customers.length === 0", () => {
    expect(QUOTES_BUILDER).toMatch(/noCustomers\s*=\s*customers\.length\s*===\s*0/);
  });

  it("shows an inline 'Add a customer first' banner with a CTA", () => {
    expect(QUOTES_BUILDER).toMatch(/Add a customer first/);
    expect(QUOTES_BUILDER).toMatch(/href="\/customers\/new"/);
  });

  it("disables the submit button when noCustomers is true", () => {
    expect(QUOTES_BUILDER).toMatch(/disabled=\{noCustomers\}/);
  });

  it("SubmitButton supports a disabled prop OR'd with pending", () => {
    expect(FORM_SHELL).toMatch(/disabled\?:\s*boolean/);
    expect(FORM_SHELL).toMatch(/pending \|\| !!disabled/);
  });
});

describe("Sprint A item 5 — read-only billing/trial section in Settings", () => {
  it("renders a Plan & billing section", () => {
    // The heading is now an i18n message key resolved through the translator;
    // its rendered text still comes from the en-GB catalogue value.
    expect(SETTINGS).toMatch(/t\("settings\.billing\.title"\)/);
    const catalog = read("lib/i18n/catalog.ts");
    expect(catalog).toMatch(/"settings\.billing\.title": "Plan & billing"/);
  });

  it("shows plan + status + (when trial) days-left", () => {
    expect(SETTINGS).toMatch(/ctx\.org\.plan/);
    expect(SETTINGS).toMatch(/trialDaysLeft/);
    expect(SETTINGS).toMatch(/Trial ends/);
  });

  it("links to the billing page for plan management; mailto fallback lives there (P3W2)", () => {
    // P3W2 self-serve billing moved the plan-change surface to /settings/billing.
    // Settings links to it; the dark-mode "email us" fallback now lives on the
    // billing page (shown while self-serve billing is not yet enabled).
    expect(SETTINGS).toMatch(/href="\/settings\/billing"/);
    const BILLING = read("app/(app)/settings/billing/page.tsx");
    expect(BILLING).toMatch(/mailto:hello@crewflow\.uk/);
    expect(BILLING).toMatch(/Email us to change plan/);
  });
});

describe("Sprint A item 6 — invoice PDF download from customer portal", () => {
  it("portal invoices page links each invoice to the new pdf route", () => {
    expect(PORTAL_INVOICES).toMatch(
      /\/customer-portal\/\$\{token\}\/invoices\/\$\{inv\.id\}\/pdf/,
    );
    expect(PORTAL_INVOICES).toMatch(/Download invoice PDF/);
  });

  it("the new pdf route gates on portal token + ownership checks", () => {
    expect(PORTAL_PDF_ROUTE).toMatch(/loadCustomerByPortalToken/);
    expect(PORTAL_PDF_ROUTE).toMatch(/invoice\.org_id\s*!==\s*customer\.org_id/);
    // Issue #349 Phase 1: ownership now resolves the customer via the one
    // authority (invoice's own customer_id, quote fallback) so a quote-less
    // invoice still authorises correctly instead of 404ing.
    expect(PORTAL_PDF_ROUTE).toMatch(
      /invoiceCustomerId\(invoice\)\s*!==\s*customer\.id/,
    );
  });

  it("reuses the existing InvoicePdf renderer (no new module)", () => {
    expect(PORTAL_PDF_ROUTE).toMatch(/from "@\/lib\/pdf\/invoice-pdf"/);
  });
});

describe("Sprint A item 7 — resend magic-link button on /check-email", () => {
  it("renders a resend form posting to signInWithMagicLink with the email", () => {
    expect(CHECK_EMAIL).toMatch(/signInWithMagicLink/);
    expect(CHECK_EMAIL).toMatch(/name="email"/);
    expect(CHECK_EMAIL).toMatch(/Resend the link/);
  });

  it("falls back to a 'try again' link when no email is in the query", () => {
    expect(CHECK_EMAIL).toMatch(/Try again/);
  });
});

describe("Sprint A item 8 — org status badge in Settings header", () => {
  it("Settings header renders a status pill from ctx.org.status", () => {
    expect(SETTINGS).toMatch(/STATUS_PILL/);
    expect(SETTINGS).toMatch(/ctx\.org\.status/);
  });

  it("shows 'Trial · N days left' when on trial", () => {
    expect(SETTINGS).toMatch(/Trial · \$\{trialDaysLeft\}/);
  });
});
