import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getRequestI18n } from "@/server/i18n/request";
import { requireManagementRole } from "@/server/auth/session";
import {
  INVOICE_STATUSES,
  OUTSTANDING_STATUSES,
  type InvoiceStatus,
} from "@/lib/invoices/schema";
import {
  OVERDUE_COLLECTABLE_STATUSES,
  invoiceBusinessToday,
  invoiceDisplayStatus,
} from "@/lib/invoices/overdue";
import { EmptyState } from "../_components/empty-state";
import { HelpLink } from "../_components/help-link";
import { readFailure } from "@/lib/supabase/read-failure";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

/**
 * Invoices list.
 *
 * RLS scopes to caller's org. Status filter via search params.
 */

const PAGE_SIZE = 50;

type SP = Promise<{ status?: string; page?: string; customer?: string }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

/**
 * Desktop columns for the canonical DataTable (roadmap G3). Sorting is
 * client-side over the loaded page; server filters/pagination above stay
 * authoritative and untouched. `sortValues`/`csv` on each row are the plain
 * values these keys point at — cells are pre-rendered ReactNodes because this
 * page is a server component and functions cannot cross the RSC boundary.
 */
const INVOICE_COLUMNS: DataTableColumn[] = [
  { key: "number", header: "Number", sortable: "text", cellClassName: "font-medium text-slate-900" },
  { key: "status", header: "Status", sortable: "text" },
  { key: "due", header: "Due", sortable: "date", cellClassName: "text-slate-600" },
  { key: "net", header: "Net", sortable: "number", numeric: true, cellClassName: "font-medium text-slate-900" },
  { key: "vat", header: "VAT", sortable: "number", numeric: true, cellClassName: "text-slate-600" },
  { key: "total", header: "Total", sortable: "number", numeric: true, cellClassName: "font-medium text-slate-900" },
  { key: "open", header: "", cellClassName: "text-right" },
];

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  awaiting_payment: "bg-amber-100 text-amber-800",
  partially_paid: "bg-indigo-100 text-indigo-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-slate-200 text-slate-500 line-through",
};

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  const { ctx, t } = await getRequestI18n();
  // Money is owner/admin only (nav marks it ADMIN_ROLES); enforce server-side so
  // a staff member cannot reach it by direct URL. RLS remains the last line.
  requireManagementRole(ctx);
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;
  const status = sp.status;
  const todayIso = invoiceBusinessToday();
  // Filter directly on the DURABLE `invoices.customer_id` anchor (composite FK
  // (customer_id, org_id) -> customers, migration 20260915000000). The prior
  // shape filtered through `quote:quotes!inner (customer_id)`, but PostgREST's
  // !inner join requires a matching quotes row — so every stage/progress-billing
  // invoice (`generate_stage_invoice`, migration 20261039000000, inserts
  // quote_id = NULL with customer_id set) was silently DROPPED from both this
  // list AND its exact count, under-reporting the customer's money. customer_id
  // is the same anchor the customer-detail rollup uses (lib/customers/financials.ts).
  const customerFilter =
    sp.customer && UUID_RE.test(sp.customer) ? sp.customer : null;

  const supabase = await createClient();
  // This query orders BEFORE applying the conditional status/customer filters,
  // and the generated typed builder narrows to a transform builder after
  // `.order()` (dropping `.eq`/`.in`/`.lt`), so we describe the builder shape
  // explicitly and cast past the typed client for this query only. RLS still
  // scopes the read; cross-tenant rows are unreachable regardless of cast, and
  // the composite FK guarantees a matched customer_id is this org's own.
  type UntypedQ = {
    select: (cols: string, opts?: unknown) => UntypedQ;
    eq: (k: string, v: unknown) => UntypedQ;
    in: (k: string, v: readonly unknown[]) => UntypedQ;
    lt: (k: string, v: unknown) => UntypedQ;
    order: (k: string, opts: { ascending: boolean }) => UntypedQ;
    range: (
      from: number,
      to: number,
    ) => Promise<{
      data: Array<{
        id: string;
        number: string;
        status: InvoiceStatus;
        amount: number | string | null;
        vat_total: number | string | null;
        total: number | string | null;
        due_date: string | null;
        created_at: string;
      }> | null;
      count: number | null;
      error: { message: string } | null;
    }>;
  };
  const cols = "id, number, status, amount, vat_total, total, due_date, created_at";
  let q = (supabase.from("invoices" as never) as unknown as UntypedQ)
    .select(cols, { count: "exact" })
    // ACTIVE-org pin. RLS admits every org the viewer belongs to, so a dual-org
    // member saw BOTH ledgers interleaved — and the exact count (which drives
    // pagination and the "N invoices" headline) summed the two.
    .eq("org_id", ctx.org.id)
    // `id` is a unique tiebreaker: `created_at` alone is not a total order, so
    // invoices sharing a timestamp could be skipped or repeated at a `.range()`
    // page boundary (the F-1 silent-truncation class).
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (status === "overdue") {
    // `overdue` is DERIVED, not stored — see lib/invoices/overdue.ts. Filtering
    // `.eq("status", "overdue")` here returned only rows someone had manually
    // marked, which is a different population from the one the dashboard tile
    // counts (`due_date < today`), so the tile's drill-through never matched
    // its own number. Express the predicate at the DB instead, so this list and
    // the tile select exactly the same invoices.
    q = q
      .in("status", OVERDUE_COLLECTABLE_STATUSES as unknown as string[])
      .lt("due_date", todayIso);
  } else if (status === "outstanding") {
    // The true outstanding (unpaid) population — the canonical OUTSTANDING_STATUSES
    // set (sent · awaiting_payment · partially_paid · overdue), NOT a `.eq("status",
    // "sent")` subset that silently drops awaiting_payment / partially_paid. This is
    // the drill-through target for the dashboard Outstanding / Expected-incoming
    // tiles, so the list population matches the tile's netted count.
    q = q.in("status", OUTSTANDING_STATUSES as unknown as string[]);
  } else if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status as InvoiceStatus);
  }
  if (customerFilter) {
    // Durable anchor — includes quote-less stage invoices. The count:'exact'
    // header is derived from this same filtered query, so headline and list agree.
    q = q.eq("customer_id", customerFilter);
  }

  const finalQuery = q.range(offset, offset + PAGE_SIZE - 1);

  const { data: rows, count, error: rowsError } = await finalQuery;
  if (rowsError) throw readFailure("invoices: ledger", rowsError);
  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  let filteredCustomerName: string | null = null;
  if (customerFilter) {
    const { data: c } = await supabase
      .from("customers")
      .select("name")
      .eq("id", customerFilter)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    filteredCustomerName = (c as { name?: string } | null)?.name ?? null;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{t("invoices.title")}</h1>
            <HelpLink article="sending-your-first-invoice" label="Help with invoicing" />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {totalCount} {totalCount === 1 ? "invoice" : "invoices"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/invoices/export?format=simple${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
          >
            Export CSV
          </a>
          <a
            href={`/api/invoices/export?format=xero${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
            title="One row per line item, mapped to Xero's sales-invoice import schema"
          >
            Export Xero
          </a>
          <a
            href={`/api/invoices/export?format=sage${status ? `&status=${status}` : ""}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
            title="One row per line item, mapped to Sage Business Cloud's sales-invoice import schema"
          >
            Export Sage
          </a>
          <Link
            href="/invoices/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            {t("invoices.action.new")}
          </Link>
        </div>
      </header>

      {customerFilter ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>
            Filtered to{" "}
            <strong>{filteredCustomerName ?? "customer"}</strong>{" "}
            ·{" "}
            <Link
              href={`/customers/${customerFilter}`}
              className="font-medium underline hover:text-indigo-800"
            >
              Back to customer
            </Link>
          </span>
          <Link
            href="/invoices"
            className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-50"
          >
            Clear customer filter
          </Link>
        </div>
      ) : null}

      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div>
          <label className="block text-xs font-medium text-slate-700">Status</label>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            <option value="outstanding">outstanding (unpaid)</option>
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {customerFilter ? (
          <input type="hidden" name="customer" value={customerFilter} />
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/invoices"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {!rows || rows.length === 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="💷"
            title={t("invoices.empty.title")}
            body={t("invoices.empty.body")}
            primary={{ href: "/invoices/new", label: t("invoices.empty.primary") }}
          />
        </div>
      ) : (
        /* Desktop table (DataTable renders the mobile cards below md itself).
           Bulk selection is NON-destructive by design: the only bulk action is
           a client-side CSV of the selected loaded rows (lib/csv escaping). */
        <DataTable
          label="Invoices"
          columns={INVOICE_COLUMNS}
          cardsBelow="md"
          className="rounded-lg border border-slate-200 bg-white shadow-sm"
          stickyHeader
          selectable
          csvExport={{
            filename: "invoices-selected.csv",
            header: ["Number", "Status", "Due date", "Net", "VAT", "Total"],
          }}
          rows={rows.map((inv) => {
            const displayStatus = invoiceDisplayStatus(inv, todayIso);
            const statusPill = (
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[displayStatus]}`}
              >
                {displayStatus}
              </span>
            );
            return {
              id: inv.id,
              href: `/invoices/${inv.id}`,
              selectLabel: `Select invoice ${inv.number}`,
              filterText: `${inv.number} ${displayStatus} ${inv.due_date ?? ""}`,
              sortValues: {
                number: inv.number,
                status: displayStatus,
                due: inv.due_date,
                net: Number(inv.amount ?? 0),
                vat: Number(inv.vat_total ?? 0),
                total: Number(inv.total ?? 0),
              },
              csv: [
                inv.number,
                displayStatus,
                inv.due_date ?? "",
                Number(inv.amount ?? 0),
                Number(inv.vat_total ?? 0),
                Number(inv.total ?? 0),
              ],
              cells: {
                number: inv.number,
                status: statusPill,
                due: inv.due_date ?? "—",
                net: GBP.format(Number(inv.amount ?? 0)),
                vat: GBP.format(Number(inv.vat_total ?? 0)),
                total: GBP.format(Number(inv.total ?? 0)),
                open: (
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="text-sm font-medium text-slate-700 hover:text-slate-900"
                  >
                    Open →
                  </Link>
                ),
              },
              mobileCard: (
                <Link
                  href={`/invoices/${inv.id}`}
                  className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition active:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900">{inv.number}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {inv.due_date ? `Due ${inv.due_date}` : "No due date"}
                        {" · VAT "}
                        {GBP.format(Number(inv.vat_total ?? 0))}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-900">
                        {GBP.format(Number(inv.total ?? 0))}
                      </div>
                      <span
                        className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[displayStatus]}`}
                      >
                        {displayStatus}
                      </span>
                    </div>
                  </div>
                </Link>
              ),
            };
          })}
        />
      )}

      {totalPages > 1 ? (
        <nav className="flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={{ pathname: "/invoices", query: { ...sp, page: page - 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                ← Previous
              </Link>
            ) : null}
            {page < totalPages ? (
              <Link
                href={{ pathname: "/invoices", query: { ...sp, page: page + 1 } }}
                className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
              >
                Next →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
