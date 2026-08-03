/**
 * Banking feed — the PURE mapper from an aggregator statement onto the EXISTING
 * bank_statement_lines row shape (20260524_payment_tracking).
 *
 * THE GAP THIS CLOSES. CrewFlow already has a manual bank-reconciliation baseline
 * — `bank_statements` + `bank_statement_lines`, fed today by CSV upload, matched
 * against invoices/payments. The Open Banking substrate does NOT invent a new
 * store: once a bank feed is live, aggregator-fetched transactions are mapped by
 * THIS function onto the exact same `bank_statement_lines` rows, so the existing
 * reconciliation UI lights up with no changes. Activation is a config + LEGAL
 * flip; the data lands where the product already reads it.
 *
 * ── PROVIDER-AGNOSTIC INPUT ─────────────────────────────────────────────────
 * Aggregators disagree on sign conventions and field names (TrueLayer signs the
 * amount and tags CREDIT/DEBIT; Plaid uses positive-for-money-OUT; Nordigen nests
 * `transactionAmount`). To keep this mapper single-purpose and deterministic, the
 * ADAPTER normalises its native shape into `AggregatorTransaction` first (an
 * absolute `amount` + an explicit `direction`), and this mapper owns the ONE
 * canonical transform: direction → sign, timestamp → calendar day, and the
 * org/statement pinning that bank_statement_lines requires. A per-provider
 * normaliser (`normalizeTrueLayerTransactions`) lives here too so that arithmetic
 * lives once and is unit-tested.
 *
 * ── PURITY IS STRUCTURAL ────────────────────────────────────────────────────
 * No I/O, no clock, no `server-only`, no network. The same inputs always produce
 * byte-identical output, so the mapper is exhaustively unit-testable. This file
 * NEVER fetches — it only shapes data an adapter has already fetched (and no
 * adapter fetches while dark).
 *
 * ── SIGN CONVENTION (matches bank_statement_lines) ──────────────────────────
 * `bank_statement_lines.amount` is `numeric(12,2)` where POSITIVE = incoming
 * (money in) and NEGATIVE = outgoing (money out). A `direction: "credit"` maps to
 * a positive amount, `"debit"` to a negative amount. The absolute magnitude is
 * taken so a source that already signed its amount cannot double-negate.
 */

/** Money into (credit) or out of (debit) the account. */
export type BankTransactionDirection = "credit" | "debit";

/**
 * The provider-agnostic transaction an adapter emits after normalising its native
 * shape. Absolute `amount` + explicit `direction` so this mapper owns the sign.
 */
export type AggregatorTransaction = {
  /** Aggregator transaction id — carried into `reference` when no better ref exists. */
  id: string;
  /** ISO timestamp or `YYYY-MM-DD` booking date. Sliced to the calendar day. */
  bookedAt: string;
  /** ABSOLUTE amount (>= 0). Sign is derived from `direction`, never from this. */
  amount: number;
  direction: BankTransactionDirection;
  /** Free-text description / merchant. Optional. */
  description?: string | null;
  /** Payment reference, when the bank provides one. Falls back to the tx id. */
  reference?: string | null;
};

/** One account's statement as an adapter emits it. */
export type AggregatorStatement = {
  accountId: string;
  accountName?: string | null;
  transactions: AggregatorTransaction[];
};

/**
 * The exact shape of a `public.bank_statement_lines` INSERT row (20260524). Match
 * columns are intentionally omitted — they default (`match_status='unmatched'`)
 * and are resolved by the existing reconciliation flow, not by the importer.
 */
export type BankStatementLineInsert = {
  org_id: string;
  bank_statement_id: string;
  /** `YYYY-MM-DD` — the `posted_at` date column. */
  posted_at: string;
  /** Signed 2dp: positive = incoming, negative = outgoing. */
  amount: number;
  description: string | null;
  reference: string | null;
  /**
   * The aggregator's stable transaction id (20261109). The dedupe key for an
   * idempotent feed import — a re-sync of an overlapping window inserts no
   * duplicate line because `(org_id, provider_tx_id)` is UNIQUE. NULL only for
   * legacy CSV-uploaded lines, never for a feed-imported one.
   */
  provider_tx_id: string | null;
};

/** Options binding a mapped statement to its org + parent statement row. */
export type StatementMapTarget = {
  orgId: string;
  bankStatementId: string;
};

/** A Postgres/ISO timestamp or date → `YYYY-MM-DD`, or "" when absent. Pure. */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  // Both `2026-01-31` and `2026-01-31T09:15:00Z` slice to the calendar day.
  return value.slice(0, 10);
}

/** Signed, rounded-to-2dp amount for bank_statement_lines. Never NaN. */
function signedAmount(amount: number, direction: BankTransactionDirection): number {
  const n = Number(amount);
  const magnitude = Number.isFinite(n) ? Math.abs(n) : 0;
  const signed = direction === "credit" ? magnitude : -magnitude;
  // Round to 2dp (pence), normalising -0 to 0.
  const rounded = Math.round(signed * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Map ONE aggregator transaction onto a bank_statement_lines insert row. Pure.
 * `reference` falls back to the aggregator transaction id so every imported line
 * is traceable to its source event.
 */
export function mapTransactionToLine(
  tx: AggregatorTransaction,
  target: StatementMapTarget,
): BankStatementLineInsert {
  return {
    org_id: target.orgId,
    bank_statement_id: target.bankStatementId,
    posted_at: dateOnly(tx.bookedAt),
    amount: signedAmount(tx.amount, tx.direction),
    description: tx.description ?? null,
    reference: tx.reference ?? tx.id ?? null,
    // The aggregator tx id is the idempotency key; never lost so a re-sync dedupes.
    provider_tx_id: tx.id ?? null,
  };
}

/**
 * Map a whole aggregator statement onto bank_statement_lines insert rows. Pure.
 * Order is preserved from the source (aggregators return newest-first or
 * oldest-first consistently); the reconciliation UI sorts for display.
 */
export function mapStatementToLines(
  statement: AggregatorStatement,
  target: StatementMapTarget,
): BankStatementLineInsert[] {
  return statement.transactions.map((tx) => mapTransactionToLine(tx, target));
}

// ── Per-provider normalisers (native shape → AggregatorTransaction) ───────────
// These keep the adapters thin and the sign/date arithmetic in one tested place.

/** A TrueLayer Data API transaction (the subset the mapper needs). */
export type TrueLayerTransaction = {
  transaction_id: string;
  timestamp: string;
  /** TrueLayer signs the amount: negative = money out. */
  amount: number;
  description?: string | null;
  /** "DEBIT" | "CREDIT" — authoritative direction when present. */
  transaction_type?: string | null;
  meta?: { provider_reference?: string | null } | null;
};

/**
 * Normalise TrueLayer's native transactions into the provider-agnostic shape.
 * Direction is taken from `transaction_type` when present, else derived from the
 * sign of the (signed) amount. Pure.
 */
export function normalizeTrueLayerTransactions(
  rows: readonly TrueLayerTransaction[],
): AggregatorTransaction[] {
  return rows.map((r) => {
    const typeUpper = (r.transaction_type ?? "").toUpperCase();
    const direction: BankTransactionDirection =
      typeUpper === "CREDIT"
        ? "credit"
        : typeUpper === "DEBIT"
          ? "debit"
          : Number(r.amount) >= 0
            ? "credit"
            : "debit";
    return {
      id: r.transaction_id,
      bookedAt: r.timestamp,
      amount: Math.abs(Number(r.amount) || 0),
      direction,
      description: r.description ?? null,
      reference: r.meta?.provider_reference ?? null,
    };
  });
}
