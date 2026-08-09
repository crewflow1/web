import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OVERDUE_COLLECTABLE_STATUSES,
  OVERDUE_NON_COLLECTABLE_STATUSES,
  invoiceBusinessToday,
  invoiceDaysOverdue,
  invoiceDisplayStatus,
  isCollectableStatus,
  isInvoiceOverdue,
} from "@/lib/invoices/overdue";
import {
  INVOICE_STATUSES,
  WRITABLE_INVOICE_STATUSES,
  updateInvoiceSchema,
} from "@/lib/invoices/schema";
import {
  computeReceivables,
  invoiceRemaining,
  isOutstandingStatus,
} from "@/lib/invoices/receivables";
import { computePortalPayments } from "@/lib/customers/portal-payments";
import { computeOrgCashSummary, type OrgCashInvoice } from "@/lib/commercial/org-cash";

/**
 * The canonical overdue authority.
 *
 * `overdue` used to be BOTH stored and derived: two paths wrote it (the status
 * buttons, CSV import) and nothing kept it current, while two surfaces derived
 * it differently — `due_date < today` on the dashboard vs `sent_at + 30d` in
 * the AI aggregates. So the dashboard tile counted one population and its own
 * drill-through (`/invoices?status=overdue`) filtered another; they matched
 * only by coincidence.
 *
 * This pins the single definition, and that the writers are gone.
 *
 * The authority is pure, so it is tested BEHAVIOURALLY. Consumer wiring is
 * pinned on source (server components have no mock harness — see the header of
 * __tests__/payments/record-payment.test.ts).
 */

const TODAY = "2026-07-16";
const YESTERDAY = "2026-07-15";
const TOMORROW = "2026-07-17";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Source with comments stripped.
 *
 * Assertions about what code does NOT do must run against code alone: these
 * files legitimately quote the old predicates (`.eq("status","overdue")`,
 * `sent_at + 30d`) in comments to explain what changed, and prose describing a
 * bug must not be mistaken for committing it.
 */
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

// =====================================================================
// The definition
// =====================================================================

describe("isInvoiceOverdue — due_date is the time authority", () => {
  it("is overdue when a collectable invoice is past its due date", () => {
    expect(isInvoiceOverdue({ status: "sent", due_date: YESTERDAY }, TODAY)).toBe(true);
  });

  it("is NOT overdue on the due date itself — the day is not yet missed", () => {
    expect(isInvoiceOverdue({ status: "sent", due_date: TODAY }, TODAY)).toBe(false);
  });

  it("is NOT overdue when due in the future", () => {
    expect(isInvoiceOverdue({ status: "sent", due_date: TOMORROW }, TODAY)).toBe(false);
  });

  it("ignores sent_at entirely — 30 days after sending is not a deadline", () => {
    // The old aggregates definition called this overdue. Under 60-day terms it
    // plainly is not: the only thing that can be missed is the due date.
    const longAgoButNotDue = {
      status: "sent",
      due_date: TOMORROW,
      sent_at: "2026-01-01T00:00:00Z",
    };
    expect(isInvoiceOverdue(longAgoButNotDue, TODAY)).toBe(false);
  });
});

describe("isInvoiceOverdue — balance authority", () => {
  it("paid invoices are NEVER overdue, however late", () => {
    expect(isInvoiceOverdue({ status: "paid", due_date: "2020-01-01" }, TODAY)).toBe(false);
  });

  it("fully settled invoices are never overdue (the trigger stamps 'paid')", () => {
    // _tg_invoice_payments_sync_status sets 'paid' once payments reach the
    // total, so 'paid' IS "settled" — this module never re-sums payments.
    expect(isInvoiceOverdue({ status: "paid", due_date: YESTERDAY }, TODAY)).toBe(false);
  });

  it("partially paid invoices CAN be overdue — a balance remains", () => {
    expect(
      isInvoiceOverdue({ status: "partially_paid", due_date: YESTERDAY }, TODAY),
    ).toBe(true);
  });

  it("awaiting_payment invoices can be overdue", () => {
    expect(
      isInvoiceOverdue({ status: "awaiting_payment", due_date: YESTERDAY }, TODAY),
    ).toBe(true);
  });

  it("draft invoices are never overdue — never issued, nothing owed yet", () => {
    expect(isInvoiceOverdue({ status: "draft", due_date: "2020-01-01" }, TODAY)).toBe(false);
  });
});

describe("isInvoiceOverdue — degrades safely", () => {
  it("a missing due date is never overdue", () => {
    expect(isInvoiceOverdue({ status: "sent", due_date: null }, TODAY)).toBe(false);
    expect(isInvoiceOverdue({ status: "sent", due_date: undefined }, TODAY)).toBe(false);
  });

  it("a missing or unknown status is never overdue", () => {
    expect(isInvoiceOverdue({ status: null, due_date: YESTERDAY }, TODAY)).toBe(false);
    expect(isInvoiceOverdue({ status: "wat", due_date: YESTERDAY }, TODAY)).toBe(false);
  });
});

describe("legacy stored 'overdue' is still read as collectable", () => {
  it("judges a legacy overdue row on its due date like any other", () => {
    // The enum value is retained (dropping one is irreversible) and old rows
    // may carry it. Such an invoice was unpaid when marked, so it stays
    // collectable and is judged on facts rather than trusted blindly.
    expect(isInvoiceOverdue({ status: "overdue", due_date: YESTERDAY }, TODAY)).toBe(true);
    expect(isInvoiceOverdue({ status: "overdue", due_date: TOMORROW }, TODAY)).toBe(false);
  });
});

describe("status sets", () => {
  it("collectable and non-collectable partition the enum exactly", () => {
    const union = [
      ...OVERDUE_COLLECTABLE_STATUSES,
      ...OVERDUE_NON_COLLECTABLE_STATUSES,
    ].sort();
    expect(union).toEqual([...INVOICE_STATUSES].sort());
  });

  it("no status is both collectable and non-collectable", () => {
    for (const s of OVERDUE_NON_COLLECTABLE_STATUSES) {
      expect(isCollectableStatus(s)).toBe(false);
    }
    for (const s of OVERDUE_COLLECTABLE_STATUSES) {
      expect(isCollectableStatus(s)).toBe(true);
    }
  });

  it("there is no 'void' status in this schema", () => {
    // The directive's model mentioned void; the enum has no such value.
    // If one is added it must join NON_COLLECTABLE.
    expect([...INVOICE_STATUSES]).not.toContain("void");
  });
});

// =====================================================================
// Display + days
// =====================================================================

describe("invoiceDisplayStatus", () => {
  it("shows overdue for a past-due collectable invoice without storing it", () => {
    expect(invoiceDisplayStatus({ status: "sent", due_date: YESTERDAY }, TODAY)).toBe("overdue");
  });

  it("leaves every other case reading its stored status", () => {
    expect(invoiceDisplayStatus({ status: "sent", due_date: TOMORROW }, TODAY)).toBe("sent");
    expect(invoiceDisplayStatus({ status: "paid", due_date: YESTERDAY }, TODAY)).toBe("paid");
    expect(invoiceDisplayStatus({ status: "draft", due_date: YESTERDAY }, TODAY)).toBe("draft");
    expect(
      invoiceDisplayStatus({ status: "partially_paid", due_date: TOMORROW }, TODAY),
    ).toBe("partially_paid");
  });
});

describe("invoiceDaysOverdue — measured from the deadline", () => {
  it("counts days past due_date, not days since sending", () => {
    expect(invoiceDaysOverdue({ status: "sent", due_date: "2026-07-06" }, TODAY)).toBe(10);
  });

  it("is null when not overdue", () => {
    expect(invoiceDaysOverdue({ status: "sent", due_date: TOMORROW }, TODAY)).toBeNull();
    expect(invoiceDaysOverdue({ status: "paid", due_date: YESTERDAY }, TODAY)).toBeNull();
    expect(invoiceDaysOverdue({ status: "sent", due_date: null }, TODAY)).toBeNull();
  });
});

describe("invoiceBusinessToday", () => {
  it("returns a calendar day matching the due_date column's shape", () => {
    expect(invoiceBusinessToday(new Date("2026-07-16T23:59:00Z"))).toBe("2026-07-16");
    expect(invoiceBusinessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// =====================================================================
// Writers are gone
// =====================================================================

describe("no path can persist overdue any more", () => {
  it("WRITABLE_INVOICE_STATUSES excludes overdue but keeps every real state", () => {
    expect([...WRITABLE_INVOICE_STATUSES]).not.toContain("overdue");
    expect([...WRITABLE_INVOICE_STATUSES].sort()).toEqual(
      ["draft", "sent", "awaiting_payment", "partially_paid", "paid"].sort(),
    );
  });

  it("the API PATCH schema rejects status=overdue", () => {
    expect(updateInvoiceSchema.safeParse({ status: "overdue" }).success).toBe(false);
  });

  it("the API PATCH schema still accepts every writable status", () => {
    for (const s of WRITABLE_INVOICE_STATUSES) {
      expect(updateInvoiceSchema.safeParse({ status: s }).success).toBe(true);
    }
  });

  it("the status buttons offer only writable statuses", () => {
    const src = read("app/(app)/invoices/[id]/_controls.tsx");
    expect(src).toMatch(/WRITABLE_INVOICE_STATUSES\.map/);
    // Lookbehind is load-bearing: /INVOICE_STATUSES\.map/ alone matches the
    // substring inside WRITABLE_INVOICE_STATUSES.map and would fail on the
    // correct implementation.
    expect(src).not.toMatch(/(?<!WRITABLE_)INVOICE_STATUSES\.map/);
  });

  it("CSV import cannot store overdue — it maps to sent, losing nothing", () => {
    const detect = read("lib/imports/detect.ts");
    expect(detect).toMatch(/if \(\["overdue"\]\.includes\(s\)\) return "sent";/);
    const actions = read("app/(app)/imports/actions.ts");
    const fn = actions.slice(actions.indexOf("function normaliseInvoiceStatus"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/"overdue"/);
  });
});

// =====================================================================
// Every consumer uses the one authority
// =====================================================================

describe("consumers share one definition", () => {
  const consumers = [
    "app/(app)/invoices/page.tsx",
    "app/(app)/invoices/[id]/page.tsx",
    "app/customer-portal/[token]/invoices/page.tsx",
    "lib/ai/aggregates.ts",
    "server/services/retention-snapshot.ts",
  ];

  for (const p of consumers) {
    it(`${p} imports the authority`, () => {
      expect(read(p)).toMatch(/from "@\/lib\/invoices\/overdue"/);
    });
  }

  it("the dashboard delegates receivables to the shared netting authority", () => {
    // The dashboard no longer derives overdue inline NOR re-implements the
    // outstanding/overdue/due-this-week tiles by hand. It goes through
    // computeReceivables (lib/invoices/receivables), which itself uses the
    // overdue authority and nets payments — one authority, not an inline copy.
    const src = read("app/(app)/dashboard/page.tsx");
    expect(src).toMatch(/from "@\/lib\/invoices\/receivables"/);
    expect(src).toMatch(/computeReceivables\(/);
    // The old inline predicates must be gone from the CODE.
    expect(readCode("app/(app)/dashboard/page.tsx")).not.toMatch(/due_date < todayIso/);
  });

  it("the AI aggregates no longer use sent_at + 30d", () => {
    expect(read("lib/ai/aggregates.ts")).toMatch(/isInvoiceOverdue\(inv, todayIso\)/);
    const code = readCode("lib/ai/aggregates.ts");
    expect(code).not.toMatch(/thirtyDaysAgo/);
    expect(code).not.toMatch(/inv\.sent_at < /);
  });

  it("retention counts derived overdue, not the stored value", () => {
    const src = read("server/services/retention-snapshot.ts");
    expect(src).toMatch(/OVERDUE_COLLECTABLE_STATUSES/);
    expect(src).toMatch(/\.lt\("due_date", invoiceBusinessToday\(\)\)/);
    // The stored-value filter must be gone from the CODE (the comment above it
    // quotes the old predicate to explain the change).
    expect(readCode("server/services/retention-snapshot.ts")).not.toMatch(
      /\.eq\("status", "overdue"\)/,
    );
  });
});

describe("dashboard tile and its drill-through select the same population", () => {
  it("the list filter expresses the authority's predicate at the DB", () => {
    const src = read("app/(app)/invoices/page.tsx");
    // .eq("status","overdue") returned only manually-marked rows — a different
    // population from the tile's count. It must be the derived predicate.
    expect(src).toMatch(/if \(status === "overdue"\)/);
    expect(src).toMatch(/\.in\("status", OVERDUE_COLLECTABLE_STATUSES/);
    expect(src).toMatch(/\.lt\("due_date", todayIso\)/);
  });

  it("the dashboard Outstanding tile uses the collectable set and nets payments — NOT the sent/overdue gross gate", () => {
    // This pin previously ACCEPTED the buggy `inv.status === "sent" || inv.status
    // === "overdue"` gate that summed gross `total`. That gate is why a
    // partially_paid deposit invoice vanished from Outstanding while being counted
    // overdue at full gross. The corrected dashboard must:
    const code = readCode("app/(app)/dashboard/page.tsx");
    // (a) no longer carry the narrow sent/overdue outstanding gate;
    expect(code).not.toMatch(/inv\.status === "sent" \|\| inv\.status === "overdue"/);
    // (b) net the ledger — it builds a per-invoice paid map and hands it to the authority;
    expect(code).toMatch(/paidByInvoice/);
    expect(code).toMatch(/paid: paidByInvoice\.get\(inv\.id\)/);
    // (c) point the Outstanding drill-through at the true outstanding population,
    //     never `?status=sent` (which drops awaiting_payment / partially_paid).
    expect(code).not.toMatch(/invoices\?status=sent/);
    expect(code).toMatch(/invoices\?status=outstanding/);
  });

  it("both select exactly the collectable statuses the authority accepts", () => {
    for (const s of OVERDUE_COLLECTABLE_STATUSES) {
      expect(isInvoiceOverdue({ status: s, due_date: YESTERDAY }, TODAY)).toBe(true);
    }
    for (const s of OVERDUE_NON_COLLECTABLE_STATUSES) {
      expect(isInvoiceOverdue({ status: s, due_date: YESTERDAY }, TODAY)).toBe(false);
    }
  });

  it("the /invoices list resolves the dashboard's ?status=outstanding drill-through to the canonical set", () => {
    const src = read("app/(app)/invoices/page.tsx");
    expect(src).toMatch(/status === "outstanding"/);
    expect(src).toMatch(/\.in\("status", OUTSTANDING_STATUSES/);
  });
});

// =====================================================================
// The receivables-netting authority — one authority, all surfaces agree
// =====================================================================

describe("computeReceivables — the shared netting authority", () => {
  const NOW = new Date("2026-07-16T12:00:00Z"); // TODAY = 2026-07-16

  it("nets a partial payment: a £10k invoice with a £3k deposit owes £7k, not £10k", () => {
    // partially_paid is what the payment-sync trigger stamps on ANY deposit.
    const r = computeReceivables(
      [{ status: "partially_paid", total: 10000, due_date: TOMORROW, paid: 3000 }],
      NOW,
    );
    expect(r.outstandingTotal).toBe(7000);
    expect(r.outstandingCount).toBe(1);
    expect(r.expectedIncoming).toBe(7000);
  });

  it("keeps the trigger-stamped statuses the old sent/overdue gate dropped", () => {
    for (const status of ["awaiting_payment", "partially_paid"]) {
      const r = computeReceivables([{ status, total: 500, due_date: TOMORROW, paid: 0 }], NOW);
      expect(r.outstandingTotal).toBe(500);
    }
    expect(isOutstandingStatus("awaiting_payment")).toBe(true);
    expect(isOutstandingStatus("partially_paid")).toBe(true);
  });

  it("excludes draft (not issued) and paid (settled) from the debtor book", () => {
    const r = computeReceivables(
      [
        { status: "draft", total: 9999, due_date: YESTERDAY, paid: 0 },
        { status: "paid", total: 4321, due_date: YESTERDAY, paid: 4321 },
      ],
      NOW,
    );
    expect(r.outstandingTotal).toBe(0);
    expect(r.outstandingCount).toBe(0);
  });

  it("Outstanding is always a SUPERSET of Overdue — both netted", () => {
    // A partially_paid invoice past due contributes its NET balance to BOTH.
    const r = computeReceivables(
      [{ status: "partially_paid", total: 10000, due_date: YESTERDAY, paid: 3000 }],
      NOW,
    );
    expect(r.overdueTotal).toBe(7000);
    expect(r.outstandingTotal).toBe(7000);
    expect(r.outstandingTotal).toBeGreaterThanOrEqual(r.overdueTotal);
  });

  it("never lets an overpayment on one invoice pay down another (per-invoice cap)", () => {
    const r = computeReceivables(
      [
        { status: "sent", total: 100, due_date: TOMORROW, paid: 500 }, // capped at 0
        { status: "sent", total: 400, due_date: TOMORROW, paid: 0 },
      ],
      NOW,
    );
    expect(r.outstandingTotal).toBe(400);
    expect(invoiceRemaining({ total: 100, paid: 500 })).toBe(0);
  });
});

describe("cross-surface consistency — dashboard, /cash and the customer portal agree", () => {
  const NOW = new Date("2026-07-16T12:00:00Z");
  // ONE partially-paid, past-due fixture: £10k billed, £3k received → £7k owed.
  const total = 10000;
  const paid = 3000;
  const REMAINING = 7000;

  it("all three receivables authorities reconcile on the same £7k for a partially-paid invoice", () => {
    // Dashboard authority.
    const dash = computeReceivables(
      [{ status: "partially_paid", total, due_date: YESTERDAY, paid }],
      NOW,
    );

    // /cash authority (no retention → collectableNow === owedNow).
    const cashInvoice: OrgCashInvoice = {
      id: "inv-1", number: "INV-1", status: "partially_paid",
      total, due_date: YESTERDAY, paid, jobId: null, jobLabel: null,
    };
    const cash = computeOrgCashSummary({
      invoices: [cashInvoice],
      retentionHeld: 0, retentionDueNow: 0, readyToInvoice: 0, now: NOW,
    });

    // Customer-portal authority.
    const portal = computePortalPayments(
      [{ status: "partially_paid", total, due_date: YESTERDAY, paid }],
      NOW,
    );

    // Outstanding / owed / dueNow all agree to the penny.
    expect(dash.outstandingTotal).toBe(REMAINING);
    expect(cash.owedNow).toBe(REMAINING);
    expect(cash.collectableNow).toBe(REMAINING);
    expect(portal.dueNow).toBe(REMAINING);
    expect(new Set([dash.outstandingTotal, cash.owedNow, cash.collectableNow, portal.dueNow]).size).toBe(1);

    // And the overdue portion agrees too.
    expect(dash.overdueTotal).toBe(REMAINING);
    expect(cash.overdue).toBe(REMAINING);
    expect(portal.overdue).toBe(REMAINING);
  });

  it("the PRE-FIX dashboard logic would have DISAGREED — proving the class defect", () => {
    // Replicate the exact removed dashboard code: gross `total`, gate on
    // sent/overdue only, overdue counted at gross outside the gate.
    const inv = { status: "partially_paid", total, due_date: YESTERDAY };
    let preOutstanding = 0;
    let preOverdue = 0;
    if (isInvoiceOverdue(inv, TODAY)) preOverdue += inv.total; // gross
    if (inv.status === "sent" || inv.status === "overdue") preOutstanding += inv.total;

    // Outstanding DROPPED the invoice entirely (partially_paid not in the gate)…
    expect(preOutstanding).toBe(0);
    // …while Overdue counted it at FULL GROSS — Outstanding was not a superset.
    expect(preOverdue).toBe(10000);
    // Both are wrong; the netted authority says £7k for both.
    expect(preOutstanding).not.toBe(REMAINING);
    expect(preOverdue).not.toBe(REMAINING);
  });
});

// =====================================================================
// Static class guard — every operator money-receivables surface must
// route through the shared authority (net + canonical status set)
// =====================================================================

describe("operator receivables surfaces route through the shared authority", () => {
  // Each surface computes an outstanding/overdue/receivable/expected-income
  // figure from customer invoices. Every one must reference the shared authority
  // (computeReceivables or its invoiceRemaining primitive) rather than summing
  // gross `inv.total` over a hardcoded status subset.
  const surfaces: Array<{ path: string; token: RegExp }> = [
    { path: "app/(app)/dashboard/page.tsx", token: /computeReceivables/ },
    { path: "app/(app)/payments/page.tsx", token: /computeReceivables/ },
    { path: "lib/customers/financials.ts", token: /computeReceivables/ },
    { path: "server/services/briefing.ts", token: /invoiceRemaining/ },
    // Already-correct authorities that own the primitive.
    { path: "lib/commercial/org-cash.ts", token: /invoiceRemaining/ },
    { path: "lib/commercial/cash.ts", token: /Math\.max\(0, toPounds\(inv\.total\)/ },
  ];

  for (const { path, token } of surfaces) {
    it(`${path} nets receivables via the shared rule`, () => {
      expect(readCode(path)).toMatch(token);
    });
  }

  it("the /payments Outstanding headline no longer sums gross invoice totals", () => {
    // The removed defect: `.reduce((s, i) => s + Number(i.total ?? 0), 0)`.
    const code = readCode("app/(app)/payments/page.tsx");
    expect(code).not.toMatch(/reduce\(\s*\(s, i\) => s \+ Number\(i\.total/);
  });

  it("the org-cash COLLECTABLE set derives from OUTSTANDING_STATUSES, not a hardcoded subset", () => {
    const code = readCode("lib/commercial/org-cash.ts");
    expect(code).toMatch(/new Set<string>\(OUTSTANDING_STATUSES\)/);
    expect(code).not.toMatch(/new Set\(\["sent", "awaiting_payment"/);
  });
});
