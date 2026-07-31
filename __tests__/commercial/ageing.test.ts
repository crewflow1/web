import { describe, it, expect } from "vitest";
import {
  AGEING_BUCKETS,
  bucketForAgeDays,
  buildAgeingLedger,
  isPastDueBucket,
  type AgeingItem,
} from "@/lib/commercial/ageing";

/**
 * The ageing bucketer — boundary convention, aggregation and ordering.
 *
 * The boundaries are the whole point of an aged listing and the one thing two
 * implementations always disagree about, so every edge is pinned explicitly
 * rather than sampled: 0/1, 30/31, 60/61 and 90/91. Getting 30 wrong moves real
 * money between two columns that a credit controller reads differently.
 */

let seq = 0;
function item(over: Partial<AgeingItem> = {}): AgeingItem {
  seq += 1;
  return {
    id: `doc-${seq}`,
    partyId: "cust-1",
    partyName: "Acme Developments",
    amount: 100,
    ageDays: 0,
    reference: `INV-${seq}`,
    dateIso: "2026-07-01",
    href: "/invoices/x",
    ...over,
  };
}

describe("the boundary convention — closed on the right, current at <= 0", () => {
  it("money due TODAY is current, not 1-30", () => {
    // Mirrors isInvoiceOverdue: `due_date < today`, strictly. Nothing is late on
    // the day it falls due.
    expect(bucketForAgeDays(0)).toBe("current");
  });

  it("one day past due is the first past-due bucket", () => {
    expect(bucketForAgeDays(1)).toBe("d1_30");
  });

  it("EXACTLY 30 days past due is 1-30, and 31 is 31-60", () => {
    expect(bucketForAgeDays(30)).toBe("d1_30");
    expect(bucketForAgeDays(31)).toBe("d31_60");
  });

  it("EXACTLY 60 days is 31-60, and 61 is 61-90", () => {
    expect(bucketForAgeDays(60)).toBe("d31_60");
    expect(bucketForAgeDays(61)).toBe("d61_90");
  });

  it("EXACTLY 90 days is 61-90, and 91 is 90+", () => {
    expect(bucketForAgeDays(90)).toBe("d61_90");
    expect(bucketForAgeDays(91)).toBe("d91_plus");
  });

  it("not yet due (negative) is current", () => {
    expect(bucketForAgeDays(-1)).toBe("current");
    expect(bucketForAgeDays(-400)).toBe("current");
  });

  it("undated is current — it cannot be overdue with no deadline", () => {
    expect(bucketForAgeDays(null)).toBe("current");
    expect(bucketForAgeDays(undefined)).toBe("current");
  });

  it("degrades safely on a non-finite age rather than throwing", () => {
    expect(bucketForAgeDays(Number.NaN)).toBe("current");
    expect(bucketForAgeDays(Number.POSITIVE_INFINITY)).toBe("current");
  });

  it("current is NOT a past-due bucket; the other four are", () => {
    expect(isPastDueBucket("current")).toBe(false);
    for (const b of AGEING_BUCKETS.filter((x) => x !== "current")) {
      expect(isPastDueBucket(b)).toBe(true);
    }
  });
});

describe("aggregation", () => {
  it("splits one party's items across the right columns and totals them", () => {
    const ledger = buildAgeingLedger([
      item({ amount: 1000, ageDays: 0 }),
      item({ amount: 250.55, ageDays: 30 }),
      item({ amount: 100.45, ageDays: 31 }),
      item({ amount: 500, ageDays: 75 }),
      item({ amount: 2000, ageDays: 400 }),
    ]);

    expect(ledger.rows).toHaveLength(1);
    const row = ledger.rows[0]!;
    expect(row.buckets).toEqual({
      current: 1000,
      d1_30: 250.55,
      d31_60: 100.45,
      d61_90: 500,
      d91_plus: 2000,
    });
    expect(row.total).toBe(3851);
    expect(row.pastDue).toBe(2851);
    expect(row.oldestAgeDays).toBe(400);
    expect(row.itemCount).toBe(5);
  });

  it("totals equal the sum of the rows, column by column", () => {
    const ledger = buildAgeingLedger([
      item({ partyId: "a", partyName: "A", amount: 10.01, ageDays: 5 }),
      item({ partyId: "b", partyName: "B", amount: 20.02, ageDays: 5 }),
      item({ partyId: "c", partyName: "C", amount: 0.97, ageDays: 100 }),
    ]);
    expect(ledger.totals.buckets.d1_30).toBe(30.03);
    expect(ledger.totals.buckets.d91_plus).toBe(0.97);
    expect(ledger.totals.total).toBe(31);
    expect(ledger.totals.pastDue).toBe(31);
    expect(ledger.totals.partyCount).toBe(3);
    expect(ledger.totals.itemCount).toBe(3);
  });

  it("keeps pennies exact across many small items (no float drift)", () => {
    const items = Array.from({ length: 300 }, () => item({ amount: 0.01, ageDays: 10 }));
    const ledger = buildAgeingLedger(items);
    expect(ledger.totals.total).toBe(3);
    expect(ledger.totals.buckets.d1_30).toBe(3);
  });

  it("groups by party, never by name — two customers may share a name", () => {
    const ledger = buildAgeingLedger([
      item({ partyId: "c1", partyName: "J Smith Ltd", amount: 100, ageDays: 5 }),
      item({ partyId: "c2", partyName: "J Smith Ltd", amount: 100, ageDays: 5 }),
    ]);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.totals.partyCount).toBe(2);
  });

  it("collects items with no party under one unattributed row", () => {
    const ledger = buildAgeingLedger([
      item({ partyId: "", partyName: "Unattributed", amount: 40, ageDays: 5 }),
      item({ partyId: "", partyName: "Unattributed", amount: 60, ageDays: 5 }),
    ]);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.total).toBe(100);
  });
});

describe("what never appears", () => {
  it("drops fully settled documents rather than showing zero rows", () => {
    const ledger = buildAgeingLedger([
      item({ amount: 0, ageDays: 90 }),
      item({ amount: 500, ageDays: 90 }),
    ]);
    expect(ledger.totals.itemCount).toBe(1);
    expect(ledger.rows[0]!.items).toHaveLength(1);
  });

  it("drops a negative amount — an overpayment is not a debtor", () => {
    const ledger = buildAgeingLedger([item({ amount: -250, ageDays: 90 })]);
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.totals.total).toBe(0);
  });

  it("returns an all-zero ledger for no items at all", () => {
    const ledger = buildAgeingLedger([]);
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.totals.total).toBe(0);
    expect(ledger.totals.pastDue).toBe(0);
    expect(ledger.totals.undated).toBe(0);
  });
});

describe("undated debt is disclosed, not laundered", () => {
  it("counts in `current` AND is reported separately as `undated`", () => {
    const ledger = buildAgeingLedger([
      item({ amount: 900, ageDays: null, dateIso: null }),
      item({ amount: 100, ageDays: 0 }),
    ]);
    expect(ledger.totals.buckets.current).toBe(1000);
    expect(ledger.totals.undated).toBe(900);
    expect(ledger.rows[0]!.undated).toBe(900);
  });

  it("an all-undated party has a null oldestAgeDays, never 0", () => {
    // 0 would read as "due today" on a document that has no deadline at all.
    const ledger = buildAgeingLedger([item({ amount: 100, ageDays: null })]);
    expect(ledger.rows[0]!.oldestAgeDays).toBeNull();
  });
});

describe("deterministic order — a report that reshuffles is a report nobody trusts", () => {
  it("rows are most-past-due first, then largest total", () => {
    const ledger = buildAgeingLedger([
      item({ partyId: "small-late", partyName: "Small Late", amount: 100, ageDays: 95 }),
      item({ partyId: "big-current", partyName: "Big Current", amount: 90_000, ageDays: 0 }),
      item({ partyId: "bigger-late", partyName: "Bigger Late", amount: 5_000, ageDays: 2 }),
    ]);
    expect(ledger.rows.map((r) => r.partyId)).toEqual([
      "bigger-late",
      "small-late",
      "big-current",
    ]);
  });

  it("ties break by name then partyId, so the order is total", () => {
    const a = buildAgeingLedger([
      item({ partyId: "z", partyName: "Same Name", amount: 100, ageDays: 10 }),
      item({ partyId: "a", partyName: "Same Name", amount: 100, ageDays: 10 }),
    ]);
    const b = buildAgeingLedger([
      item({ partyId: "a", partyName: "Same Name", amount: 100, ageDays: 10 }),
      item({ partyId: "z", partyName: "Same Name", amount: 100, ageDays: 10 }),
    ]);
    expect(a.rows.map((r) => r.partyId)).toEqual(["a", "z"]);
    expect(b.rows.map((r) => r.partyId)).toEqual(["a", "z"]);
  });

  it("items within a row are oldest first, with undated last", () => {
    const ledger = buildAgeingLedger([
      item({ id: "i-undated", amount: 10, ageDays: null }),
      item({ id: "i-new", amount: 10, ageDays: 1 }),
      item({ id: "i-old", amount: 10, ageDays: 200 }),
    ]);
    expect(ledger.rows[0]!.items.map((i) => i.id)).toEqual(["i-old", "i-new", "i-undated"]);
  });
});
