import Link from "next/link";
import {
  listCustomersForBilling,
  listBillingInvoicesForOrg,
  type CustomerBillingRow,
} from "@/server/services/hq-billing-snapshot";
import {
  BILLING_INVOICE_KINDS,
  BILLING_KIND_LABELS,
  BILLING_STATUS_LABELS,
  BILLING_STATUS_PILL,
  formatGbp,
  formatRenewal,
  type BillingInvoiceRow,
} from "@/lib/hq/billing";
import {
  SUBSCRIPTION_PILL,
  SETUP_FEE_LABELS,
  SETUP_FEE_PILL,
} from "@/lib/hq/customer-financials";
import {
  createBillingInvoice,
  setBillingInvoiceStatus,
  setNextRenewal,
} from "./actions";

/**
 * Billing OS — HQ-4.
 *
 * One row per customer with the revenue numbers the CEO triages:
 *
 *   Subscription · Setup fee · MRR · Outstanding · Failed payments ·
 *   Next renewal · LTV
 *
 * Click "Open billing" on any row → inline expand shows every
 * billing_invoices entry, status-flip buttons (Mark paid / Mark
 * failed / Refund / Void), a "create invoice" form, and a
 * next-renewal-date input.
 *
 * No Stripe automation yet — operator-managed today, webhooks land
 * in `billing_events` (HQ-4-stripe) and flip these same rows.
 */

type SP = Promise<{
  q?: string;
  status?: string;
  setup?: string;
  outstanding?: string;
  sort?: string;
  org?: string;
  saved?: string;
  error?: string;
}>;

const SUBSCRIPTION_OPTIONS: ReadonlyArray<string> = [
  "trial",
  "active",
  "past_due",
  "suspended",
  "cancelled",
  "pending",
];

export default async function HqBillingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const rows = await listCustomersForBilling();

  const q = (sp.q ?? "").trim().toLowerCase();
  const statusFilter = (sp.status ?? "").trim();
  const setupFilter = (sp.setup ?? "").trim();
  const outstandingOnly = sp.outstanding === "1";
  const sort = sp.sort ?? "outstanding";
  const openOrg = sp.org ?? null;

  const filtered = rows
    .filter((r) =>
      !q
        ? true
        : r.org_name.toLowerCase().includes(q) ||
          (r.owner_email ?? "").toLowerCase().includes(q) ||
          (r.owner_name ?? "").toLowerCase().includes(q),
    )
    .filter((r) => (statusFilter ? r.subscription === statusFilter : true))
    .filter((r) => (setupFilter ? r.setup_fee_status === setupFilter : true))
    .filter((r) => (outstandingOnly ? r.summary.outstandingGbp > 0 || r.summary.failedCount > 0 : true));

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "outstanding") {
      return b.summary.outstandingGbp - a.summary.outstandingGbp;
    }
    if (sort === "failed") return b.summary.failedCount - a.summary.failedCount;
    if (sort === "mrr") return b.mrr_gbp - a.mrr_gbp;
    if (sort === "ltv") return b.ltvEstimate - a.ltvEstimate;
    if (sort === "renewal") {
      const av = a.next_renewal_at ? new Date(a.next_renewal_at).getTime() : Infinity;
      const bv = b.next_renewal_at ? new Date(b.next_renewal_at).getTime() : Infinity;
      return av - bv;
    }
    if (sort === "name") return a.org_name.localeCompare(b.org_name);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Aggregate KPIs across the filtered set so the CEO sees what their
  // current view actually adds up to.
  const totals = sorted.reduce(
    (acc, r) => {
      acc.mrr += r.mrr_gbp;
      acc.outstanding += r.summary.outstandingGbp;
      acc.paid += r.summary.paidGbp;
      acc.failed += r.summary.failedCount;
      return acc;
    },
    { mrr: 0, outstanding: 0, paid: 0, failed: 0 },
  );

  const banner = (() => {
    if (sp.error) return { tone: "err" as const, msg: decodeURIComponent(sp.error) };
    if (sp.saved) return { tone: "ok" as const, msg: prettySaved(sp.saved) };
    return null;
  })();

  // Load invoices for the open row only — never N+1.
  const openInvoices: BillingInvoiceRow[] = openOrg
    ? await listBillingInvoicesForOrg(openOrg)
    : [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Billing OS</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every customer&apos;s subscription, setup fee, outstanding balance
          and failed-payment count in one place. Click <strong>Open</strong>{" "}
          on any row to record invoices, flip statuses, or set the next
          renewal date.
        </p>
      </header>

      {/* KPI tiles (filter-aware) */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="MRR (filtered)" value={formatGbp(totals.mrr)} />
        <Tile
          label="Outstanding"
          value={formatGbp(totals.outstanding)}
          tone={totals.outstanding > 0 ? "warn" : undefined}
        />
        <Tile label="Paid total" value={formatGbp(totals.paid)} />
        <Tile
          label="Failed payments"
          value={String(totals.failed)}
          tone={totals.failed > 0 ? "danger" : undefined}
        />
      </section>

      {/* Filter toolbar */}
      <Filters
        q={q}
        status={statusFilter}
        setup={setupFilter}
        outstanding={outstandingOnly}
        sort={sort}
        count={filtered.length}
      />

      {banner ? (
        <div
          role={banner.tone === "err" ? "alert" : "status"}
          className={
            banner.tone === "err"
              ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          }
        >
          {banner.msg}
        </div>
      ) : null}

      {/* Customer rows */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {sorted.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            No customers match the current filters.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sorted.map((r) => (
              <CustomerBillingRowView
                key={r.org_id}
                row={r}
                open={openOrg === r.org_id}
                invoices={openOrg === r.org_id ? openInvoices : []}
                qs={buildQs(sp)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CustomerBillingRowView({
  row,
  open,
  invoices,
  qs,
}: {
  row: CustomerBillingRow;
  open: boolean;
  invoices: BillingInvoiceRow[];
  qs: URLSearchParams;
}) {
  const subscriptionPill = SUBSCRIPTION_PILL[row.subscription];
  const setupPill = SETUP_FEE_PILL[row.setup_fee_status];

  // Build expand/collapse hrefs — preserve filter state in the URL.
  const expandQs = new URLSearchParams(qs);
  expandQs.set("org", row.org_id);
  const collapseQs = new URLSearchParams(qs);
  collapseQs.delete("org");

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/admin/customers/${row.org_id}`}
            className="text-sm font-semibold text-slate-900 hover:text-slate-700"
          >
            {row.org_name}
          </Link>
          <p className="truncate text-[11px] text-slate-500">
            {row.owner_email ?? "—"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`rounded-full border px-2 py-0.5 ${subscriptionPill}`}>
            {row.subscription}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${setupPill}`}>
            Setup: {SETUP_FEE_LABELS[row.setup_fee_status]}
          </span>
          {row.summary.failedCount > 0 ? (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-800">
              {row.summary.failedCount} failed
            </span>
          ) : null}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-6">
        <Field label="MRR" value={formatGbp(row.mrr_gbp)} />
        <Field label="LTV" value={formatGbp(row.ltvEstimate)} />
        <Field
          label="Outstanding"
          value={formatGbp(row.summary.outstandingGbp)}
          tone={row.summary.outstandingGbp > 0 ? "warn" : undefined}
        />
        <Field label="Paid total" value={formatGbp(row.summary.paidGbp)} />
        <Field
          label="Next renewal"
          value={formatRenewal(row.next_renewal_at)}
        />
        <Field
          label="Invoices"
          value={`${row.summary.invoiceCount}`}
        />
      </dl>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/customers/${row.org_id}`}
          className="text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          Open customer →
        </Link>
        {open ? (
          <Link
            href={`/admin/billing?${collapseQs.toString()}`}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
            scroll={false}
          >
            Collapse
          </Link>
        ) : (
          <Link
            href={`/admin/billing?${expandQs.toString()}`}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            scroll={false}
          >
            Open billing
          </Link>
        )}
        {row.stripe_customer_id ? (
          <span className="text-[10px] text-slate-500">
            Stripe: <code>{row.stripe_customer_id}</code>
          </span>
        ) : (
          <span className="text-[10px] text-slate-400">Stripe not linked</span>
        )}
      </div>

      {open ? (
        <ExpandedBilling row={row} invoices={invoices} />
      ) : null}
    </li>
  );
}

function ExpandedBilling({
  row,
  invoices,
}: {
  row: CustomerBillingRow;
  invoices: BillingInvoiceRow[];
}) {
  const renewalIso = row.next_renewal_at
    ? row.next_renewal_at.slice(0, 10)
    : "";
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/40 p-3 lg:grid-cols-[1fr_320px]">
      {/* Invoices list */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <header className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">
            Invoices ({invoices.length})
          </h3>
        </header>
        {invoices.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            No invoices yet. Record one with the form on the right when
            you send a setup or subscription invoice.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} row={inv} />
            ))}
          </ul>
        )}
      </div>

      {/* Side: create invoice + set renewal */}
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Record invoice
          </h3>
          <p className="mt-1 text-[11px] text-slate-500">
            Tracks what you&apos;ve sent. Status defaults to{" "}
            <strong>sent</strong>; flip to <strong>paid</strong> once
            money lands.
          </p>
          <form action={createBillingInvoice} className="mt-2 space-y-2 text-[11px]">
            <input type="hidden" name="org_id" value={row.org_id} />
            <label className="block text-slate-700">
              Kind
              <select
                name="kind"
                defaultValue="subscription"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {BILLING_INVOICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {BILLING_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-slate-700">
              Amount (£)
              <input
                name="amount_gbp"
                type="number"
                step={1}
                min={0}
                required
                defaultValue={500}
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-slate-700">
              Status on save
              <select
                name="status"
                defaultValue="sent"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="sent">Sent</option>
                <option value="paid">Paid</option>
                <option value="draft">Draft</option>
              </select>
            </label>
            <label className="block text-slate-700">
              Due date
              <input
                name="due_date"
                type="date"
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-slate-700">
              Notes <span className="text-slate-400">optional</span>
              <input
                name="notes"
                type="text"
                maxLength={2000}
                placeholder="e.g. May subscription"
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save invoice
            </button>
          </form>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h3 className="text-sm font-semibold text-slate-900">Next renewal</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            When the next monthly bill is due. Stripe will manage this
            once webhooks are wired up.
          </p>
          <form action={setNextRenewal} className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <input type="hidden" name="org_id" value={row.org_id} />
            <input
              name="next_renewal_at"
              type="date"
              defaultValue={renewalIso}
              className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function InvoiceRow({ row }: { row: BillingInvoiceRow }) {
  const pill = BILLING_STATUS_PILL[row.status];
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-900">
            {BILLING_KIND_LABELS[row.kind]}
          </span>
          <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${pill}`}>
            {BILLING_STATUS_LABELS[row.status]}
          </span>
        </div>
        <p className="text-[10px] text-slate-500">
          {formatGbp(row.amount_gbp)}
          {row.due_date ? ` · Due ${row.due_date}` : ""}
          {row.paid_at ? ` · Paid ${row.paid_at.slice(0, 10)}` : ""}
          {row.failed_at ? ` · Failed ${row.failed_at.slice(0, 10)}` : ""}
          {row.failure_reason ? ` · ${row.failure_reason}` : ""}
        </p>
        {row.notes ? (
          <p className="mt-0.5 text-[10px] text-slate-400">{row.notes}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {row.status !== "paid" && row.status !== "void" ? (
          <FlipButton invoiceId={row.id} status="paid" label="Mark paid" tone="emerald" />
        ) : null}
        {row.status === "sent" || row.status === "draft" ? (
          <FlipButton invoiceId={row.id} status="failed" label="Mark failed" tone="red" />
        ) : null}
        {row.status === "paid" ? (
          <FlipButton invoiceId={row.id} status="refunded" label="Refund" tone="amber" />
        ) : null}
        {row.status === "draft" || row.status === "sent" || row.status === "failed" ? (
          <FlipButton invoiceId={row.id} status="void" label="Void" tone="slate" />
        ) : null}
      </div>
    </li>
  );
}

function FlipButton({
  invoiceId,
  status,
  label,
  tone,
}: {
  invoiceId: string;
  status: "paid" | "failed" | "refunded" | "void";
  label: string;
  tone: "emerald" | "red" | "amber" | "slate";
}) {
  const cls =
    tone === "emerald"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
      : tone === "red"
        ? "border-red-300 bg-white text-red-700 hover:bg-red-50"
        : tone === "amber"
          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <form action={setBillingInvoiceStatus} className="inline-block">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${cls}`}
      >
        {label}
      </button>
    </form>
  );
}

function Filters({
  q,
  status,
  setup,
  outstanding,
  sort,
  count,
}: {
  q: string;
  status: string;
  setup: string;
  outstanding: boolean;
  sort: string;
  count: number;
}) {
  return (
    <form
      method="GET"
      action="/admin/billing"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
    >
      <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-600">
        Search
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Company, owner email…"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm"
        />
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Subscription
        <select
          name="status"
          defaultValue={status}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">All</option>
          {SUBSCRIPTION_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Setup fee
        <select
          name="setup"
          defaultValue={setup}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
          <option value="waived">Waived</option>
          <option value="refunded">Refunded</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
        <input
          type="checkbox"
          name="outstanding"
          value="1"
          defaultChecked={outstanding}
        />
        Outstanding only
      </label>
      <label className="text-[11px] font-medium text-slate-600">
        Sort
        <select
          name="sort"
          defaultValue={sort}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          <option value="outstanding">Outstanding ↓ (chase first)</option>
          <option value="failed">Failed payments ↓</option>
          <option value="mrr">MRR ↓</option>
          <option value="ltv">LTV ↓</option>
          <option value="renewal">Next renewal ↑</option>
          <option value="name">Name A→Z</option>
          <option value="newest">Newest</option>
        </select>
      </label>
      <button
        type="submit"
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
      >
        Apply
      </button>
      <p className="text-[11px] text-slate-500">{count} customers</p>
    </form>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "danger";
}) {
  const cls =
    tone === "danger"
      ? "border-red-200 bg-red-50"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50"
        : "border-slate-200 bg-white";
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${cls}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  const cls = tone === "warn" ? "text-amber-800" : "text-slate-900";
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`font-medium ${cls}`}>{value}</dd>
    </div>
  );
}

function prettySaved(saved: string): string {
  const s = decodeURIComponent(saved);
  if (s === "invoice_created") return "Invoice recorded.";
  if (s.startsWith("invoice_")) return `Invoice → ${s.slice("invoice_".length)}.`;
  if (s === "renewal") return "Renewal date saved.";
  return "Saved.";
}

function buildQs(sp: {
  q?: string;
  status?: string;
  setup?: string;
  outstanding?: string;
  sort?: string;
}): URLSearchParams {
  const out = new URLSearchParams();
  if (sp.q) out.set("q", sp.q);
  if (sp.status) out.set("status", sp.status);
  if (sp.setup) out.set("setup", sp.setup);
  if (sp.outstanding) out.set("outstanding", sp.outstanding);
  if (sp.sort) out.set("sort", sp.sort);
  return out;
}
