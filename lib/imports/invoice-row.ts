/**
 * Migration OS — building the `invoices` insert for one imported row.
 *
 * `public.invoices.total` is a STORED GENERATED column, `amount + vat_total`
 * (supabase/migrations/20260515190000_invoices.sql). The import wrote it
 * anyway, so Postgres rejected the INSERT with SQLSTATE 428C9 — "cannot insert
 * a non-DEFAULT value into column total" — and every invoice row failed.
 *
 * The writable inputs are `amount` (net) and `vat_total`. The file's own total
 * is still load-bearing twice over: it decides whether the row is importable at
 * all, and it is what `amount` is derived from when the file gives no net
 * figure. The database then recomputes the stored total from the two columns it
 * owns, which is the point of the generated column — the persisted total can
 * never drift from its parts.
 *
 * Split out of the commit path so the exact payload that reaches Postgres is
 * something a test can hold and insert for real; see
 * __tests__/integration/rls/import-generated-columns.test.ts.
 */

import { importedCreatedAt } from "@/lib/imports/dates";

/**
 * The columns an imported invoice writes to `public.invoices`.
 *
 * `total` is deliberately absent from this type and must STAY absent — it is
 * the generated column Postgres refuses to be handed a value for. Putting it
 * back is a type error, which is the point of naming the shape here rather than
 * reaching for the permissive generated `Insert` type.
 */
export type InvoiceImportRow<S extends string = string> = {
  org_id: string;
  number: string;
  amount: number;
  vat_total: number;
  /**
   * Generic so the caller's narrow status union survives the round trip —
   * `invoices.status` is a CHECK-constrained enum and the commit path resolves
   * it with normaliseInvoiceStatus before handing it over. Widening it to
   * `string` here would strip that guarantee at the insert.
   */
  status: S;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  /**
   * The invoice's own date from the source file.
   *
   * Optional and omitted when absent rather than set to null:
   * `invoices.created_at` is NOT NULL with `default now()`. See
   * lib/imports/dates.ts.
   */
  created_at?: string;
};

export type InvoiceImportPlan<S extends string = string> =
  | { status: "ok"; row: InvoiceImportRow<S> }
  /** No invoice number, or no positive total — nothing to import. */
  | { status: "skip" }
  /** The row carries a figure we can't honour; show `reason` and move on. */
  | { status: "reject"; reason: string };

export function buildInvoiceImportPlan<S extends string>(
  mapped: Record<string, unknown>,
  orgId: string,
  normalisedStatus: S,
): InvoiceImportPlan<S> {
  const number = String(mapped.number ?? "").trim();
  const total = Number(mapped.total ?? 0);
  if (!number || !Number.isFinite(total) || total <= 0) return { status: "skip" };

  const vat = Number(mapped.vat_total ?? 0);
  // The file's net figure when it has one, otherwise what's left of the total
  // once VAT is taken off it.
  const amount = Number(mapped.amount ?? Math.max(0, total - vat));
  if (!Number.isFinite(vat) || !Number.isFinite(amount)) return { status: "skip" };

  // Back-date the invoice to the date the file gave. A date the file gave but
  // we can't read is a rejection, not a silent fallback to now().
  const createdAt = importedCreatedAt(mapped.created_at);
  if (!createdAt.ok) return { status: "reject", reason: createdAt.reason };

  return {
    status: "ok",
    row: {
      org_id: orgId,
      number,
      amount,
      vat_total: vat,
      status: normalisedStatus,
      due_date: (mapped.due_date as string) ?? null,
      paid_at: (mapped.paid_at as string) ?? null,
      notes: (mapped.notes as string) ?? null,
      ...(createdAt.value ? { created_at: createdAt.value } : {}),
    },
  };
}
