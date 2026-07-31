import { describe, it, expect } from "vitest";
import { round2 } from "@/lib/money";
import { computeOrgCashSummary, type OrgCashInvoice } from "@/lib/commercial/org-cash";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import { composeAgedDebtors, type DebtorInvoice } from "@/lib/commercial/aged-debtors";
import { AGEING_BUCKETS } from "@/lib/commercial/ageing";

/**
 * RECONCILIATION — aged debtors must not be a second, disagreeing answer.
 *
 * /cash already tells the business what it is owed and how much of that is late.
 * A report that produces a different figure for either is worse than no report:
 * the operator has no way to know which one to believe, and one of them is being
 * used to make decisions. So the two identities are asserted, not assumed:
 *
 *     debtors.totals.total   === computeOrgCashSummary(...).owedNow
 *     debtors.totals.pastDue === computeOrgCashSummary(...).overdue
 *
 * The interesting half of this test is the EXHAUSTIVE matrix: every invoice
 * status crossed with every settlement level and every due-date position. A
 * happy-path fixture proves the two agree about invoices they both include; the
 * matrix proves they agree about the ones that must be EXCLUDED, which is where
 * a divergence would actually hide. If someone changes the collectable-status set
 * in `lib/invoices/overdue`, or `invoiceRemaining`'s per-invoice cap, or the
 * zero-skip in either module, this file goes red.
 */

// Fixed instant → a fixed business day, so the fixtures below have stable ages.
const NOW = new Date("2026-07-30T09:00:00Z");
const AS_AT = invoiceBusinessToday(NOW);

/** Every value the `invoice_status` enum can hold (see lib/invoices/overdue). */
const ALL_STATUSES = [
  "draft",
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  "overdue",
] as const;

type Fixture = {
  id: string;
  status: string;
  total: number;
  paid: number;
  due_date: string | null;
  customer_id: string | null;
  job_id: string | null;
};

const NAMING = {
  customerName: new Map([
    ["cust-a", "Acme Developments"],
    ["cust-b", "Barnsley Builders"],
  ]),
  jobCustomer: new Map<string, string | null>([
    ["job-1", "cust-a"],
    ["job-orphan", null],
  ]),
};

function toDebtor(f: Fixture): DebtorInvoice {
  return {
    id: f.id,
    number: `INV-${f.id}`,
    status: f.status,
    total: f.total,
    due_date: f.due_date,
    customer_id: f.customer_id,
    job_id: f.job_id,
    paid: f.paid,
  };
}

function toCash(f: Fixture): OrgCashInvoice {
  return {
    id: f.id,
    number: `INV-${f.id}`,
    status: f.status,
    total: f.total,
    due_date: f.due_date,
    paid: f.paid,
    jobId: f.job_id,
    jobLabel: null,
  };
}

/** Both sides of the books for the same fixture set. */
function bothSides(fixtures: Fixture[]) {
  const debtors = composeAgedDebtors(fixtures.map(toDebtor), NAMING, AS_AT);
  const summary = computeOrgCashSummary({
    invoices: fixtures.map(toCash),
    retentionHeld: 0,
    retentionDueNow: 0,
    readyToInvoice: 0,
    now: NOW,
  });
  return { debtors, summary };
}

describe("the exhaustive matrix — every status × settlement × due-date position", () => {
  // 6 statuses × 4 settlement levels × 4 due-date positions = 96 invoices,
  // deliberately including the combinations both modules must ignore.
  const DUE_DATES: Array<string | null> = [
    null, // undated — can never be overdue
    "2026-12-31", // future — within terms
    AS_AT, // due exactly today — not late
    "2026-01-05", // 206 days late
  ];
  const SETTLEMENTS: Array<[label: string, total: number, paid: number]> = [
    ["unpaid", 1200, 0],
    ["part-paid", 1200, 450.5],
    ["settled", 1200, 1200],
    ["overpaid", 1200, 1500],
  ];

  const fixtures: Fixture[] = [];
  for (const status of ALL_STATUSES) {
    for (const [label, total, paid] of SETTLEMENTS) {
      for (const [i, due] of DUE_DATES.entries()) {
        fixtures.push({
          id: `${status}-${label}-${i}`,
          status,
          total,
          paid,
          due_date: due,
          customer_id: "cust-a",
          job_id: "job-1",
        });
      }
    }
  }

  const { debtors, summary } = bothSides(fixtures);

  it("has a non-trivial fixture set (a vacuous 0 === 0 would prove nothing)", () => {
    expect(fixtures).toHaveLength(96);
    expect(debtors.totals.total).toBeGreaterThan(0);
    expect(debtors.totals.pastDue).toBeGreaterThan(0);
    expect(debtors.totals.buckets.current).toBeGreaterThan(0);
  });

  it("aged debtors total === the cash service's owedNow", () => {
    expect(debtors.totals.total).toBe(summary.owedNow);
  });

  it("aged past-due total === the cash service's overdue", () => {
    expect(debtors.totals.pastDue).toBe(summary.overdue);
  });

  it("current === owedNow − overdue, so the columns partition the whole book", () => {
    expect(debtors.totals.buckets.current).toBe(round2(summary.owedNow - summary.overdue));
  });

  it("the five columns sum to the total", () => {
    const summed = AGEING_BUCKETS.reduce(
      (acc, b) => round2(acc + debtors.totals.buckets[b]),
      0,
    );
    expect(summed).toBe(debtors.totals.total);
  });

  it("the item count matches the cash service's invoice count", () => {
    expect(debtors.totals.itemCount).toBe(summary.invoiceCount);
  });

  it("past-due items count matches the cash service's overdueCount", () => {
    const pastDueItems = debtors.rows
      .flatMap((r) => r.items)
      .filter((i) => i.ageDays != null && i.ageDays > 0);
    expect(pastDueItems).toHaveLength(summary.overdueCount);
  });
});

describe("the exclusions both modules must agree on", () => {
  it("draft invoices are in neither figure", () => {
    const { debtors, summary } = bothSides([
      { id: "d1", status: "draft", total: 5000, paid: 0, due_date: "2026-01-01", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(0);
    expect(summary.owedNow).toBe(0);
  });

  it("a fully settled invoice is in neither figure", () => {
    const { debtors, summary } = bothSides([
      { id: "p1", status: "paid", total: 5000, paid: 5000, due_date: "2026-01-01", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(0);
    expect(summary.owedNow).toBe(0);
  });

  it("an OVERPAID invoice contributes nothing — it is not a negative debtor", () => {
    const { debtors, summary } = bothSides([
      { id: "o1", status: "partially_paid", total: 1000, paid: 1400, due_date: "2026-01-01", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(0);
    expect(summary.owedNow).toBe(0);
  });

  it("one invoice's overpayment never pays down another's balance", () => {
    // The exact defect computeCommercialCash exists to fix, re-proved on the
    // ageing path: £400 overpaid on A must not reduce B's £1,000.
    const { debtors, summary } = bothSides([
      { id: "a", status: "partially_paid", total: 1000, paid: 1400, due_date: "2026-01-01", customer_id: "cust-a", job_id: null },
      { id: "b", status: "sent", total: 1000, paid: 0, due_date: "2026-01-01", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(1000);
    expect(summary.owedNow).toBe(1000);
  });

  it("a part-paid invoice ages only the REMAINING balance, not the total", () => {
    const { debtors, summary } = bothSides([
      { id: "pp", status: "partially_paid", total: 12_000, paid: 4_500, due_date: "2026-06-15", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(7_500);
    expect(summary.owedNow).toBe(7_500);
    // 2026-06-15 → 2026-07-30 is 45 days.
    expect(debtors.totals.buckets.d31_60).toBe(7_500);
  });

  it("the legacy stored `overdue` status is judged on its due date, not its name", () => {
    // OVERDUE_COLLECTABLE_STATUSES keeps `overdue` readable; a row carrying it
    // with a FUTURE due date is not late, and neither module may say it is.
    const { debtors, summary } = bothSides([
      { id: "legacy", status: "overdue", total: 800, paid: 0, due_date: "2026-12-31", customer_id: "cust-a", job_id: null },
    ]);
    expect(debtors.totals.total).toBe(800);
    expect(debtors.totals.pastDue).toBe(0);
    expect(summary.overdue).toBe(0);
  });
});

describe("customer attribution", () => {
  it("uses the invoice's own customer when it has one", () => {
    const { debtors } = bothSides([
      { id: "i1", status: "sent", total: 100, paid: 0, due_date: null, customer_id: "cust-b", job_id: "job-1" },
    ]);
    expect(debtors.rows[0]!.partyId).toBe("cust-b");
    expect(debtors.rows[0]!.partyName).toBe("Barnsley Builders");
  });

  it("falls back to the JOB's customer for a pre-backfill invoice", () => {
    // 20260915000000 left customer_id nullable for orphans. Real debt must not
    // be exiled to "Unattributed" — that customer would never get chased.
    const { debtors } = bothSides([
      { id: "i2", status: "sent", total: 100, paid: 0, due_date: null, customer_id: null, job_id: "job-1" },
    ]);
    expect(debtors.rows[0]!.partyId).toBe("cust-a");
  });

  it("still counts debt it cannot attribute, under one visible row", () => {
    const { debtors, summary } = bothSides([
      { id: "i3", status: "sent", total: 250, paid: 0, due_date: null, customer_id: null, job_id: "job-orphan" },
      { id: "i4", status: "sent", total: 250, paid: 0, due_date: null, customer_id: null, job_id: null },
    ]);
    expect(debtors.rows).toHaveLength(1);
    expect(debtors.rows[0]!.partyName).toBe("Unattributed");
    expect(debtors.totals.total).toBe(500);
    // Attribution never changes the reconciled total.
    expect(debtors.totals.total).toBe(summary.owedNow);
  });

  it("splitting one customer's debt across two orgs' names cannot merge rows", () => {
    // Two distinct customer ids that happen to share a trading name stay two
    // rows — grouping is by id, never by name.
    const naming = {
      customerName: new Map([
        ["cust-x", "J Smith Ltd"],
        ["cust-y", "J Smith Ltd"],
      ]),
      jobCustomer: new Map<string, string | null>(),
    };
    const ledger = composeAgedDebtors(
      [
        { id: "a", number: "A", status: "sent", total: 100, due_date: null, customer_id: "cust-x", job_id: null, paid: 0 },
        { id: "b", number: "B", status: "sent", total: 100, due_date: null, customer_id: "cust-y", job_id: null, paid: 0 },
      ],
      naming,
      AS_AT,
    );
    expect(ledger.rows).toHaveLength(2);
  });
});

describe("reconciliation holds under retention netting too", () => {
  it("the aged total tracks owedNow, NOT collectableNow", () => {
    // /cash headlines `collectableNow` (owedNow less retention embedded in unpaid
    // balances). An aged debtor listing is the invoice book, so it must reconcile
    // to owedNow — reconciling to collectableNow would silently drop retention
    // from a report an accountant ties to the sales ledger.
    const fixtures: Fixture[] = [
      { id: "r1", status: "sent", total: 10_000, paid: 0, due_date: "2026-01-01", customer_id: "cust-a", job_id: "job-1" },
    ];
    const debtors = composeAgedDebtors(fixtures.map(toDebtor), NAMING, AS_AT);
    const summary = computeOrgCashSummary({
      invoices: fixtures.map(toCash),
      retentionHeld: 500,
      retentionDueNow: 0,
      retentionWithheldFromCollectable: 500,
      readyToInvoice: 0,
      now: NOW,
    });
    expect(debtors.totals.total).toBe(summary.owedNow);
    expect(debtors.totals.total).toBe(10_000);
    expect(summary.collectableNow).toBe(9_500);
  });
});
