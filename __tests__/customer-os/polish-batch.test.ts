import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer OS polish batch — PR 1.
 *
 * Pins the contract for:
 *   1. NumericInput component (no forced leading zero, allows empty).
 *   2. Quote builder uses NumericInput for qty + unit_price.
 *   3. List pages (quotes/jobs/invoices) accept `?customer=<uuid>` and
 *      validate the UUID against an RFC-style regex.
 *   4. Customer detail page links to each list with the filter applied.
 *   5. Tenant ConfirmForm wraps customer/job/quote/staff destructive ops.
 *   6. /insights tenant route exists, is read-only, links to dashboard.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// =====================================================================
// 1. NumericInput contract
// =====================================================================

describe("NumericInput", () => {
  const f = read("components/forms/NumericInput.tsx");

  it("is a client component", () => {
    expect(f).toMatch(/^"use client";/);
  });

  it("uses type='text' on the rendered <input>, not type='number'", () => {
    // type=number is what produces the phantom 05/055 UX the CEO flagged.
    // Only the JSX element matters — JSDoc strings reference the old
    // pattern intentionally. Match the JSX attribute form precisely.
    expect(f).toMatch(/<input[\s\S]*?type="text"/);
    expect(f).toMatch(/inputMode=\{allowDecimal \? "decimal" : "numeric"\}/);
  });

  it("allows empty / clears to null when allowEmpty (default)", () => {
    expect(f).toMatch(/allowEmpty = true/);
    expect(f).toMatch(/onChange\(allowEmpty \? null : 0\)/);
  });

  it("clamps with min/max", () => {
    expect(f).toMatch(/function clamp/);
    expect(f).toMatch(/out < min/);
    expect(f).toMatch(/out > max/);
  });

  it("filters input with a digit/dot whitelist (no negatives)", () => {
    // The regex literal as it appears in the source.
    expect(f).toMatch(/const pattern = allowDecimal \? \/\^\\d\*\\\.\?\\d\*\$\//);
  });

  it("syncs from parent value but doesn't stomp in-flight edits", () => {
    expect(f).toMatch(/lastEmittedRef/);
    expect(f).toMatch(/Avoids erasing in-progress edits/);
  });
});

// =====================================================================
// 2. Quote builder wires the new input
// =====================================================================

describe("QuoteBuilder uses NumericInput", () => {
  const f = read("app/(app)/quotes/_builder.tsx");

  it("imports NumericInput", () => {
    expect(f).toMatch(/from "@\/components\/forms\/NumericInput"/);
  });

  it("qty field is a NumericInput with min=0, max=999_999", () => {
    expect(f).toMatch(
      /<NumericInput[\s\S]*max=\{999_999\}[\s\S]*li\.qty/,
    );
  });

  it("unit_price field is a NumericInput with min=0, max=99_999_999", () => {
    expect(f).toMatch(
      /<NumericInput[\s\S]*max=\{99_999_999\}[\s\S]*li\.unit_price/,
    );
  });

  it("no <input type='number'> on qty/unit_price lines", () => {
    // We allow text inputs elsewhere (e.g. description) but the
    // numeric ones must NOT be type=number anymore.
    const qtyBlock = f.match(/li\.qty[\s\S]{0,600}/)?.[0] ?? "";
    expect(qtyBlock).not.toMatch(/type="number"/);
  });
});

// =====================================================================
// 3. List pages accept ?customer=<uuid>
// =====================================================================

describe("list pages accept ?customer= filter", () => {
  it("/quotes accepts and validates the customer UUID param", () => {
    const f = read("app/(app)/quotes/page.tsx");
    expect(f).toMatch(/customer\?:\s*string/);
    expect(f).toMatch(/UUID_RE/);
    expect(f).toMatch(/\.eq\("customer_id", customerFilter\)/);
  });

  it("/jobs accepts and validates the customer UUID param", () => {
    const f = read("app/(app)/jobs/page.tsx");
    expect(f).toMatch(/customer\?:\s*string/);
    expect(f).toMatch(/UUID_RE/);
    expect(f).toMatch(/\.eq\("customer_id", customerFilter\)/);
  });

  it("/invoices accepts the customer UUID + filters by invoices.customer_id", () => {
    const f = read("app/(app)/invoices/page.tsx");
    expect(f).toMatch(/customer\?:\s*string/);
    expect(f).toMatch(/UUID_RE/);
    // Invoices filter on the DURABLE invoices.customer_id anchor (composite FK,
    // migration 20260915000000) — NOT through a quotes!inner join. The old join
    // dropped every quote-less stage/progress-billing invoice (quote_id NULL,
    // generate_stage_invoice) from both the list and its exact count. See
    // __tests__/security/invoices-customer-filter-anchor.test.ts for the guard.
    expect(f).toMatch(/\.eq\("customer_id", customerFilter\)/);
    // Strip comments before the negative checks: the file's comments explain the
    // old shape (`quote:quotes!inner`), which must not count as a re-offence.
    const code = f
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/quote:quotes!inner/);
    expect(code).not.toMatch(/\.eq\("quote\.customer_id", customerFilter\)/);
  });

  it("invalid UUIDs are rejected, falling back to null (no filter)", () => {
    for (const p of [
      "app/(app)/quotes/page.tsx",
      "app/(app)/jobs/page.tsx",
      "app/(app)/invoices/page.tsx",
    ]) {
      expect(read(p)).toMatch(
        /UUID_RE\.test\(sp\.customer\) \? sp\.customer : null/,
      );
    }
  });

  it("each page renders a 'filtered to <name>' banner with a clear-link", () => {
    for (const p of [
      "app/(app)/quotes/page.tsx",
      "app/(app)/jobs/page.tsx",
      "app/(app)/invoices/page.tsx",
    ]) {
      const f = read(p);
      expect(f).toMatch(/Filtered to/);
      expect(f).toMatch(/Clear customer filter/);
      expect(f).toMatch(/filteredCustomerName/);
    }
  });
});

// =====================================================================
// 4. Customer detail page links use the filter
// =====================================================================

describe("customer detail page links to filtered list pages", () => {
  const f = read("app/(app)/customers/[id]/page.tsx");

  it("Quotes summary card href includes ?customer=<id>", () => {
    expect(f).toMatch(/title="Quotes"[\s\S]*href=\{`\/quotes\?customer=\$\{id\}`\}/);
  });

  it("Jobs summary card href includes ?customer=<id>", () => {
    expect(f).toMatch(/title="Jobs"[\s\S]*href=\{`\/jobs\?customer=\$\{id\}`\}/);
  });

  it("Invoices summary card href includes ?customer=<id>", () => {
    expect(f).toMatch(/title="Invoices"[\s\S]*href=\{`\/invoices\?customer=\$\{id\}`\}/);
  });
});

// =====================================================================
// 5. Tenant ConfirmForm wraps deletes
// =====================================================================

describe("tenant ConfirmForm + applied to destructive ops", () => {
  it("ConfirmForm helper exists at components/forms/ConfirmForm.tsx", () => {
    const f = read("components/forms/ConfirmForm.tsx");
    expect(f).toMatch(/^"use client";/);
    expect(f).toMatch(/export function ConfirmForm/);
    expect(f).toMatch(/window\.confirm\(confirm\)/);
  });

  it("/customers/[id] delete wrapped in ConfirmForm", () => {
    const f = read("app/(app)/customers/[id]/page.tsx");
    expect(f).toMatch(/<ConfirmForm[\s\S]*action=\{deleteAction\}/);
    expect(f).toMatch(/Delete customer ".+"/);
  });

  it("/jobs/[id] delete wrapped in ConfirmForm", () => {
    const f = read("app/(app)/jobs/[id]/page.tsx");
    expect(f).toMatch(/<ConfirmForm[\s\S]*action=\{deleteAction\}/);
    expect(f).toMatch(/Delete this job/);
  });

  it("/quotes/[id] delete wrapped in ConfirmForm", () => {
    const f = read("app/(app)/quotes/[id]/page.tsx");
    expect(f).toMatch(/<ConfirmForm[\s\S]*deleteQuote\.bind/);
    expect(f).toMatch(/Delete this quote/);
  });

  it("/staff/[id] remove wrapped in ConfirmForm", () => {
    const f = read("app/(app)/staff/[id]/page.tsx");
    expect(f).toMatch(/<ConfirmForm[\s\S]*removeStaff\.bind/);
    expect(f).toMatch(/Remove .* from the organisation/);
  });
});

// =====================================================================
// 6. /insights route exists + read-only
// =====================================================================

describe("/insights tenant route", () => {
  const f = read("app/(app)/insights/page.tsx");

  it("is gated by requireOrgContext (tenant scope)", () => {
    expect(f).toMatch(/requireOrgContext/);
  });

  it("reuses the dashboard's InsightsSection (single source of truth)", () => {
    expect(f).toMatch(/from "\.\.\/dashboard\/_insights"/);
    expect(f).toMatch(/<InsightsSection/);
  });

  it("calls deterministic aggregates (no LLM in the request path yet)", () => {
    expect(f).toMatch(/computeActivitySummary/);
    expect(f).toMatch(/computeLeadInsights/);
  });

  it("declares itself read-only in the page copy", () => {
    expect(f).toMatch(/Read-only by design/);
  });

  it("links back to /dashboard (no dead-end)", () => {
    expect(f).toMatch(/\/dashboard/);
  });

  it("sidebar exposes the AI insights entry to admin/owner", () => {
    const sidebar = read("app/(app)/_components/sidebar.tsx");
    expect(sidebar).toMatch(/href: "\/insights"/);
    // Labels are now i18n message keys resolved through the translator; the
    // rendered text still comes from the en-GB catalogue value.
    expect(sidebar).toMatch(/labelKey: "nav\.ai_insights"/);
    const catalog = read("lib/i18n/catalog.ts");
    expect(catalog).toMatch(/"nav\.ai_insights": "AI insights"/);
  });
});
