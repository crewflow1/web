import { describe, it, expect } from "vitest";
import {
  mapTransactionToLine,
  mapStatementToLines,
  normalizeTrueLayerTransactions,
  type AggregatorTransaction,
  type AggregatorStatement,
  type TrueLayerTransaction,
} from "@/lib/integrations/banking/statement-map";

/**
 * Bank-feed statement mapper — PURE mapper unit proofs (20261100).
 *
 * The mapper is the deterministic seam that turns aggregator-fetched transactions
 * into `bank_statement_lines` rows so the EXISTING reconciliation UI lights up at
 * activation. These tests pin the sign convention (credit=+, debit=−, matching
 * bank_statement_lines: positive = incoming), calendar-day extraction, the
 * reference fallback, org/statement pinning, and the TrueLayer normaliser.
 */

const TARGET = {
  orgId: "11111111-1111-1111-1111-111111111111",
  bankStatementId: "22222222-2222-2222-2222-222222222222",
};

function tx(over: Partial<AggregatorTransaction>): AggregatorTransaction {
  return {
    id: "tx-1",
    bookedAt: "2026-07-15T09:30:00Z",
    amount: 100,
    direction: "credit",
    description: "ACME LTD PAYMENT",
    reference: "INV-0001",
    ...over,
  };
}

describe("mapTransactionToLine — sign convention (positive = incoming)", () => {
  it("a CREDIT maps to a POSITIVE amount", () => {
    const row = mapTransactionToLine(tx({ amount: 250.5, direction: "credit" }), TARGET);
    expect(row.amount).toBe(250.5);
  });

  it("a DEBIT maps to a NEGATIVE amount", () => {
    const row = mapTransactionToLine(tx({ amount: 250.5, direction: "debit" }), TARGET);
    expect(row.amount).toBe(-250.5);
  });

  it("takes the ABSOLUTE magnitude so an already-signed source cannot double-negate", () => {
    // Source erroneously provides a negative magnitude with an explicit direction.
    const credit = mapTransactionToLine(tx({ amount: -80, direction: "credit" }), TARGET);
    expect(credit.amount).toBe(80);
    const debit = mapTransactionToLine(tx({ amount: -80, direction: "debit" }), TARGET);
    expect(debit.amount).toBe(-80);
  });

  it("rounds to 2dp (pence) and normalises negative zero", () => {
    expect(mapTransactionToLine(tx({ amount: 10.005, direction: "credit" }), TARGET).amount).toBe(
      10.01,
    );
    expect(mapTransactionToLine(tx({ amount: 0, direction: "debit" }), TARGET).amount).toBe(0);
    expect(Object.is(mapTransactionToLine(tx({ amount: 0, direction: "debit" }), TARGET).amount, -0)).toBe(
      false,
    );
  });

  it("degrades a non-finite amount to 0 rather than NaN", () => {
    const row = mapTransactionToLine(
      tx({ amount: Number.NaN, direction: "credit" }),
      TARGET,
    );
    expect(row.amount).toBe(0);
  });
});

describe("mapTransactionToLine — dates, references, pinning", () => {
  it("slices an ISO timestamp to the calendar day (posted_at)", () => {
    const row = mapTransactionToLine(tx({ bookedAt: "2026-01-31T23:59:59Z" }), TARGET);
    expect(row.posted_at).toBe("2026-01-31");
  });

  it("passes a plain date through unchanged", () => {
    const row = mapTransactionToLine(tx({ bookedAt: "2026-02-01" }), TARGET);
    expect(row.posted_at).toBe("2026-02-01");
  });

  it("empty booking date maps to empty posted_at (no crash)", () => {
    const row = mapTransactionToLine(tx({ bookedAt: "" }), TARGET);
    expect(row.posted_at).toBe("");
  });

  it("falls back to the transaction id when no reference is given", () => {
    const row = mapTransactionToLine(tx({ reference: null, id: "tx-xyz" }), TARGET);
    expect(row.reference).toBe("tx-xyz");
  });

  it("prefers an explicit reference over the id", () => {
    const row = mapTransactionToLine(tx({ reference: "PO-42", id: "tx-xyz" }), TARGET);
    expect(row.reference).toBe("PO-42");
  });

  it("passes description through, null when absent", () => {
    expect(mapTransactionToLine(tx({ description: "TESCO" }), TARGET).description).toBe("TESCO");
    expect(mapTransactionToLine(tx({ description: null }), TARGET).description).toBeNull();
  });

  it("pins org_id and bank_statement_id from the target", () => {
    const row = mapTransactionToLine(tx({}), TARGET);
    expect(row.org_id).toBe(TARGET.orgId);
    expect(row.bank_statement_id).toBe(TARGET.bankStatementId);
  });

  it("carries the aggregator tx id as provider_tx_id (the dedupe key)", () => {
    const row = mapTransactionToLine(tx({ id: "tl-77" }), TARGET);
    expect(row.provider_tx_id).toBe("tl-77");
  });
});

describe("mapStatementToLines — whole statement", () => {
  it("maps every transaction, preserving order, into bank_statement_lines rows", () => {
    const statement: AggregatorStatement = {
      accountId: "acct-1",
      accountName: "Business Current",
      transactions: [
        tx({ id: "a", amount: 100, direction: "credit", bookedAt: "2026-07-01" }),
        tx({ id: "b", amount: 40, direction: "debit", bookedAt: "2026-07-02" }),
      ],
    };
    const rows = mapStatementToLines(statement, TARGET);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      org_id: TARGET.orgId,
      bank_statement_id: TARGET.bankStatementId,
      posted_at: "2026-07-01",
      amount: 100,
      description: "ACME LTD PAYMENT",
      reference: "INV-0001",
      provider_tx_id: "a",
    });
    expect(rows[1]!.amount).toBe(-40);
    expect(rows[1]!.posted_at).toBe("2026-07-02");
  });

  it("an empty statement maps to no rows", () => {
    expect(
      mapStatementToLines({ accountId: "x", transactions: [] }, TARGET),
    ).toHaveLength(0);
  });
});

describe("normalizeTrueLayerTransactions — native shape → agnostic shape", () => {
  function tl(over: Partial<TrueLayerTransaction>): TrueLayerTransaction {
    return {
      transaction_id: "tl-1",
      timestamp: "2026-07-10T12:00:00Z",
      amount: -25.99, // TrueLayer signs: negative = money out
      description: "COFFEE SHOP",
      transaction_type: "DEBIT",
      meta: { provider_reference: "REF-9" },
      ...over,
    };
  }

  it("uses transaction_type when present (authoritative direction)", () => {
    const c = normalizeTrueLayerTransactions([tl({ transaction_type: "CREDIT", amount: -50 })])[0]!;
    expect(c.direction).toBe("credit");
    const d = normalizeTrueLayerTransactions([tl({ transaction_type: "DEBIT", amount: 50 })])[0]!;
    expect(d.direction).toBe("debit");
  });

  it("derives direction from the signed amount when type is absent", () => {
    const pos = normalizeTrueLayerTransactions([tl({ transaction_type: null, amount: 30 })])[0]!;
    expect(pos.direction).toBe("credit");
    const neg = normalizeTrueLayerTransactions([tl({ transaction_type: null, amount: -30 })])[0]!;
    expect(neg.direction).toBe("debit");
  });

  it("emits an ABSOLUTE amount + carries id, date and reference", () => {
    const n = normalizeTrueLayerTransactions([tl({})])[0]!;
    expect(n.amount).toBe(25.99);
    expect(n.id).toBe("tl-1");
    expect(n.bookedAt).toBe("2026-07-10T12:00:00Z");
    expect(n.reference).toBe("REF-9");
  });

  it("round-trips through the mapper to a correctly-signed statement line", () => {
    const normalized = normalizeTrueLayerTransactions([
      tl({ transaction_type: "DEBIT", amount: -25.99, meta: null }),
    ]);
    const row = normalized.map((t) => mapTransactionToLine(t, TARGET))[0]!;
    expect(row.amount).toBe(-25.99); // debit → negative (money out)
    expect(row.reference).toBe("tl-1"); // no provider_reference → falls back to id
  });
});

// ---------------------------------------------------------------------------
// bank_statement_lines CHECK/NOT-NULL compliance — the mapper DROPS an
// uninsertable line (mig 20260524 / 20261109)
//
// The row shape under-mirrored two hard constraints: `posted_at date NOT NULL`
// and `amount numeric(12,2)`. dateOnly() returned "" for a missing bookedAt and
// wrote it to posted_at → 22007, and an amount past the precision ceiling → 22003
// — and ONE such row aborts the WHOLE batch insert (0 lines written, the org's
// feed stranded tick after tick). mapStatementToLines now DROPS such a line. These
// are RED pre-fix (the mapper mirrored NEITHER, so the poison line survived).
// ---------------------------------------------------------------------------

describe("mapStatementToLines — DB-constraint compliance (drops an uninsertable line)", () => {
  const GOOD = tx({ id: "good", bookedAt: "2026-07-15T09:30:00Z", amount: 100, direction: "credit" });

  const CONSTRAINT_VIOLATIONS: ReadonlyArray<{ check: string; bad: AggregatorTransaction }> = [
    { check: "posted_at date NOT NULL — empty booking date", bad: tx({ id: "empty-date", bookedAt: "" }) },
    { check: "posted_at date NOT NULL — unparseable booking date", bad: tx({ id: "bad-date", bookedAt: "not-a-date" }) },
    { check: "amount numeric(12,2) — magnitude past the precision ceiling", bad: tx({ id: "huge", amount: 1e13, direction: "credit" }) },
  ];

  it.each(CONSTRAINT_VIOLATIONS)(
    "drops a line violating: $check (keeps the good line)",
    ({ bad }) => {
      const rows = mapStatementToLines({ accountId: "a", transactions: [GOOD, bad] }, TARGET);
      expect(rows.map((r) => r.provider_tx_id)).toEqual(["good"]);
    },
  );

  it("keeps a line at the exact numeric(12,2) ceiling and a valid plain date", () => {
    const rows = mapStatementToLines(
      {
        accountId: "a",
        transactions: [
          tx({ id: "ceiling", amount: 9_999_999_999.99, direction: "credit", bookedAt: "2026-02-01" }),
        ],
      },
      TARGET,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(9_999_999_999.99);
    expect(rows[0]!.posted_at).toBe("2026-02-01");
  });

  it("one poison line drops ONLY itself — the rest of the statement still maps", () => {
    const rows = mapStatementToLines(
      {
        accountId: "a",
        transactions: [
          tx({ id: "a1", bookedAt: "2026-07-01", amount: 10, direction: "credit" }),
          tx({ id: "poison", bookedAt: "", amount: 20, direction: "debit" }),
          tx({ id: "a2", bookedAt: "2026-07-02", amount: 30, direction: "credit" }),
        ],
      },
      TARGET,
    );
    expect(rows.map((r) => r.provider_tx_id)).toEqual(["a1", "a2"]);
  });
});
