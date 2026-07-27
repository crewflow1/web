import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * UI pin tests for Phases A–H.
 *
 * Every backend service shipped in `feat(final-additions)` now has an
 * operator-facing UI. These tests pin the pages and the wiring between
 * them: server actions imported, sidebar updated, attachments panel
 * dropped into every entity detail page, etc.
 *
 * They are intentionally cheap — file existence + a few substring
 * checks — so they fail loudly the moment a page is renamed or a panel
 * is removed.
 */

const root = resolve(__dirname, "../..");
const exists = (rel: string) => existsSync(resolve(root, rel));
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

// =====================================================================
// Sidebar — every new page is a top-level nav entry
// =====================================================================

describe("Sidebar lists every new operator surface", () => {
  it("includes Inbox / Suppliers / Expenses / Compliance / Reviews", () => {
    const src = read("app/(app)/_components/sidebar.tsx");
    expect(src).toMatch(/href: "\/inbox"/);
    expect(src).toMatch(/href: "\/suppliers"/);
    expect(src).toMatch(/href: "\/expenses"/);
    expect(src).toMatch(/href: "\/compliance"/);
    expect(src).toMatch(/href: "\/reviews"/);
  });
});

// =====================================================================
// Phase A — Inbox
// =====================================================================

describe("Phase A — Inbox UI", () => {
  it("page + action files exist", () => {
    expect(exists("app/(app)/inbox/page.tsx")).toBe(true);
    expect(exists("app/(app)/inbox/actions.ts")).toBe(true);
  });

  it("page queries inbound_enquiries + renders channel labels", () => {
    const src = read("app/(app)/inbox/page.tsx");
    expect(src).toMatch(/"inbound_enquiries" as never/);
    expect(src).toMatch(/CHANNEL_LABELS/);
    expect(src).toMatch(/markEnquiryStatus/);
  });

  it("status-change action validates enum + audits", () => {
    const src = read("app/(app)/inbox/actions.ts");
    expect(src).toMatch(/statusSchema/);
    expect(src).toMatch(/recordAdminActivity/);
  });
});

// =====================================================================
// Phase B — Lead follow-ups
// =====================================================================

describe("Phase B — Follow-up panel + actions", () => {
  it("acknowledgeLead action wraps markLeadActed service", () => {
    const src = read("app/(app)/leads/actions.ts");
    expect(src).toMatch(/markLeadActed/);
    expect(src).toMatch(/acknowledgeLead/);
    expect(src).toMatch(/ACTED_KIND_SCHEMA/);
  });

  it("lead detail page renders the follow-up section + 3 action buttons", () => {
    const src = read("app/(app)/leads/[id]/page.tsx");
    expect(src).toMatch(/Mark called/);
    expect(src).toMatch(/Mark messaged/);
    expect(src).toMatch(/Archive/);
    expect(src).toMatch(/acknowledgeLead\.bind\(null, id\)/);
    expect(src).toMatch(/lead_followup_state/);
  });
});

// =====================================================================
// Phase C — Lead summary
// =====================================================================

describe("Phase C — AI summary panel", () => {
  it("regenerateLeadSummary action wraps summariseLead service", () => {
    const src = read("app/(app)/leads/actions.ts");
    expect(src).toMatch(/summariseLead/);
    expect(src).toMatch(/regenerateLeadSummary/);
  });

  it("lead detail page renders summary panel + regenerate button", () => {
    const src = read("app/(app)/leads/[id]/page.tsx");
    expect(src).toMatch(/regenerateLeadSummary\.bind\(null, id\)/);
    expect(src).toMatch(/AI summary/);
  });
});

// =====================================================================
// Phase D — Suppliers + expenses
// =====================================================================

describe("Phase D — Suppliers + expenses UI", () => {
  it("supplier pages + actions exist", () => {
    expect(exists("app/(app)/suppliers/page.tsx")).toBe(true);
    expect(exists("app/(app)/suppliers/new/page.tsx")).toBe(true);
    expect(exists("app/(app)/suppliers/[id]/page.tsx")).toBe(true);
    expect(exists("app/(app)/suppliers/actions.ts")).toBe(true);
    expect(exists("app/(app)/suppliers/_form.tsx")).toBe(true);
  });

  it("expense pages + actions exist", () => {
    expect(exists("app/(app)/expenses/page.tsx")).toBe(true);
    expect(exists("app/(app)/expenses/new/page.tsx")).toBe(true);
    expect(exists("app/(app)/expenses/[id]/page.tsx")).toBe(true);
    expect(exists("app/(app)/expenses/actions.ts")).toBe(true);
  });

  it("expense upload action calls the OCR service", () => {
    const src = read("app/(app)/expenses/actions.ts");
    expect(src).toMatch(/createExpenseDraftFromUpload/);
    expect(src).toMatch(/approveExpenseDraft/);
    expect(src).toMatch(/from\("receipts"\)/);
  });

  it("expense approval form passes supplier + amount + VAT rate", () => {
    const src = read("app/(app)/expenses/[id]/page.tsx");
    expect(src).toMatch(/name="amount"/);
    expect(src).toMatch(/name="vat_rate"/);
    expect(src).toMatch(/name="supplier_id"/);
    expect(src).toMatch(/approveExpenseDraftAction/);
    expect(src).toMatch(/rejectExpenseDraft/);
  });
});

// =====================================================================
// Phase E — Compliance docs
// =====================================================================

describe("Phase E — Compliance UI", () => {
  it("page + new + detail + action files exist", () => {
    expect(exists("app/(app)/compliance/page.tsx")).toBe(true);
    expect(exists("app/(app)/compliance/new/page.tsx")).toBe(true);
    expect(exists("app/(app)/compliance/[id]/page.tsx")).toBe(true);
    expect(exists("app/(app)/compliance/actions.ts")).toBe(true);
  });

  it("upload action writes to compliance-docs bucket + table", () => {
    const src = read("app/(app)/compliance/actions.ts");
    expect(src).toMatch(/from\("compliance-docs"\)/);
    expect(src).toMatch(/"compliance_documents" as never/);
    expect(src).toMatch(/recordAdminActivity/);
  });

  it("upload form has kind + title + expires_at + file fields", () => {
    const src = read("app/(app)/compliance/new/page.tsx");
    expect(src).toMatch(/name="kind"/);
    expect(src).toMatch(/name="title"/);
    expect(src).toMatch(/name="expires_at"/);
    expect(src).toMatch(/name="file"/);
  });
});

// =====================================================================
// Phase F — Universal attachments component
// =====================================================================

describe("Phase F — Attachments panel", () => {
  it("component + client + actions exist", () => {
    expect(exists("components/attachments/AttachmentsPanel.tsx")).toBe(true);
    expect(exists("components/attachments/AttachmentsClient.tsx")).toBe(true);
    expect(exists("components/attachments/actions.ts")).toBe(true);
  });

  it("panel is dropped on every entity detail page", () => {
    const pages: Array<{ route: string; target: string }> = [
      { route: "customers", target: "customers" },
      { route: "jobs", target: "jobs" },
      { route: "quotes", target: "quotes" },
      { route: "invoices", target: "invoices" },
      { route: "suppliers", target: "suppliers" },
      { route: "leads", target: "leads" },
      // memberships is the target_table for the staff detail page.
      { route: "staff", target: "memberships" },
    ];
    for (const { route, target } of pages) {
      const src = read(`app/(app)/${route}/[id]/page.tsx`);
      expect(src).toMatch(/AttachmentsPanel/);
      expect(src).toMatch(new RegExp(`targetTable=\\"${target}\\"`));
    }
  });

  it("upload action uses the service + revalidates", () => {
    const src = read("components/attachments/actions.ts");
    expect(src).toMatch(/uploadTenantAttachment/);
    expect(src).toMatch(/deleteTenantAttachment/);
    expect(src).toMatch(/revalidatePath/);
  });
});

// =====================================================================
// Phase G — E-signatures
// =====================================================================

describe("Phase G — E-signature on quote view", () => {
  it("public quote portal has typed signature input", () => {
    const src = read("app/q/[token]/page.tsx");
    expect(src).toMatch(/Your full name \(this is your signature\)/);
    expect(src).toMatch(/electronic\s*signature/i);
  });

  it("acceptQuoteByToken writes to the signatures polymorphic table", () => {
    const src = read("app/(app)/quotes/actions.ts");
    expect(src).toMatch(/"signatures" as never/);
    expect(src).toMatch(/target_table: "quotes"/);
  });

  it("public action plumbs user_agent through", () => {
    const src = read("app/q/[token]/actions.ts");
    expect(src).toMatch(/user-agent/);
    expect(src).toMatch(/userAgent/);
  });

  it("quote detail page renders signature audit panel", () => {
    const src = read("app/(app)/quotes/[id]/page.tsx");
    expect(src).toMatch(/signatures-heading/);
    expect(src).toMatch(/signatures\.length/);
  });
});

// =====================================================================
// Phase H — Review requests
// =====================================================================

describe("Phase H — Review request UI", () => {
  it("page + new + actions exist", () => {
    expect(exists("app/(app)/reviews/page.tsx")).toBe(true);
    expect(exists("app/(app)/reviews/new/page.tsx")).toBe(true);
    expect(exists("app/(app)/reviews/actions.ts")).toBe(true);
  });

  it("create / cancel / completed actions exist + email action uses Resend wrapper", () => {
    const src = read("app/(app)/reviews/actions.ts");
    expect(src).toMatch(/createReviewRequestAction/);
    expect(src).toMatch(/markReviewCompletedAction/);
    expect(src).toMatch(/cancelReviewRequestAction/);
    expect(src).toMatch(/emailReviewRequestNow/);
    expect(src).toMatch(/sendEmail/);
  });

  it("completed jobs link to /reviews/new with prefilled params", () => {
    const src = read("app/(app)/jobs/[id]/page.tsx");
    expect(src).toMatch(/reviews\/new\?customer_id=/);
    // The review CTA must gate on the real job-status enum value
    // ("completed" — see lib/jobs/schema.ts). It previously read "done",
    // which is not a valid status, so the CTA never rendered.
    expect(src).toMatch(/job\.status === "completed"/);
  });

  it("reviews list page renders 3 action buttons + status filter", () => {
    const src = read("app/(app)/reviews/page.tsx");
    expect(src).toMatch(/Send email now/);
    expect(src).toMatch(/Mark completed/);
    expect(src).toMatch(/Cancel/);
    expect(src).toMatch(/emailReviewRequestNow/);
  });
});
