/**
 * Migration OS — turning an imported VAT figure into a `finances` row.
 *
 * Why this module exists:
 *
 *   `public.finances.vat_total` is a STORED GENERATED column
 *   (`round(amount * vat_rate / 100, 2)` — see
 *   supabase/migrations/20260515180000_finances_and_receipts.sql). Postgres
 *   rejects any INSERT that supplies a value for it with SQLSTATE 428C9,
 *   "cannot insert a non-DEFAULT value into column vat_total". The import wrote
 *   exactly that column, so EVERY cost row failed. The writable input is
 *   `vat_rate`, CHECK-constrained to the three UK rates (0, 5, 20).
 *
 *   Spreadsheets, though, overwhelmingly carry a VAT *amount* ("VAT", "Tax",
 *   "VAT Amount") rather than a rate. So the import has to work the rate back
 *   out of the money before it can write anything at all.
 *
 * The contract, in order of preference:
 *
 *   1. An explicit rate column wins outright. It is what the source system
 *      actually asserted; the amount is derived data, and the database will
 *      recompute it from the rate anyway.
 *   2. Otherwise back the rate out of the VAT amount against the net amount,
 *      and accept it only if it lands on 0 / 5 / 20 (within a penny, because
 *      the source rounded its own VAT to 2dp).
 *   3. A row with no VAT information at all records 0% — i.e. no VAT — which
 *      is what the file said. It must NOT fall through to the column default,
 *      which is 20%: `finances.vat_total` feeds the VAT-quarter figures, and
 *      inventing reclaimable VAT the operator never stated is a worse failure
 *      than recording none.
 *
 * A VAT figure that lands anywhere else — a legacy 17.5%, an Irish 13.5%, a
 * mistyped cell — is REJECTED with an explanation, never rounded onto the
 * nearest permitted rate. Rounding would silently restate the operator's books;
 * rejecting puts the row in front of them with the numbers that don't add up.
 */

import { FINANCE_VAT_RATES } from "@/lib/finances/schema";
import { importedCreatedAt } from "@/lib/imports/dates";

export type ImportedVatRate = (typeof FINANCE_VAT_RATES)[number];

export type VatRateResolution =
  | {
      ok: true;
      vat_rate: ImportedVatRate;
      /**
       * Where the rate came from — "rate" (an explicit rate column), "amount"
       * (backed out of a VAT amount), or "absent" (no VAT information; 0%).
       */
      source: "rate" | "amount" | "absent";
    }
  | { ok: false; reason: string };

/**
 * How far a source system's VAT amount may sit from the exact arithmetic and
 * still count as that rate. One penny: the file rounded its own VAT to 2dp, and
 * per-line rounding in the exporting system can differ from ours by a unit in
 * the last place. Two permitted rates only come within a penny of each other on
 * amounts under about 20p, where the tie is broken by closest match.
 */
const PENNY = 0.01;

/** The permitted rates written as the fractions a percent-formatted cell holds. */
const FRACTIONAL_FORMS: ReadonlyArray<readonly [fraction: number, rate: ImportedVatRate]> = [
  [0.05, 5],
  [0.2, 20],
];

/** Rate names UK accounting exports use in place of a number. */
const NAMED_RATES: ReadonlyArray<readonly [pattern: RegExp, rate: ImportedVatRate]> = [
  [/\b(zero|exempt|no vat|outside the scope|out of scope)\b/, 0],
  [/\b(reduced)\b/, 5],
  [/\b(standard)\b/, 20],
];

/**
 * Parse a VAT-rate cell into a percentage.
 *
 * Returns the rate in percent units (20 for 20%), NOT a validated one — 12.5
 * comes back as 12.5 so the caller can reject it BY NAME rather than silently
 * snapping it to 20. `null` means the cell held nothing recognisable as a rate.
 *
 * Two conversions happen here, both deliberate:
 *
 *   - Fractions. SheetJS reads a cell *displayed* as "20%" as its underlying
 *     0.2, so 0.05 and 0.2 are read as 5% and 20%. That is a unit conversion of
 *     an exact value — 0.2 has no sane reading as 0.2% VAT — and it applies
 *     only to those two exact fractions. 0.125 stays 0.125 and gets rejected.
 *   - Names. "Standard" / "Reduced" / "Zero rated" are how Xero-shaped exports
 *     label the same three rates.
 */
export function parseVatRate(raw: unknown): number | null {
  if (typeof raw === "number") return canonicaliseRate(raw);
  if (typeof raw !== "string") return null;

  const s = raw.trim().toLowerCase();
  if (s === "") return null;

  // A leading number wins over a name, so "20% (VAT on Income)" reads as 20
  // rather than tripping over the words that follow it.
  const numeric = s.match(/^[£$€\s]*(-?\d+(?:\.\d+)?)\s*%?/);
  if (numeric) {
    const n = Number(numeric[1]);
    // A trailing "%" is proof the figure is already in percent units, so a
    // "0.2%" cell means 0.2% and must not be re-read as 20%.
    if (Number.isFinite(n)) return s.includes("%") ? n : canonicaliseRate(n);
  }

  for (const [pattern, rate] of NAMED_RATES) {
    if (pattern.test(s)) return rate;
  }
  return null;
}

function canonicaliseRate(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  for (const [fraction, rate] of FRACTIONAL_FORMS) {
    if (Math.abs(n - fraction) < 1e-9) return rate;
  }
  return n;
}

/** Parse a money cell (the VAT amount, the net amount). */
function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[£$€,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function asPermittedRate(n: number): ImportedVatRate | null {
  return (FINANCE_VAT_RATES as readonly number[]).includes(n)
    ? (n as ImportedVatRate)
    : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Keeps the sign, so a negative VAT figure reads as the -£20.00 it is. */
const money = (n: number) => (n < 0 ? `-£${Math.abs(n).toFixed(2)}` : `£${n.toFixed(2)}`);
/** 20 → "20%", 12.5 → "12.5%" — no trailing-zero noise in operator-facing text. */
const percent = (n: number) => `${Number(n.toFixed(4))}%`;

const RATE_LIST = "0%, 5% or 20%";

/**
 * Work out which `finances.vat_rate` an imported cost row should be written
 * with. See the module header for the ordering rules.
 *
 * `amount` is the NET amount (what goes into `finances.amount`). `vat_rate` and
 * `vat_total` are the raw mapped cells — a rate and a money amount respectively.
 */
export function resolveCostVatRate(input: {
  amount: number;
  vat_rate?: unknown;
  vat_total?: unknown;
}): VatRateResolution {
  // 1. An explicit rate column is the source system's own assertion, and is
  // taken at face value. It is not cross-checked against any VAT amount on the
  // same row: the rate is the writable column and the database recomputes the
  // amount from it, so a stale or differently-rounded amount cell is not a
  // reason to reject a row whose rate is stated plainly.
  const explicit = parseVatRate(input.vat_rate);
  if (explicit !== null) {
    const rate = asPermittedRate(explicit);
    if (rate === null) {
      return {
        ok: false,
        reason:
          `VAT rate ${percent(explicit)} isn't a UK VAT rate — costs accept ` +
          `${RATE_LIST}. Fix the VAT rate for this row and re-import it.`,
      };
    }
    return { ok: true, vat_rate: rate, source: "rate" };
  }

  // 2. No rate column — back the rate out of the VAT amount.
  const vatAmount = parseAmount(input.vat_total);
  if (vatAmount === null) {
    // 3. The file stated no VAT. Record none (see the module header on why this
    // must not fall through to the column's 20% default).
    return { ok: true, vat_rate: 0, source: "absent" };
  }
  if (round2(vatAmount) === 0) {
    return { ok: true, vat_rate: 0, source: "amount" };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return {
      ok: false,
      reason:
        `Can't work out a VAT rate: this row has VAT of ${money(vatAmount)} but ` +
        `no positive net amount to measure it against.`,
    };
  }

  let best: { rate: ImportedVatRate; delta: number } | null = null;
  for (const candidate of FINANCE_VAT_RATES) {
    const delta = Math.abs(vatAmount - round2((input.amount * candidate) / 100));
    if (!best || delta < best.delta) best = { rate: candidate, delta };
  }
  if (best && best.delta <= PENNY) {
    return { ok: true, vat_rate: best.rate, source: "amount" };
  }

  const implied = (vatAmount / input.amount) * 100;
  return {
    ok: false,
    reason:
      `VAT of ${money(vatAmount)} on a net ${money(input.amount)} works out at ` +
      `${percent(implied)}, which isn't a UK VAT rate (${RATE_LIST}). Check the ` +
      `amount and VAT columns for this row and re-import it.`,
  };
}

/**
 * The columns an imported cost writes to `public.finances`.
 *
 * `vat_total` is deliberately absent from this type and must STAY absent — it
 * is the generated column Postgres refuses to be handed a value for. Putting it
 * back is a type error, which is the entire point of naming the shape here
 * rather than reaching for the permissive generated `Insert` type.
 */
export type FinanceImportRow = {
  org_id: string;
  amount: number;
  vat_rate: ImportedVatRate;
  category: string | null;
  notes: string | null;
  /**
   * The date the source file gave for this cost, back-dating the row.
   *
   * Optional, and omitted entirely rather than set to null when the file has no
   * date column: `finances.created_at` is NOT NULL with `default now()`, so the
   * absent case has to leave the key off for the default to apply. See
   * lib/imports/dates.ts for why the value is pinned to an explicit instant.
   */
  created_at?: string;
};

export type FinanceImportPlan =
  /** Insert this row. */
  | { status: "ok"; row: FinanceImportRow }
  /** Nothing importable here — skip the row (no positive amount). */
  | { status: "skip" }
  /** The row carries a figure we can't honour; show `reason` and move on. */
  | { status: "reject"; reason: string };

/**
 * Build the `finances` insert for one mapped `cost` row.
 *
 * Split out of the import commit path so the payload that actually reaches
 * Postgres is something a test can hold — see
 * __tests__/integration/rls/import-generated-columns.test.ts, which inserts the
 * output of this function into a real database.
 */
export function buildFinanceImportPlan(
  mapped: Record<string, unknown>,
  orgId: string,
): FinanceImportPlan {
  const amount = Number(mapped.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return { status: "skip" };

  const vat = resolveCostVatRate({
    amount,
    vat_rate: mapped.vat_rate,
    vat_total: mapped.vat_total,
  });
  if (!vat.ok) return { status: "reject", reason: vat.reason };

  // Back-date the row to the file's own date when it carried one. A date the
  // file gave but we can't read is a rejection, not a fallback to now() — see
  // lib/imports/dates.ts.
  const createdAt = importedCreatedAt(mapped.created_at);
  if (!createdAt.ok) return { status: "reject", reason: createdAt.reason };

  return {
    status: "ok",
    row: {
      org_id: orgId,
      amount,
      vat_rate: vat.vat_rate,
      category: (mapped.category as string) ?? null,
      notes: (mapped.notes as string) ?? null,
      // Spread rather than assigned so a dateless file leaves the column
      // untouched and picks up `default now()`.
      ...(createdAt.value ? { created_at: createdAt.value } : {}),
    },
  };
}
