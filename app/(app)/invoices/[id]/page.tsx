import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { invoiceCustomerEmail } from "@/lib/invoices/customer";
import { InvoiceControls } from "./_controls";
import { voidInvoice } from "./payment-actions";
import { PaymentsPanel } from "./_payments-panel";
import { PaymentProofsPanel } from "./_payment-proofs-panel";
import type { InvoiceStatus } from "@/lib/invoices/schema";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  invoiceBusinessToday,
  invoiceDisplayStatus,
} from "@/lib/invoices/overdue";

/**
 * Invoice detail view.
 *
 * Shows invoice header, the linked quote's line items, totals, audit
 * timestamps, status controls, and a branded PDF download.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  awaiting_payment: "bg-amber-100 text-amber-800",
  partially_paid: "bg-indigo-100 text-indigo-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
  void: "bg-slate-200 text-slate-500 line-through",
};

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  // Void-flow feedback (20261219): the voidInvoice action redirects back here
  // with a code — a refused money correction must never fail silently.
  const banner = (() => {
    switch (sp.error ?? (sp.saved === "voided" ? "saved_voided" : "")) {
      case "void_reason_required":
        return { tone: "error" as const, text: "Add a reason before voiding — it goes on the audit record." };
      case "void_has_payments":
        return { tone: "error" as const, text: "This invoice has payments recorded, so it can't be voided. Remove the payment first, or issue a correction." };
      case "void_terminal":
        return { tone: "error" as const, text: "This invoice is already void — a void invoice is final." };
      case "void_failed":
        return { tone: "error" as const, text: "Couldn't void the invoice just now. Try again." };
      case "saved_voided":
        return { tone: "ok" as const, text: "Invoice voided. It no longer counts towards what you're owed." };
      default:
        return null;
    }
  })();
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Cast: job_id is in the 20260520150000 migration but not yet in the
  // generated Supabase types. We re-type the whole row through unknown
  // so subsequent property accesses resolve normally.
  type LoadedInvoice = {
    id: string;
    number: string;
    status: string;
    amount: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    due_date: string | null;
    sent_at: string | null;
    paid_at: string | null;
    notes: string | null;
    created_at: string;
    quote_id: string | null;
    job_id: string | null;
    voided_at: string | null;
    void_reason: string | null;
    // Direct customer anchor (Issue #349 Phase 1) — preferred over the quote
    // path, which is NULL for every stage-billing invoice.
    customer: { email: string | null } | null;
    quote: { customer: { email: string | null } | null } | null;
  };
  const { data: invoiceRaw, error: invoiceError } = await supabase
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, sent_at,
        paid_at, notes, created_at, quote_id, job_id, voided_at, void_reason,
        customer:customers!invoices_customer_org_fkey ( email ),
        quote:quotes ( customer:customers ( email ) )
      `,
    )
    .eq("id", id)
    // ACTIVE-org pin. The invoice API routes and the send/PDF paths were pinned
    // in #459; this page was not, so org B's invoice (and its customer's email)
    // rendered inside org A's shell where the money actions live. Pinning the
    // SUBJECT also makes the line-item and payment reads below derived-safe.
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (invoiceError) throw readFailure("invoice detail: invoice", invoiceError);
  const invoice = invoiceRaw as unknown as LoadedInvoice | null;

  if (!invoice) notFound();
  // Send-recipient resolves via the invoice's OWN customer first; the quote is
  // only the legacy-orphan fallback. A stage invoice has no quote, so a
  // quote-only read reported "no recipient" and disabled the send control even
  // though the invoice has a customer. See lib/invoices/customer.ts.
  const customerEmail = invoiceCustomerEmail(invoice);
  const linkedJobId = invoice.job_id;

  // Fetch the org's jobs for the link-to-job picker (customer surfaced
  // for recognisability). Limit + RLS-scoped under the user JWT.
  const { data: jobsForPicker, error: jobsError } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .order("created_at", { ascending: false })
    .limit(50);
  if (jobsError) throw readFailure("invoice detail: job picker", jobsError);

  // Payments against this invoice.
  const { data: paymentsRaw, error: paymentsError } = await supabase
    .from("invoice_payments")
    .select("id, amount, paid_at, reference, notes, source, created_at")
    .eq("invoice_id", id)
    .order("paid_at", { ascending: false });
  if (paymentsError) throw readFailure("invoice detail: payments", paymentsError);
  const payments = paymentsRaw ?? [];
  const paidTotal = payments.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const invTotal = Number(invoice.total ?? 0);
  const outstanding = Math.max(0, invTotal - paidTotal);

  // Line items from the invoice's own immutable snapshot (Issue #349 Phase 2),
  // not the live quote — so a later quote edit or deletion can't rewrite this
  // historical invoice. The snapshot is created atomically by the
  // invoices_snapshot_line_items trigger, so every invoice has one.
  // F-1: page the full snapshot — a large invoice can carry more than the
  // 1000-row PostgREST cap of line items; a clamped read would render (and, on
  // the PDF/email paths, bill) a truncated invoice. `sort_order` is the display
  // order; `id` is the unique tiebreak that keeps paging deterministic.
  type LineItemRow = {
    id: string;
    description: string;
    qty: number | string | null;
    unit: string | null;
    unit_price: number | string | null;
    vat_rate: number | string | null;
    line_total: number | string | null;
    sort_order: number | null;
  };
  const lineItemsRes = await fetchAllRows<LineItemRow>(
    (from, to) =>
      supabase
        .from("invoice_line_items")
        .select("id, description, qty, unit, unit_price, vat_rate, line_total, sort_order")
        .eq("invoice_id", id)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: LineItemRow[] | null;
        error: unknown;
      }>,
  );
  if (lineItemsRes.error) throw readFailure("invoice detail: line items", lineItemsRes.error);
  const lineItems = lineItemsRes.data;

  // Two different questions, deliberately kept apart:
  //   status        — what is STORED. The controls need this to know which
  //                   button is current, and it is what a write would replace.
  //   displayStatus — what a human should SEE. Overdue is derived, so a
  //                   past-due invoice reads "overdue" without anything having
  //                   been written. See lib/invoices/overdue.ts.
  const status = invoice.status as InvoiceStatus;
  const displayStatus = invoiceDisplayStatus(invoice, invoiceBusinessToday());

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {banner ? (
        <div
          role="status"
          className={
            banner.tone === "error"
              ? "rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              : "rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          }
        >
          {banner.text}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/invoices" className="hover:text-slate-900">
          Invoices
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{invoice.number}</span>
      </div>

      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/invoices"
            className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
          >
            ← Invoices
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">{invoice.number}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Created {invoice.created_at.slice(0, 10)}
            {invoice.due_date ? ` · Due ${invoice.due_date}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/api/invoices/${invoice.id}/pdf`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            target="_blank"
            rel="noopener noreferrer"
          >
            Download PDF
          </a>
          <span
            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[displayStatus]}`}
          >
            {displayStatus}
          </span>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Net
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.amount ?? 0))}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            VAT
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.vat_total ?? 0))}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Total
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.total ?? 0))}
          </div>
        </div>
      </section>

      {lineItems.length > 0 ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-base font-semibold text-slate-900">Line items</h2>
            <p className="text-xs text-slate-500">From quote {invoice.quote_id?.slice(0, 8)}</p>
          </header>
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-2">Description</th>
                <th className="px-6 py-2 text-right">Qty</th>
                <th className="px-6 py-2 text-right">Unit</th>
                <th className="px-6 py-2 text-right">VAT %</th>
                <th className="px-6 py-2 text-right">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lineItems.map((li) => (
                <tr key={li.id}>
                  <td className="px-6 py-2 text-slate-900">{li.description}</td>
                  <td className="px-6 py-2 text-right text-slate-600">{Number(li.qty)}</td>
                  <td className="px-6 py-2 text-right text-slate-600">
                    {GBP.format(Number(li.unit_price ?? 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-slate-600">
                    {Number(li.vat_rate)}%
                  </td>
                  <td className="px-6 py-2 text-right font-medium text-slate-900">
                    {GBP.format(Number(li.line_total ?? 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No line items — the source quote may have been deleted, or the quote
          has no line items.
        </p>
      )}

      {/* Proofs the customer sent via their portal. Sits directly above the
          payments panel because it's the evidence for the record-payment
          decision made there. Renders nothing when no proof was submitted. */}
      <PaymentProofsPanel invoiceId={invoice.id} />

      {/* Payments panel — manual record + history. Wave 3. */}
      <PaymentsPanel
        invoiceId={invoice.id}
        invoiceTotal={invTotal}
        paidTotal={paidTotal}
        outstanding={outstanding}
        payments={payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          paid_at: p.paid_at,
          reference: p.reference,
          notes: p.notes,
          source: p.source as "manual" | "bank_csv",
        }))}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Audit</h2>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Sent at</dt>
            <dd className="text-slate-700">{invoice.sent_at ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Paid at</dt>
            <dd className="text-slate-700">{invoice.paid_at ?? "—"}</dd>
          </div>
        </dl>
        {invoice.notes ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
              {invoice.notes}
            </p>
          </div>
        ) : null}
      </section>

      <AttachmentsPanel targetTable="invoices" targetId={invoice.id} />

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Actions</h2>
        <div className="mt-3">
          <InvoiceControls
            id={invoice.id}
            status={status}
            customerEmail={customerEmail}
            linkedJobId={linkedJobId}
            jobsForPicker={(() => {
              const opts = (jobsForPicker ?? []).map((j) => ({
                id: j.id,
                label: `${j.customer?.name ?? "Job"} · ${j.status}${j.scheduled_date ? ` · ${j.scheduled_date}` : ""}`,
              }));
              // Preserve-option (F-1 picker class): this is a recent-50 sample, so
              // an already-linked job older than the top 50 would have no matching
              // <option> and the controlled select would render blank — misleading
              // the user into thinking the invoice is unlinked. Inject the linked
              // id so it always displays. (Linking is an explicit onChange action,
              // so no unrelated save can null it — this only fixes the display.)
              if (linkedJobId && !opts.some((o) => o.id === linkedJobId)) {
                return [{ id: linkedJobId, label: "Currently linked job" }, ...opts];
              }
              return opts;
            })()}
          />
        </div>

        {/* Void (20261219): the operational correction for an invoice raised in
            error. Only offered while no money has landed (paid/partially_paid
            are a credit-note problem — deliberately unsupported here); the DB
            trigger is the real authority and refuses anything else, so this
            visibility check is UX, not security. Terminal once voided. */}
        {status !== "void" && status !== "paid" && status !== "partially_paid" ? (
          <form
            action={voidInvoice.bind(null, invoice.id)}
            className="mt-6 border-t border-slate-200 pt-4"
          >
            <div className="text-sm font-medium text-slate-900">
              Void this invoice
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Raised in error? Voiding keeps the record for your books but
              removes it from what you&apos;re owed. This cannot be undone. An
              invoice with payments recorded can&apos;t be voided — remove the
              payment first.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                name="reason"
                required
                minLength={3}
                maxLength={2000}
                placeholder="Reason (required)"
                className="w-64 max-w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
              >
                Void invoice
              </button>
            </div>
          </form>
        ) : null}
        {status === "void" ? (
          <p className="mt-6 border-t border-slate-200 pt-4 text-sm text-slate-500">
            This invoice was voided
            {invoice.voided_at ? ` on ${invoice.voided_at.slice(0, 10)}` : ""}
            {invoice.void_reason ? ` — “${invoice.void_reason}”` : ""}. It no
            longer counts towards what you&apos;re owed.
          </p>
        ) : null}
      </section>
    </div>
  );
}
