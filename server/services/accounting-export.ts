import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  readFailure,
  reportReadFailure,
  type SupabaseReadError,
} from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  toCanonicalRows,
  filterInvoicesByTaxPoint,
  type CanonicalAccountingRow,
  type CanonicalInvoiceInput,
  type CanonicalPaymentInput,
  type InvoiceLineForBucketing,
} from "@/lib/integrations/accounting/canonical";
import type { AccountingProvider } from "@/lib/integrations/accounting/adapters/types";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";

/**
 * Accounting export service — org-pinned, loud-read data gathering + the write
 * of an audit-log row.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' ledgers into one accounting export — exactly the bug the
 * active-org read slices closed. Every query here `.eq("org_id", orgId)` on the
 * caller-supplied active org, so the export contains exactly one company.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to
 * an empty export — an accounting export that silently omits rows because a
 * query errored is the precise lie loud reads exist to stop. Truncation at the
 * row cap is the same class of lie: a partial export must never be silent, so a
 * read that hits the cap sets `truncated` on the result, is reported loudly, and
 * is surfaced by the route (headers + audit-log note). See `capRows`.
 *
 * DRAFT INVOICES ARE NOT ACCOUNTING ROWS. A `draft` invoice is a work in
 * progress, not a real sale — it carries no tax point an accountant should book
 * and, once the provider push is live, would post as a genuine Xero / QuickBooks
 * sales invoice. The invoice read therefore EXCLUDES `draft` and keeps every
 * real status (sent / awaiting_payment / partially_paid / paid / overdue).
 */

export const MAX_ROWS = 50_000;

/**
 * Cap a fully-paged read result and report whether it exceeded the ceiling. Pure.
 *
 * The reads are paged in full via `fetchAllRows`, so the input is the TRUE row
 * count, not a clamped probe. A length beyond `cap` means the org holds more
 * rows than the export ceiling admits: the tail is sliced off and `truncated` is
 * the loud flag the caller must surface rather than silently drop it. This makes
 * the flag honest — before the F-1 fix a single `.limit(MAX_ROWS + 1)` was
 * clamped to 1000, so the length never reached the cap and `truncated` was DEAD.
 */
export function capRows<T>(
  data: readonly T[],
  cap = MAX_ROWS,
): { rows: T[]; truncated: boolean } {
  const truncated = data.length > cap;
  return { rows: truncated ? data.slice(0, cap) : data.slice(), truncated };
}

/** Customer name from a joined `customer` / `quote.customer` (denormalised first). */
type NameJoin = { customer?: { name?: string | null } | null } & {
  quote?: { customer?: { name?: string | null } | null } | null;
};
function joinedCustomerName(row: NameJoin): string | null {
  return row.customer?.name ?? row.quote?.customer?.name ?? null;
}

export type AccountingExport = {
  rows: CanonicalAccountingRow[];
  invoiceCount: number;
  paymentCount: number;
  /**
   * True when EITHER read hit the `MAX_ROWS` cap, so the export omits rows the
   * org holds. Never silent: the caller surfaces this (route headers + audit
   * note) and the service already reported it loudly.
   */
  truncated: boolean;
  /**
   * PUSH PATH ONLY (`excludePushedFor` set): the `invoice_number`s of invoices
   * ALREADY recorded in the push-once ledger — i.e. created on a PRIOR successful
   * run and therefore EXCLUDED from `rows` this run. The sync's payment-link gate
   * needs these so a payment whose invoice landed on an earlier sync (but is no
   * longer in this batch) is still recognised as linkable. Empty/undefined on the
   * CSV path, which pushes nothing and reads no ledger.
   */
  pushedInvoiceNumbers?: Set<string>;
};

/**
 * Gather one org's invoices + payments and map them to canonical accounting
 * rows. Optionally bounded to a `[from, to]` calendar-day window (inclusive),
 * applied to the invoice tax point and the payment date.
 *
 * `todayIso` is injected (defaults to the UK business day) so the overdue
 * display derivation is deterministic and the pure mapper never reads a clock.
 *
 * ── PUSH-ONCE EXCLUSION (`excludePushedFor`) ─────────────────────────────────
 * When a provider is given, every invoice / payment ALREADY recorded in the
 * push-once ledger (accounting_pushed_entities) for that (org, provider) is
 * EXCLUDED, and each surviving canonical row carries its immutable CrewFlow id
 * as `sourceId`. This is what makes a provider sync push ONLY not-yet-pushed
 * rows: re-running a sync can never re-send a row the provider already accepted,
 * so activation cannot duplicate invoices. The CSV path passes no provider and
 * so is unchanged — it exports the full ledger and carries no `sourceId`.
 *
 * The exclusion read is LOUD (throws on failure) BY DESIGN: silently proceeding
 * with "nothing excluded" would re-push the whole history and duplicate every
 * invoice — the exact failure this guard exists to stop. A failed sync is always
 * safer than a duplicating one.
 */
export async function buildAccountingExport(params: {
  orgId: string;
  from?: string | null;
  to?: string | null;
  todayIso?: string;
  /** When set, exclude rows already pushed to this provider and stamp `sourceId`. */
  excludePushedFor?: AccountingProvider;
}): Promise<AccountingExport> {
  const { orgId, from, to, excludePushedFor } = params;
  const todayIso = params.todayIso ?? invoiceBusinessToday();
  const supabase = await createClient();

  const dayOk = (v: string | null | undefined): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  // ── Invoices ───────────────────────────────────────────────────────────────
  // PAGE THE FULL LEDGER (F-1). A single `.limit(N)` is silently clamped to
  // PostgREST `max_rows` (1000), so a `.limit(MAX_ROWS + 1)` probe returned AT
  // MOST 1000 rows and the truncation flag was DEAD — the export dropped rows
  // 1001+ with no notice. `fetchAllRows` pages under the cap with a unique `id`
  // tiebreak on the (created_at) ordering so no page can drop or repeat a row.
  const { data: invData, error: invErr } = await fetchAllRows<{ id?: string }>(
    (lo, hi) => {
      let q = supabase
        .from("invoices")
        .select(
          "id, number, status, amount, vat_total, total, due_date, sent_at, created_at, " +
            "customer:customers(name), quote:quotes(customer:customers(name))",
        )
        .eq("org_id", orgId)
        // Exclude drafts: a draft invoice is not a real sale and must never
        // become an accounting row (it would post as a genuine sales invoice on
        // the future provider push). Exclude void (20261219) for the same
        // reason: a voided invoice is a retracted sale — exporting it would
        // overstate revenue in the customer's books. Keep every real status
        // (sent / awaiting_payment / partially_paid / paid / overdue).
        .neq("status", "draft")
        .neq("status", "void");
      // COARSE UPPER-BOUND PRE-FILTER ONLY. The canonical tax point is
      // `sent_at ?? created_at` (canonical.ts), and `sent_at >= created_at`, so:
      //   - `created_at <= to` is a SAFE superset — an invoice created after `to`
      //     can never have a tax point <= to, so none is wrongly kept;
      //   - a `created_at >= from` lower bound is NOT safe — an invoice created
      //     before `from` may still be ISSUED (sent_at) within the window, so
      //     bounding the read below `from` would silently DROP an in-period
      //     invoice. It is therefore deliberately ABSENT here.
      // The EXACT `[from, to]` bound on the tax point is enforced in the pure
      // layer below (filterInvoicesByTaxPoint), not at this query. Filters applied
      // BEFORE the transform methods so the builder stays a filter builder.
      if (dayOk(to)) q = q.lte("created_at", `${to}T23:59:59Z`);
      // The nested customer/quote embed defeats PostgREST's row-type inference
      // (it resolves to GenericStringError); cast to the paged shape — the rows
      // are re-typed at the mapper below.
      return q
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(lo, hi) as unknown as PromiseLike<PageResult<{ id?: string }>>;
    },
  );
  // LOUD: a failed read throws, never a silent partial export (fetchAllRows is
  // best-effort and hands back the partial set + error — we refuse it).
  if (invErr) {
    throw readFailure("accounting export: invoices", invErr as SupabaseReadError);
  }

  // ── Payments ─────────────────────────────────────────────────────────────────
  const { data: payData, error: payErr } = await fetchAllRows<{ id?: string }>(
    (lo, hi) => {
      let q = supabase
        .from("invoice_payments")
        .select(
          // Disambiguate the embed: invoice_payments has TWO FKs to invoices (the
          // simple invoice_id and the composite (invoice_id, org_id)), so a bare
          // `invoices(...)` is a PGRST201 ambiguous-embed. Pin the composite FK,
          // which is the tenant-safe one.
          "id, amount, paid_at, " +
            "invoice:invoices!invoice_payments_invoice_org_fkey(number, " +
            "customer:customers(name), quote:quotes(customer:customers(name)))",
        )
        .eq("org_id", orgId);
      if (dayOk(from)) q = q.gte("paid_at", from);
      if (dayOk(to)) q = q.lte("paid_at", to);
      return q
        .order("paid_at", { ascending: true })
        .order("id", { ascending: true })
        .range(lo, hi) as unknown as PromiseLike<PageResult<{ id?: string }>>;
    },
  );
  if (payErr) {
    throw readFailure("accounting export: payments", payErr as SupabaseReadError);
  }

  // Apply MAX_ROWS as a genuine ceiling AFTER full paging, so `truncated` is
  // derived from the TRUE row count (not a clamped probe). A partial export must
  // never be silent (the loud-reads doctrine): if either read exceeded the
  // ceiling, report it loudly here and hand `truncated` back for the route.
  const invCap = capRows(invData);
  const payCap = capRows(payData);
  const truncated = invCap.truncated || payCap.truncated;
  if (truncated) {
    reportReadFailure("accounting export: row cap reached", {
      message:
        `export truncated at MAX_ROWS=${MAX_ROWS} — ` +
        `invoices${invCap.truncated ? " CAPPED" : ""}, ` +
        `payments${payCap.truncated ? " CAPPED" : ""}; ` +
        `org=${orgId} narrow the [from,to] window to export the tail`,
      code: "EXPORT_TRUNCATED",
    });
  }

  // ── PUSH-ONCE EXCLUSION ────────────────────────────────────────────────────
  // On the provider-push path, drop every invoice / payment already recorded in
  // the push-once ledger so the batch contains ONLY not-yet-pushed rows. LOUD:
  // a failed read throws (never a silent "nothing excluded" that would re-push
  // the whole history and duplicate every invoice).
  let invDbRows = invCap.rows as ReadonlyArray<{ id?: string; number?: string | null }>;
  let payDbRows = payCap.rows as ReadonlyArray<{ id?: string }>;
  // The invoice numbers of invoices ALREADY at the provider (created on a prior
  // successful run). Threaded to the result so the sync's payment-link gate can
  // recognise a payment whose invoice landed earlier — that invoice is excluded
  // from `rows` below, so its number would otherwise be invisible this run.
  let pushedInvoiceNumbers: Set<string> | undefined;
  if (excludePushedFor) {
    const pushed = await readPushedEntityIds(supabase, orgId, excludePushedFor);
    // Compute the already-pushed invoice numbers from the FULL (pre-exclusion)
    // invoice set — mapping the ledger's invoice source ids back to the numbers
    // the providers link payments by (QBO DocNumber / Xero InvoiceNumber).
    pushedInvoiceNumbers = new Set<string>();
    for (const r of invDbRows) {
      if (pushed.invoice.has(String(r.id)) && r.number) {
        pushedInvoiceNumbers.add(String(r.number));
      }
    }
    invDbRows = invDbRows.filter((r) => !pushed.invoice.has(String(r.id)));
    payDbRows = payDbRows.filter((r) => !pushed.payment.has(String(r.id)));
  }

  const invoices: CanonicalInvoiceInput[] = invDbRows.map((r) => {
    const row = r as unknown as NameJoin & {
      id: string;
      number: string | null;
      status: string | null;
      amount: number | string | null;
      vat_total: number | string | null;
      total: number | string | null;
      due_date: string | null;
      sent_at: string | null;
      created_at: string | null;
    };
    return {
      // Threaded to the canonical row's `sourceId` only on the push path.
      source_id: excludePushedFor ? row.id : null,
      number: row.number,
      status: row.status,
      amount: row.amount,
      vat_total: row.vat_total,
      total: row.total,
      due_date: row.due_date,
      sent_at: row.sent_at,
      created_at: row.created_at,
      customer_name: joinedCustomerName(row),
    };
  });

  const payments: CanonicalPaymentInput[] = payDbRows.map((r) => {
    const row = r as unknown as {
      id: string;
      amount: number | string | null;
      paid_at: string | null;
      invoice?: (NameJoin & { number?: string | null }) | null;
    };
    return {
      source_id: excludePushedFor ? row.id : null,
      invoice_number: row.invoice?.number ?? null,
      customer_name: row.invoice ? joinedCustomerName(row.invoice) : null,
      amount: row.amount,
      paid_at: row.paid_at,
    };
  });

  // EXACT tax-point window (the DB read above is only a coarse `created_at <= to`
  // superset). Filter invoices on their canonical tax point (`sent_at ??
  // created_at`) so an invoice created before `from` but ISSUED within the window
  // is KEPT, and one issued after `to` is EXCLUDED — the created_at-windowed read
  // could do neither. Payments already window exactly on `paid_at` at the query.
  const windowedInvoices = filterInvoicesByTaxPoint(invoices, { from, to });

  // ── PER-LINE VAT (provider push only) ──────────────────────────────────────
  // Thread each invoice's immutable line-item snapshot (invoice_line_items:
  // vat_rate + ex-VAT line_total) so the canonical mapper can emit ONE push line
  // PER DISTINCT rate — each carrying its own tax code. WITHOUT this the push
  // derived a single BLENDED rate from the header totals and mis-posted every
  // mixed / zero-rated invoice. The CSV path passes no provider and skips this,
  // so its human-readable header-total row is unchanged. Org-pinned + fully paged
  // (fetchAllRows) so no line is silently dropped (an F-1 truncation would break
  // reconciliation, which is asserted in the mapper).
  if (excludePushedFor && windowedInvoices.length > 0) {
    const linesByInvoice = await readInvoiceLineItems(supabase, orgId);
    for (const inv of windowedInvoices) {
      if (inv.source_id) inv.line_items = linesByInvoice.get(inv.source_id) ?? [];
    }
  }

  const rows = toCanonicalRows(windowedInvoices, payments, { todayIso });
  return {
    rows,
    invoiceCount: windowedInvoices.length,
    paymentCount: payments.length,
    truncated,
    pushedInvoiceNumbers,
  };
}

/**
 * Read one org's invoice line-item snapshots (invoice_line_items) and group them
 * by invoice id. Org-pinned (`.eq("org_id", orgId)`), FULLY PAGED (fetchAllRows —
 * no clamp-trapped `.limit`, so no line is silently dropped), stable order.
 * LOUD: a failed read throws — a partial line set would break the per-invoice VAT
 * reconciliation (or drop a rate bucket), which is exactly the silent mis-post the
 * per-line push exists to prevent. Read org-wide + grouped in memory rather than
 * `.in(ids)` so the read is a single stable paging loop.
 */
async function readInvoiceLineItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<Map<string, InvoiceLineForBucketing[]>> {
  type LineRow = {
    invoice_id?: string | null;
    vat_rate?: number | string | null;
    line_total?: number | string | null;
  };
  const { data, error } = await fetchAllRows<LineRow>(
    (lo, hi) =>
      supabase
        .from("invoice_line_items")
        .select("invoice_id, vat_rate, line_total, sort_order, id")
        .eq("org_id", orgId)
        // Stable, total ordering (invoice, then line order, then a unique id
        // tiebreak) so pages can't drop or repeat a line at a boundary.
        .order("invoice_id", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(lo, hi) as unknown as PromiseLike<PageResult<LineRow>>,
  );
  if (error) {
    throw readFailure(
      "accounting export: invoice line items",
      error as SupabaseReadError,
    );
  }
  const byInvoice = new Map<string, InvoiceLineForBucketing[]>();
  for (const r of data) {
    const invId = r.invoice_id;
    if (!invId) continue;
    const list = byInvoice.get(invId) ?? [];
    list.push({ vat_rate: r.vat_rate ?? null, line_total: r.line_total ?? null });
    byInvoice.set(invId, list);
  }
  return byInvoice;
}

export type AccountingExportLogInput = {
  orgId: string;
  createdBy: string;
  format: "csv" | "xero" | "quickbooks" | "sage";
  status: "generated" | "pushed" | "skipped_dark";
  rowCount: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  /**
   * Free-text outcome note — e.g. the truncation signal when a read hit the row
   * cap, so the audit history records that the export was partial. Optional.
   */
  note?: string | null;
};

/**
 * Append one row to the export audit log. Runs under the caller's JWT, so the
 * admin-write RLS policy on accounting_export_log is the real authorisation —
 * a non-admin's insert is refused by the database, not merely by this code.
 * Org-pinned. Best-effort: a log failure is reported but never sinks an export
 * the caller has already produced.
 */
export async function recordAccountingExport(
  input: AccountingExportLogInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  // accounting_export_log post-dates the generated types.ts, so the strict
  // `.from()` overload doesn't know it yet (the expense_budgets idiom). Cast to
  // a minimal insert builder — RLS is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => PromiseLike<{
        error: { message: string } | null;
      }>;
    };
  };
  const { error } = await loose.from("accounting_export_log").insert({
    org_id: input.orgId,
    created_by: input.createdBy,
    format: input.format,
    status: input.status,
    row_count: input.rowCount,
    period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null,
    note: input.note ?? null,
  });
  if (error) {
    console.error("[accounting] export-log insert failed", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ── PUSH-ONCE LEDGER (accounting_pushed_entities) ────────────────────────────

/** One source row a provider has accepted — its type + immutable CrewFlow id. */
export type PushedEntity = { entityType: "invoice" | "payment"; entityId: string };

/**
 * Read the set of (invoice / payment) source ids already pushed to a provider
 * for one org, from the push-once ledger. Org-pinned (runs under the caller's
 * JWT; member-read RLS). LOUD — a failed read throws, because the caller
 * (buildAccountingExport's exclusion) must NEVER proceed as if nothing was
 * pushed: that would re-push the whole history and duplicate every invoice.
 */
async function readPushedEntityIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  provider: AccountingProvider,
): Promise<{ invoice: Set<string>; payment: Set<string> }> {
  type LedgerRow = { entity_type: string; entity_id: string };
  // accounting_pushed_entities post-dates the generated types.ts, so cast to a
  // minimal paged read builder. `.range()` + a unique (entity_type, entity_id)
  // ordering pages the WHOLE anti-set: an incomplete exclusion set (capped at
  // 1000 by the PostgREST clamp before the F-1 fix) could let an entity beyond
  // the first 1000 be re-pushed and duplicated.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            order: (
              col: string,
              opts: { ascending: boolean },
            ) => {
              order: (
                col: string,
                opts: { ascending: boolean },
              ) => {
                range: (
                  from: number,
                  to: number,
                ) => PromiseLike<{
                  data: LedgerRow[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
    };
  };
  const { data, error } = await fetchAllRows<LedgerRow>((lo, hi) =>
    loose
      .from("accounting_pushed_entities")
      .select("entity_type, entity_id")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .order("entity_type", { ascending: true })
      .order("entity_id", { ascending: true })
      .range(lo, hi),
  );
  // LOUD — a failed read throws, never a silent "nothing excluded". An
  // incomplete anti-set would re-push the whole history and duplicate every
  // invoice; a failed sync is always safer than a duplicating one.
  if (error) {
    throw readFailure(
      "accounting export: pushed-entity ledger",
      error as SupabaseReadError,
    );
  }

  const invoice = new Set<string>();
  const payment = new Set<string>();
  for (const row of data) {
    if (row.entity_type === "invoice") invoice.add(row.entity_id);
    else if (row.entity_type === "payment") payment.add(row.entity_id);
  }
  return { invoice, payment };
}

/**
 * Record — idempotently — that a provider has ACCEPTED these source rows, so a
 * future sync excludes them. Runs under the caller's JWT, so the admin-write RLS
 * on accounting_pushed_entities is the real authorisation. Org-pinned.
 *
 * ON CONFLICT DO NOTHING via `ignoreDuplicates`: recording a row that is already
 * in the ledger is a no-op, so a retry (or a re-push the provider's idempotency
 * key collapsed) never errors and never double-records. Called with EXACTLY the
 * accepted prefix on a partial push, so a row is recorded only once it is truly
 * at the provider.
 */
export async function recordPushedEntities(input: {
  orgId: string;
  createdBy: string;
  provider: AccountingProvider;
  entities: readonly PushedEntity[];
}): Promise<{ ok: boolean; error?: string }> {
  if (input.entities.length === 0) return { ok: true };
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        rows: Record<string, unknown>[],
        opts: { onConflict: string; ignoreDuplicates: boolean },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const rows = input.entities.map((e) => ({
    org_id: input.orgId,
    created_by: input.createdBy,
    provider: input.provider,
    entity_type: e.entityType,
    entity_id: e.entityId,
  }));
  const { error } = await loose
    .from("accounting_pushed_entities")
    .upsert(rows, {
      onConflict: "org_id,provider,entity_type,entity_id",
      ignoreDuplicates: true,
    });
  if (error) {
    console.error("[accounting] pushed-entity record failed", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
