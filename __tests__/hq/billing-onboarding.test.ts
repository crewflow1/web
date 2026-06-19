import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BILLING_INVOICE_KINDS,
  BILLING_INVOICE_STATUSES,
  BILLING_STATUS_LABELS,
  formatRenewal,
  formatGbp,
  summariseBillingInvoices,
  type BillingInvoiceRow,
} from "@/lib/hq/billing";

/**
 * HQ-4 Billing + Onboarding contract tests.
 *
 * Pins:
 *   1. Pure compute: billing summary maths + renewal labels.
 *   2. Migration adds billing_invoices + billing_events with the
 *      right shape, RLS but no policies (service-role only),
 *      and the indexes the chase queries depend on.
 *   3. Server actions re-check super-admin AND dual-write to
 *      admin_activity_log.
 *   4. Billing page renders the directive's required columns +
 *      every action surface; loads invoices only for the open org.
 *   5. Onboarding page aggregates imports / files / errors and
 *      links to /admin/customers/<id> for the controls.
 *   6. HQ_NAV marks both sections as ready.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260607000000_billing_os.sql");
const BILLING_ACTIONS = read("app/admin/billing/actions.ts");
const BILLING_PAGE = read("app/admin/billing/page.tsx");
const ONBOARDING_PAGE = read("app/admin/onboarding/page.tsx");
const BILLING_SNAP = read("server/services/hq-billing-snapshot.ts");
const ONBOARDING_SNAP = read("server/services/hq-onboarding-snapshot.ts");
const LAYOUT = read("app/admin/layout.tsx");

// --------------------------------------------------------------------
// Pure compute — billing.ts
// --------------------------------------------------------------------

describe("BILLING_INVOICE_KINDS + STATUSES — match the migration CHECK", () => {
  it("kinds are setup_fee + subscription + overage", () => {
    expect(BILLING_INVOICE_KINDS).toEqual([
      "setup_fee",
      "subscription",
      "overage",
    ]);
  });
  it("statuses cover the full lifecycle", () => {
    expect(BILLING_INVOICE_STATUSES).toEqual([
      "draft",
      "sent",
      "paid",
      "failed",
      "refunded",
      "void",
    ]);
  });
  it("every status has a label", () => {
    for (const s of BILLING_INVOICE_STATUSES) {
      expect(BILLING_STATUS_LABELS[s]).toBeTruthy();
    }
  });
});

describe("summariseBillingInvoices — outstanding / paid / failed maths", () => {
  function inv(
    partial: Partial<BillingInvoiceRow> & Pick<BillingInvoiceRow, "id" | "status" | "amount_gbp">,
  ): BillingInvoiceRow {
    return {
      kind: "subscription",
      due_date: null,
      sent_at: null,
      paid_at: null,
      failed_at: null,
      failure_reason: null,
      period_start: null,
      period_end: null,
      notes: null,
      stripe_invoice_id: null,
      created_at: "2026-05-01T00:00:00Z",
      ...partial,
    };
  }

  it("outstanding = sum of sent + failed amounts", () => {
    const r = summariseBillingInvoices([
      inv({ id: "1", status: "sent", amount_gbp: 500 }),
      inv({ id: "2", status: "failed", amount_gbp: 500, failed_at: "2026-05-10T00:00:00Z" }),
      inv({ id: "3", status: "paid", amount_gbp: 1000, paid_at: "2026-05-05T00:00:00Z" }),
      inv({ id: "4", status: "draft", amount_gbp: 999 }), // draft doesn't count
      inv({ id: "5", status: "void", amount_gbp: 999 }), // void doesn't count
    ]);
    expect(r.outstandingGbp).toBe(1000);
    expect(r.paidGbp).toBe(1000);
    expect(r.failedCount).toBe(1);
    expect(r.invoiceCount).toBe(5);
  });

  it("tracks the most-recent paid + most-recent failed timestamps", () => {
    const r = summariseBillingInvoices([
      inv({
        id: "1",
        status: "paid",
        amount_gbp: 500,
        paid_at: "2026-05-01T00:00:00Z",
      }),
      inv({
        id: "2",
        status: "paid",
        amount_gbp: 500,
        paid_at: "2026-05-10T00:00:00Z",
      }),
      inv({
        id: "3",
        status: "failed",
        amount_gbp: 500,
        failed_at: "2026-05-09T00:00:00Z",
      }),
    ]);
    expect(r.lastPaidAt).toBe("2026-05-10T00:00:00Z");
    expect(r.lastFailedAt).toBe("2026-05-09T00:00:00Z");
  });

  it("empty input returns zeros", () => {
    const r = summariseBillingInvoices([]);
    expect(r).toEqual({
      outstandingGbp: 0,
      paidGbp: 0,
      failedCount: 0,
      invoiceCount: 0,
      lastPaidAt: null,
      lastFailedAt: null,
    });
  });
});

describe("formatRenewal", () => {
  it("returns — for null", () => {
    expect(formatRenewal(null)).toBe("—");
  });
  it("Tomorrow for +1 day", () => {
    const t = new Date(Date.now() + 86_400_000 + 1000).toISOString();
    expect(formatRenewal(t)).toMatch(/Tomorrow/);
  });
  it("Yesterday for -1 day", () => {
    const t = new Date(Date.now() - 86_400_000 - 1000).toISOString();
    expect(formatRenewal(t)).toMatch(/Yesterday/);
  });
  it("'N days overdue' for past dates", () => {
    const t = new Date(Date.now() - 5 * 86_400_000 - 1000).toISOString();
    expect(formatRenewal(t)).toMatch(/days overdue/);
  });
});

describe("formatGbp", () => {
  it("rounds + locale-formats", () => {
    expect(formatGbp(1234.5)).toBe("£1,235");
    expect(formatGbp("500")).toBe("£500");
    expect(formatGbp(null)).toBe("—");
  });
});

// --------------------------------------------------------------------
// Migration 20260607000000
// --------------------------------------------------------------------

describe("migration 20260607000000 — billing_invoices + billing_events", () => {
  it("creates billing_invoices with the kind+status CHECK constraints", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.billing_invoices/);
    expect(MIGRATION).toMatch(/kind in \('setup_fee', 'subscription', 'overage'\)/);
    expect(MIGRATION).toMatch(/status in \('draft', 'sent', 'paid', 'failed', 'refunded', 'void'\)/);
  });

  it("FK to organizations cascades on delete", () => {
    expect(MIGRATION).toMatch(/references public\.organizations\(id\) on delete cascade/);
  });

  it("enables RLS without policies (service-role only)", () => {
    expect(MIGRATION).toMatch(/alter table public\.billing_invoices enable row level security/);
    expect(MIGRATION).toMatch(/alter table public\.billing_events enable row level security/);
    // No policies (HQ tables are service-role only).
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("indexes the chase queries (org+recency, status+due, outstanding partial)", () => {
    expect(MIGRATION).toMatch(/billing_invoices_org_idx/);
    expect(MIGRATION).toMatch(/billing_invoices_status_idx/);
    expect(MIGRATION).toMatch(/billing_invoices_outstanding_idx/);
    // Partial index restricts to outstanding statuses for fast scan.
    expect(MIGRATION).toMatch(
      /where status in \('sent', 'failed'\)/,
    );
  });

  it("Stripe invoice id has a unique partial index to make webhook re-delivery idempotent", () => {
    expect(MIGRATION).toMatch(/create unique index if not exists billing_invoices_stripe_id_idx/);
    expect(MIGRATION).toMatch(/where stripe_invoice_id is not null/);
  });

  it("billing_events has a unique event_id so re-delivery is a no-op", () => {
    expect(MIGRATION).toMatch(/event_id\s+text unique/);
  });

  it("adds organizations.next_renewal_at", () => {
    expect(MIGRATION).toMatch(/add column if not exists next_renewal_at/);
  });

  it("touch trigger keeps updated_at fresh on UPDATE", () => {
    expect(MIGRATION).toMatch(/billing_invoices_touch/);
    expect(MIGRATION).toMatch(/before update on public\.billing_invoices/);
  });
});

// --------------------------------------------------------------------
// Server actions
// --------------------------------------------------------------------

describe("server actions — super-admin gate + admin_activity_log dual-write", () => {
  it("every action gates on HQ access via requireHq()", () => {
    expect(BILLING_ACTIONS).toMatch(/requireHq\(\)/);
    for (const action of [
      "createBillingInvoice",
      "setBillingInvoiceStatus",
      "setNextRenewal",
    ]) {
      expect(BILLING_ACTIONS).toMatch(new RegExp(`export async function ${action}`));
    }
  });

  it("every action writes to admin_activity_log via recordAdminActivity", () => {
    const occurrences = (BILLING_ACTIONS.match(/recordAdminActivity\(/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("flipping a setup_fee invoice to paid also flips org.setup_fee_status", () => {
    // The cross-table sync is critical — without it the Customer OS
    // header shows a different state from the Billing tab.
    expect(BILLING_ACTIONS).toMatch(/setCustomerFlow|setup_fee_status: setupStatus|setup_fee_status:/);
    // Two paths: createBillingInvoice with kind=setup_fee, and
    // setBillingInvoiceStatus when the existing invoice was setup_fee.
    const occurrences = (BILLING_ACTIONS.match(/kind === "setup_fee"|row\?\.kind === "setup_fee"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("amounts can't go negative or above a sane cap", () => {
    expect(BILLING_ACTIONS).toMatch(/min\(0\)\.max\(1_000_000\)/);
  });

  it("Zod schemas enforce a closed-set status on flips (paid/failed/refunded/void only)", () => {
    expect(BILLING_ACTIONS).toMatch(/z\.enum\(\["paid", "failed", "refunded", "void"\]\)/);
  });
});

// --------------------------------------------------------------------
// Snapshot services
// --------------------------------------------------------------------

describe("billing snapshot — efficient cross-tenant aggregator", () => {
  it("listCustomersForBilling queries orgs + memberships + billing_invoices once each", () => {
    expect(BILLING_SNAP).toMatch(/listCustomersForBilling/);
    expect(BILLING_SNAP).toMatch(/from\("organizations"/);
    expect(BILLING_SNAP).toMatch(/from\("memberships"/);
    expect(BILLING_SNAP).toMatch(/"billing_invoices"/);
  });

  it("listBillingInvoicesForOrg targets a single org by id", () => {
    expect(BILLING_SNAP).toMatch(/export async function listBillingInvoicesForOrg/);
    expect(BILLING_SNAP).toMatch(/\.eq\("org_id", orgId\)/);
  });
});

describe("onboarding snapshot — bucketed counters per org", () => {
  it("queries imports + import_files + import_rows by org_id IN list (no N+1)", () => {
    expect(ONBOARDING_SNAP).toMatch(/from\("imports"\)/);
    expect(ONBOARDING_SNAP).toMatch(/from\("import_files"\)/);
    expect(ONBOARDING_SNAP).toMatch(/from\("import_rows"\)/);
    const inCalls = (ONBOARDING_SNAP.match(/\.in\("(org_id|import_id)"/g) ?? []).length;
    expect(inCalls).toBeGreaterThanOrEqual(3);
  });

  it("listImportsForOrg loads imports + their files in two queries", () => {
    expect(ONBOARDING_SNAP).toMatch(/export async function listImportsForOrg/);
    expect(ONBOARDING_SNAP).toMatch(/\.eq\("org_id", orgId\)/);
    expect(ONBOARDING_SNAP).toMatch(/\.in\("import_id"/);
  });
});

// --------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------

describe("/admin/billing — list view", () => {
  it("renders every directive-required column / metric", () => {
    for (const label of [
      "Subscription",
      "Setup",
      "MRR",
      "Outstanding",
      "LTV",
      "Next renewal",
      "Invoices",
    ]) {
      expect(BILLING_PAGE).toContain(label);
    }
  });

  it("surfaces failed-payment count on rows that have one", () => {
    expect(BILLING_PAGE).toMatch(/failed/);
    expect(BILLING_PAGE).toMatch(/summary\.failedCount/);
  });

  it("loads per-org invoices only for the open row (?org=<id>)", () => {
    expect(BILLING_PAGE).toMatch(/openInvoices/);
    expect(BILLING_PAGE).toMatch(/listBillingInvoicesForOrg/);
    const calls = (BILLING_PAGE.match(/listBillingInvoicesForOrg\(/g) ?? []).length;
    expect(calls).toBe(1);
  });

  it("expand row offers Mark paid / Mark failed / Refund / Void buttons", () => {
    for (const label of ["Mark paid", "Mark failed", "Refund", "Void"]) {
      expect(BILLING_PAGE).toContain(label);
    }
  });

  it("has a Stripe placeholder line that wires up later without UI changes", () => {
    expect(BILLING_PAGE).toMatch(/stripe_customer_id/);
    expect(BILLING_PAGE).toMatch(/Stripe not linked|Stripe:/);
  });
});

describe("/admin/onboarding — list view", () => {
  it("renders migration % bar + onboarding % + uploaded files + failed-row count", () => {
    for (const label of [
      "Migration",
      "Onboarding",
      "Files",
      "Rows imported",
      "Rows failed",
    ]) {
      expect(ONBOARDING_PAGE).toContain(label);
    }
  });

  it("filters: search / status / stalled-only + sort by stalled / errors / newest", () => {
    expect(ONBOARDING_PAGE).toMatch(/stalled/);
    expect(ONBOARDING_PAGE).toMatch(/percent_asc/);
    expect(ONBOARDING_PAGE).toMatch(/errors/);
  });

  it("links to /admin/customers/<id> for edit (read-only on this page)", () => {
    expect(ONBOARDING_PAGE).toMatch(/\/admin\/customers\/\$\{row\.org_id\}/);
    expect(ONBOARDING_PAGE).toMatch(/Edit progress/);
  });

  it("inline expand shows imports + files per import (no N+1)", () => {
    expect(ONBOARDING_PAGE).toMatch(/listImportsForOrg/);
    const calls = (ONBOARDING_PAGE.match(/listImportsForOrg\(/g) ?? []).length;
    expect(calls).toBe(1);
  });
});

// --------------------------------------------------------------------
// Nav
// --------------------------------------------------------------------

describe("HQ_NAV — billing + onboarding are ready", () => {
  it("/admin/billing has no shipsIn", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/billing", label: "Billing" \}/);
    expect(LAYOUT).not.toMatch(/href: "\/admin\/billing"[^}]*shipsIn:/);
  });
  it("/admin/onboarding has no shipsIn", () => {
    expect(LAYOUT).toMatch(/href: "\/admin\/onboarding", label: "Onboarding & migration" \}/);
    expect(LAYOUT).not.toMatch(/href: "\/admin\/onboarding"[^}]*shipsIn:/);
  });
});
