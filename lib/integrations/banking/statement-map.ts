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

// ── bank_statement_lines DB-constraint bounds (20260524 / 20261109) ──────────
// The row shape under-mirrors two hard constraints the batch insert enforces; a
// line violating either would abort the WHOLE upsert statement (0 lines written,
// the org's feed stranded, tick after tick — the batch-poisoning class). The
// mapper therefore DROPS such a line in mapStatementToLines rather than emit a
// row the DB rejects. Each bound is tied to its column:
//   • posted_at  date NOT NULL       → a real YYYY-MM-DD (never "" / garbage)
//   • amount     numeric(12, 2)      → |amount| <= 9,999,999,999.99 (10 int digits)
/** numeric(12,2): 10 integer digits + 2 decimal ⇒ the largest insertable magnitude. */
const AMOUNT_MAX = 9_999_999_999.99;
/** A real calendar day: `YYYY-MM-DD`, the granularity posted_at stores. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A Postgres/ISO timestamp or date → `YYYY-MM-DD`, or "" when absent. Pure. */
function dateOnly(value: string | null | undefined): string {
  if (!value) return "";
  // Both `2026-01-31` and `2026-01-31T09:15:00Z` slice to the calendar day.
  return value.slice(0, 10);
}

/**
 * True when a mapped line can actually be inserted — it mirrors the DB
 * constraints the row shape under-declares. A line failing either is DROPPED by
 * mapStatementToLines: `posted_at` is `date NOT NULL`, so an empty/garbage day
 * would raise 22007/23502; `amount` is `numeric(12,2)`, so a magnitude past the
 * precision ceiling would raise 22003 — and ONE such row aborts the whole batch
 * insert. Pure. Exported so the per-adapter constraint guard can enumerate it.
 */
export function isInsertableLine(line: BankStatementLineInsert): boolean {
  if (!DATE_ONLY_RE.test(line.posted_at)) return false;
  if (Number.isNaN(Date.parse(`${line.posted_at}T00:00:00Z`))) return false;
  if (!Number.isFinite(line.amount)) return false;
  if (Math.abs(line.amount) > AMOUNT_MAX) return false;
  return true;
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
 *
 * A line that cannot satisfy a DB constraint the row shape under-mirrors — an
 * unparseable/empty `posted_at` (date NOT NULL) or an `amount` past the
 * numeric(12,2) ceiling — is DROPPED here (isInsertableLine): one such row would
 * abort the whole batch insert (0 lines, the org's feed stranded, tick after
 * tick), so it is skipped rather than allowed to poison the batch. This is the
 * mapper analogue of the telematics reading-map's out-of-range nulling.
 */
export function mapStatementToLines(
  statement: AggregatorStatement,
  target: StatementMapTarget,
): BankStatementLineInsert[] {
  return statement.transactions
    .map((tx) => mapTransactionToLine(tx, target))
    .filter(isInsertableLine);
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

/**
 * A Plaid `/transactions/get` transaction (the subset the mapper needs).
 *
 * SIGN CONVENTION (Plaid, the opposite of TrueLayer): `amount` is POSITIVE when
 * money moves OUT of the account (a debit) and NEGATIVE when money moves IN (a
 * credit). We normalise to the provider-agnostic absolute-amount-plus-direction
 * form so the ONE canonical sign transform still lives in this mapper.
 */
export type PlaidTransaction = {
  transaction_id: string;
  /** Posted date, `YYYY-MM-DD`. `authorized_date` is a fallback when absent. */
  date: string;
  authorized_date?: string | null;
  /** Positive = money OUT (debit); negative = money IN (credit). */
  amount: number;
  name?: string | null;
  merchant_name?: string | null;
  account_id?: string | null;
  payment_meta?: { reference_number?: string | null } | null;
};

/**
 * Normalise Plaid's native transactions into the provider-agnostic shape. Plaid
 * signs the OPPOSITE way to TrueLayer (positive = money out), so a positive
 * amount is a DEBIT and a non-positive amount is a CREDIT; the magnitude is taken
 * absolute so the mapper's `direction → sign` step is the single source of sign.
 * Pure.
 */
export function normalizePlaidTransactions(
  rows: readonly PlaidTransaction[],
): AggregatorTransaction[] {
  return rows.map((r) => {
    const amt = Number(r.amount);
    const direction: BankTransactionDirection =
      Number.isFinite(amt) && amt > 0 ? "debit" : "credit";
    return {
      id: r.transaction_id,
      bookedAt: r.date || r.authorized_date || "",
      amount: Math.abs(Number.isFinite(amt) ? amt : 0),
      direction,
      description: r.merchant_name ?? r.name ?? null,
      reference: r.payment_meta?.reference_number ?? null,
    };
  });
}

/**
 * A Nordigen / GoCardless Bank Account Data transaction (the subset the mapper
 * needs), as returned under `transactions.booked[]` by
 * `/api/v2/accounts/{id}/transactions/`.
 *
 * SIGN CONVENTION: `transactionAmount.amount` is a SIGNED decimal STRING —
 * negative = money out (debit), positive = money in (credit). Some banks omit
 * `transactionId`; the GoCardless-generated `internalTransactionId` is the stable
 * fallback so the idempotency key (provider_tx_id) is never lost.
 */
export type NordigenTransaction = {
  transactionId?: string | null;
  internalTransactionId?: string | null;
  bookingDate?: string | null;
  bookingDateTime?: string | null;
  valueDate?: string | null;
  transactionAmount: { amount: string; currency?: string | null };
  remittanceInformationUnstructured?: string | null;
  remittanceInformationUnstructuredArray?: string[] | null;
  creditorName?: string | null;
  debtorName?: string | null;
  endToEndId?: string | null;
};

/**
 * Normalise Nordigen's native booked transactions into the provider-agnostic
 * shape. The amount is a signed string (negative = out); a non-negative amount is
 * a CREDIT, a negative one a DEBIT, and the magnitude is taken absolute. The
 * stable id prefers `transactionId`, falling back to `internalTransactionId` so
 * the dedupe key survives banks that do not supply the former. Pure.
 */
export function normalizeNordigenTransactions(
  rows: readonly NordigenTransaction[],
): AggregatorTransaction[] {
  return rows.map((r) => {
    const amt = Number(r.transactionAmount?.amount);
    const direction: BankTransactionDirection =
      Number.isFinite(amt) && amt < 0 ? "debit" : "credit";
    const arrayText =
      r.remittanceInformationUnstructuredArray &&
      r.remittanceInformationUnstructuredArray.length > 0
        ? r.remittanceInformationUnstructuredArray.join(" ")
        : null;
    return {
      id: r.transactionId ?? r.internalTransactionId ?? "",
      bookedAt: r.bookingDate ?? r.bookingDateTime ?? r.valueDate ?? "",
      amount: Math.abs(Number.isFinite(amt) ? amt : 0),
      direction,
      description:
        r.remittanceInformationUnstructured ??
        arrayText ??
        r.creditorName ??
        r.debtorName ??
        null,
      reference: r.endToEndId ?? null,
    };
  });
}
