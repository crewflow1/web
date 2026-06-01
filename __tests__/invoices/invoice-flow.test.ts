import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeTotals } from "@/lib/quotes/totals";
import { invoiceDueDate, INVOICE_DUE_DAYS } from "@/lib/invoices/due-date";
import type { LineItem } from "@/lib/quotes/schema";

/**
 * Invoice generation — launch-stabilization contract (CEO pre-launch, P1).
 *
 * Root cause this suite locks down: /invoices/new used to
 *   (a) have NO loading boundary of its own, so it inherited
 *       app/(app)/invoices/loading.tsx — a full 8×7 TABLE skeleton — and the
 *       form page "sat" on the wrong skeleton for the whole server fetch; and
 *   (b) fetch EVERY quote regardless of status, so with no accepted quotes the
 *       user hit a dead, disabled form instead of a real empty state, and could
 *       bill a quote the customer never accepted.
 *
 * The system's actual contract: a quote becomes `accepted` (public portal or
 * the owner "confirmed by phone" shortcut) → an invoice is AUTO-created copying
 * the quote's subtotal/vat_total as a `draft`. The manual /invoices/new page is
 * the documented fallback for an accepted quote whose auto-invoice didn't fire
 * (quotes/[id]/page.tsx says exactly this). So: billable set = `accepted`, the
 * empty state must guide the user, and the skeleton must be form-shaped.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");

describe("P1 — /invoices/new bills only accepted quotes, with a real empty state", () => {
  const page = read("app/(app)/invoices/new/page.tsx");

  it("scopes the quote dropdown query to status = accepted", () => {
    expect(page).toMatch(
      /\.from\("quotes"\)[\s\S]*?\.eq\("status",\s*"accepted"\)/,
    );
  });

  it("renders a guiding EmptyState (not a dead form) when there are no accepted quotes", () => {
    expect(page).toMatch(/import \{ EmptyState \}/);
    expect(page).toMatch(/options\.length === 0 \?/);
    // The empty state routes the user back to quotes to get one accepted.
    expect(page).toMatch(/href: "\/quotes"/);
  });
});

describe("P1 — /invoices/new no longer inherits the invoices table skeleton", () => {
  it("has its own loading boundary that is NOT the 8×7 table skeleton", () => {
    // If this read throws, the file is missing and the segment falls back to
    // the parent table skeleton again — the original regression.
    const loading = read("app/(app)/invoices/new/loading.tsx");
    expect(loading).toMatch(/export default function/);
    expect(loading).not.toMatch(/SkeletonTable/);
  });
});

describe("P1 — POST /api/invoices rejects non-accepted quotes (defense-in-depth)", () => {
  const route = read("app/api/invoices/route.ts");

  it("loads the quote status and refuses anything that isn't accepted", () => {
    expect(route).toMatch(/\.select\("[^"]*status[^"]*"\)/);
    expect(route).toMatch(/quote\.status !== "accepted"/);
  });

  it("copies amount/vat_total from the quote and opens the invoice as draft", () => {
    expect(route).toMatch(/amount:\s*Number\(quote\.subtotal/);
    expect(route).toMatch(/vat_total:\s*Number\(quote\.vat_total/);
    expect(route).toMatch(/status:\s*"draft"/);
  });
});

describe("P1 — invoice totals/VAT are correct by construction", () => {
  it("invoices.total is a STORED GENERATED column = amount + vat_total", () => {
    const mig = read("supabase/migrations/20260515190000_invoices.sql");
    expect(mig).toMatch(
      /total\s+numeric\(12, 2\) generated always as \(amount \+ vat_total\) stored/,
    );
  });

  it("computeTotals does per-line VAT then sums (HMRC-style) — the values copied to the invoice", () => {
    const items: LineItem[] = [
      { description: "Labour", qty: 2, unit: "hr", unit_price: 100, vat_rate: 20 },
      { description: "Zero-rated parts", qty: 1, unit: "ea", unit_price: 50, vat_rate: 0 },
    ];
    const t = computeTotals(items);
    // line 1: 2×100 = 200 net, 20% VAT = 40. line 2: 50 net, 0% VAT = 0.
    expect(t.subtotal).toBe(250);
    expect(t.vat_total).toBe(40);
    expect(t.total).toBe(290); // == subtotal + vat_total, mirrors the generated column
    expect(t.lines).toEqual([
      { line_total: 200, line_vat: 40 },
      { line_total: 50, line_vat: 0 },
    ]);
  });

  it("auto-generated invoices default to net-14 so the due date is never blank", () => {
    expect(INVOICE_DUE_DAYS).toBe(14);
    expect(invoiceDueDate("2026-06-01T00:00:00.000Z")).toBe("2026-06-15");
  });
});
