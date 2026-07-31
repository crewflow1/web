import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import {
  composeAgedDebtors,
  type DebtorInvoice,
} from "@/lib/commercial/aged-debtors";
import {
  composeAgedCreditors,
  type CreditorBill,
} from "@/lib/commercial/aged-creditors";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";
import type { AgeingLedger } from "@/lib/commercial/ageing";

/**
 * AGED DEBTORS + AGED CREDITORS — the read layer. READ-ONLY by construction.
 *
 * The invoice, payment-allocation and supplier-bill data have all been live for
 * some time; what did not exist is an AGED view of either side. This module does
 * the READS and nothing else: every figure is composed by the pure bridges
 * (`lib/commercial/aged-debtors`, `lib/commercial/aged-creditors`), which in turn
 * take settlement from the authorities that own it — `invoiceRemaining` for
 * receivables, `computeBillSettlements` for payables. There is no money
 * arithmetic in this file beyond `round2`-summing an invoice's payment rows into
 * the `paid` figure those authorities expect.
 *
 * No `insert`/`update`/`delete`/`upsert`/`rpc` appears here and none may be
 * added; nothing writes `finances`. Pinned by
 * __tests__/security/aged-ledgers-org-scope.test.ts.
 *
 * ── WHICH DATE AGEING IS MEASURED FROM ───────────────────────────────────────
 * Debtors age from the invoice DUE DATE; creditors from the supplier's BILL DATE,
 * because the schema stores no supplier due date or payment terms. Both decisions
 * (and the DDL gap behind the second) are set out in the bridge modules' headers.
 *
 * ── THE AS-AT DAY, AND WHY IT IS THE CASH SERVICE'S DAY ──────────────────────
 * `invoiceBusinessToday` — the SAME day authority `isInvoiceOverdue`, /cash and
 * the invoice list evaluate against. That is what makes
 *
 *     debtors.totals.total   === computeOrgCashSummary(...).owedNow
 *     debtors.totals.pastDue === computeOrgCashSummary(...).overdue
 *
 * hold as stated rather than approximately: a London-pinned day key would be a
 * marginally better calendar answer that only this report used, and for the hour
 * after London midnight in summer this page and /cash would disagree about which
 * invoices are late. Reconciliation with the number the business already trusts
 * beats a private improvement. Rendered dates ARE London-pinned
 * (`lib/time/format`), which is where a reader actually notices. The identities
 * are proved in __tests__/commercial/aged-debtors-reconciliation.test.ts.
 *
 * ── ACTIVE-ORG PINNING + PAGING ──────────────────────────────────────────────
 * Every read is `.eq("org_id", orgId)`: RLS's `current_org_ids()` admits every
 * org the viewer belongs to, so a customer or supplier trading with BOTH the
 * viewer's companies would otherwise be aged as ONE account with the two
 * companies' debts added together — a single row that is wrong in a way an
 * operator cannot see. Reads page through `fetchAllRows` with `id` appended to
 * every ordering, so no page boundary can drop a row and understate the ledger
 * (the F-1 class).
 *
 * ── LOUD READS ───────────────────────────────────────────────────────────────
 * A failed read must never render as "nothing outstanding". Any failure sets
 * `loadError` and the page shows an explicit banner.
 *
 * ── THE ADMIN GATE ON PAYABLES ───────────────────────────────────────────────
 * `supplier_payments` and `supplier_payment_allocations` are admin-only at the
 * RLS layer, and a non-admin's read of them returns EMPTY WITHOUT AN ERROR. So
 * composing creditors for a non-admin would show every bill as entirely unpaid
 * and OVERSTATE payables by everything already paid — not a permission problem,
 * a wrong number. Creditors are therefore gated on the role BEFORE the read and
 * the caller is told (`creditorsVisible: false`) instead of being handed a
 * plausible fiction.
 */

type Row = Record<string, unknown>;

/**
 * `supplier_payments` / `supplier_payment_allocations` post-date the generated
 * types in lib/supabase/types.ts, so the client is reached through a precise
 * structural shim — the same seam server/services/org-cash.ts uses.
 */
type AnyB = PromiseLike<{ data: Row[] | null }> & {
  select: (c: string) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyB;
  not: (k: string, op: string, v: unknown) => AnyB;
};
type LooseClient = { from: (t: string) => AnyB };

const mv = (v: unknown) => v as number | string | null;
const sv = (v: unknown) => (v == null ? null : String(v));

export interface AgedLedgersView {
  debtors: AgeingLedger;
  creditors: AgeingLedger;
  /** False when the viewer may not read the money-out ledger — see the header. */
  creditorsVisible: boolean;
  /** The as-at business day every figure was computed against (YYYY-MM-DD). */
  asAtIso: string;
  loadError: boolean;
}

const EMPTY_LEDGER: AgeingLedger = {
  rows: [],
  totals: {
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 },
    total: 0,
    pastDue: 0,
    itemCount: 0,
    partyCount: 0,
    undated: 0,
  },
};

/** One table, every row, org-pinned, paged, uniquely ordered. */
async function paged(
  db: LooseClient,
  table: string,
  cols: string,
  orderKey: string,
  orgId: string,
  refine?: (b: AnyB) => AnyB,
): Promise<{ rows: Row[]; failed: boolean }> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    let base = db.from(table).select(cols).eq("org_id", orgId);
    if (refine) base = refine(base);
    base = base.order(orderKey, { ascending: true });
    return (orderKey === "id" ? base : base.order("id", { ascending: true })).range(from, to);
  });
  return { rows: data, failed: error != null };
}

/** Owners and admins only — the money-out ledger's own RLS boundary. */
export function canReadPayables(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Build both aged ledgers for the ACTIVE org.
 *
 * `role` gates payables (see the header). `now` is injectable so the page and the
 * tests pin one as-at instant.
 */
export async function buildAgedLedgers(
  orgId: string,
  role: string,
  now: Date = new Date(),
): Promise<AgedLedgersView> {
  const asAtIso = invoiceBusinessToday(now);
  const creditorsVisible = canReadPayables(role);

  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    // ── receivables ──────────────────────────────────────────────────────────
    const arResults = await Promise.all([
      paged(db, "invoices", "id, number, status, total, due_date, customer_id, job_id", "id", orgId),
      paged(db, "invoice_payments", "invoice_id, amount", "invoice_id", orgId),
      paged(db, "customers", "id, name", "id", orgId),
      // A pre-denormalisation invoice can have a null `customer_id`
      // (20260915000000); its job still knows the customer, so the job is the
      // fallback rather than dumping real debt into "Unattributed".
      paged(db, "jobs", "id, customer_id", "id", orgId),
    ]);
    let loadError = arResults.some((r) => r.failed);
    const [invoiceRows = [], paymentRows = [], customerRows = [], jobRows = []] = arResults.map(
      (r) => r.rows,
    );

    // Per-invoice paid, from the ledger. Bucketed once by invoice_id so the scan
    // stays linear rather than O(invoices × payments). This is the ONLY money
    // operation in this file, and it is the same round2-wrapped fold
    // server/services/org-cash.ts performs for the same purpose.
    const paidByInvoice = new Map<string, number>();
    for (const p of paymentRows) {
      const id = String(p.invoice_id);
      paidByInvoice.set(id, round2((paidByInvoice.get(id) ?? 0) + toPounds(mv(p.amount))));
    }

    const invoices: DebtorInvoice[] = invoiceRows.map((i) => ({
      id: String(i.id),
      number: sv(i.number),
      status: String(i.status ?? ""),
      total: mv(i.total),
      due_date: sv(i.due_date),
      customer_id: sv(i.customer_id),
      job_id: sv(i.job_id),
      paid: paidByInvoice.get(String(i.id)) ?? 0,
    }));

    const debtors = composeAgedDebtors(
      invoices,
      {
        customerName: new Map(customerRows.map((c) => [String(c.id), sv(c.name) ?? ""])),
        jobCustomer: new Map(jobRows.map((j) => [String(j.id), sv(j.customer_id)])),
      },
      asAtIso,
    );

    // ── payables ─────────────────────────────────────────────────────────────
    let creditors = EMPTY_LEDGER;
    if (creditorsVisible) {
      const apResults = await Promise.all([
        // Only bills attributable to a supplier can be aged against an account.
        paged(
          db,
          "finances",
          "id, amount, vat_total, reference, bill_date, created_at, supplier_id",
          "id",
          orgId,
          (b) => b.not("supplier_id", "is", null),
        ),
        // `id` + `voided_at` are all the settlement authority needs. The cash and
        // CIS-withholding columns are deliberately NOT read: an aged listing has
        // no business carrying tax figures it does not display.
        paged(db, "supplier_payments", "id, voided_at", "id", orgId),
        paged(
          db,
          "supplier_payment_allocations",
          "payment_id, finance_id, amount",
          "payment_id",
          orgId,
        ),
        paged(db, "suppliers", "id, name", "id", orgId),
      ]);
      if (apResults.some((r) => r.failed)) loadError = true;
      const [billRows = [], apPaymentRows = [], allocationRows = [], supplierRows = []] =
        apResults.map((r) => r.rows);

      const bills: CreditorBill[] = billRows.map((b) => ({
        id: String(b.id),
        amount: mv(b.amount),
        vat_total: mv(b.vat_total),
        reference: sv(b.reference),
        bill_date: sv(b.bill_date),
        created_at: sv(b.created_at),
        supplier_id: sv(b.supplier_id),
      }));
      const payments: SupplierPaymentRow[] = apPaymentRows.map((p) => ({
        id: String(p.id),
        // Placeholders: `computeBillSettlements` reads only `id` and `voided_at`
        // (via `isLivePayment`). Nothing below is rendered or summed.
        paid_at: "",
        method: "",
        reference: null,
        gross_amount: null,
        cis_withheld: null,
        net_paid: null,
        voided_at: sv(p.voided_at),
      }));
      const allocations: SupplierAllocationRow[] = allocationRows.map((a) => ({
        payment_id: String(a.payment_id),
        finance_id: String(a.finance_id),
        amount: mv(a.amount),
      }));

      creditors = composeAgedCreditors(
        {
          bills,
          payments,
          allocations,
          supplierName: new Map(supplierRows.map((s) => [String(s.id), sv(s.name) ?? ""])),
        },
        asAtIso,
      );
    }

    return { debtors, creditors, creditorsVisible, asAtIso, loadError };
  } catch (err) {
    console.warn("[aged-ledgers] buildAgedLedgers failed", err);
    return {
      debtors: EMPTY_LEDGER,
      creditors: EMPTY_LEDGER,
      creditorsVisible,
      asAtIso,
      loadError: true,
    };
  }
}
