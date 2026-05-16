import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { QuoteBuilder } from "../_builder";
import {
  listCustomersForQuote,
  listPropertiesForQuote,
  listLeadsForQuote,
} from "../_form-helpers";
import {
  updateQuote,
  sendQuote,
  deleteQuote,
  acceptQuoteAsOwner,
  declineQuoteAsOwner,
} from "../actions";
import type { LineItem } from "@/lib/quotes/schema";
import { QUOTE_STATUSES, type QuoteStatus } from "@/lib/quotes/schema";

/**
 * Quote edit + lifecycle actions page.
 *
 * Owner sees:
 *   - The builder pre-populated with the quote's line items.
 *   - A status / share panel: status badge, public link (when sent), and
 *     the appropriate lifecycle action (Send / Mark accepted / Mark declined).
 *   - A delete card.
 *
 * Re-using the builder for edit means everything is live-computed; saving
 * replaces line items wholesale (cleaner than diffing for v1).
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<QuoteStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-slate-200 text-slate-600",
};

const ERROR_MAP: Record<string, string> = {
  update_failed: "Couldn't save changes. Try again.",
  send_failed: "Couldn't mark as sent. Try again.",
  accept_failed: "Couldn't accept the quote.",
  decline_failed: "Couldn't decline the quote.",
  delete_failed: "Couldn't delete.",
  line_items_failed: "Line items didn't save — please re-enter them and save again.",
};

const SAVED_MAP: Record<string, string> = {
  "1": "Saved.",
  sent: "Marked as sent. Share the customer link below.",
  accepted: "Accepted. Draft invoice created.",
  declined: "Marked as declined.",
};

type SP = Promise<{ error?: string; saved?: string; warn?: string }>;

export default async function EditQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  await requireOrgContext();
  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select(
      `
        id, number, status, currency, subtotal, vat_total, total,
        customer_id, property_id, lead_id, valid_until, notes, terms,
        public_token, sent_at, viewed_at, accepted_at, declined_at,
        accept_signature, created_at
      `,
    )
    .eq("id", id)
    .maybeSingle();
  if (!quote) notFound();

  const { data: rawItems } = await supabase
    .from("quote_line_items")
    .select("description, qty, unit, unit_price, vat_rate, sort_order")
    .eq("quote_id", id)
    .order("sort_order", { ascending: true });

  const lineItems: LineItem[] = (rawItems ?? []).map((li) => ({
    description: li.description,
    qty: Number(li.qty ?? 1),
    unit: li.unit ?? "ea",
    unit_price: Number(li.unit_price ?? 0),
    vat_rate: Number(li.vat_rate ?? 20),
  }));

  const [customers, properties, leads] = await Promise.all([
    listCustomersForQuote(),
    listPropertiesForQuote(),
    listLeadsForQuote(),
  ]);

  const status = quote.status as QuoteStatus;
  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved
    ? SAVED_MAP[sp.saved] ?? "Saved."
    : null;
  const warnMessage =
    sp.warn === "invoice_skipped"
      ? "Quote accepted, but the auto-invoice didn't create. Generate it manually from /invoices/new."
      : null;

  const publicUrl = quote.public_token ? `/q/${quote.public_token}` : null;

  const isLocked = status === "accepted" || status === "declined" || status === "expired";

  // Bind the quote id into the update action for the builder's form prop.
  const updateAction = updateQuote.bind(null, id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/quotes" className="hover:text-slate-900">
          Quotes
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">{quote.number}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{quote.number}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {GBP.format(Number(quote.total ?? 0))} ·{" "}
            {QUOTE_STATUSES.includes(status) ? status : "unknown status"}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}
        >
          {status}
        </span>
      </header>

      {warnMessage ? (
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {warnMessage}
        </div>
      ) : null}

      {/* Lifecycle actions panel */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Share + lifecycle</h2>
        <div className="mt-3 space-y-3 text-sm">
          {publicUrl ? (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Customer link
              </div>
              <div className="mt-1 break-all rounded-md bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
                {publicUrl}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Share this URL with the customer. They can view, accept, or
                decline online. Loading the link stamps a viewed-at timestamp.
              </p>
            </div>
          ) : null}

          <ul className="space-y-1 text-xs text-slate-600">
            <li>Sent: {quote.sent_at ?? "—"}</li>
            <li>Viewed: {quote.viewed_at ?? "—"}</li>
            <li>Accepted: {quote.accepted_at ?? "—"}</li>
            <li>Declined: {quote.declined_at ?? "—"}</li>
          </ul>

          <div className="flex flex-wrap gap-2 pt-2">
            {status === "draft" || status === "viewed" ? (
              <form action={sendQuote.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                >
                  Mark as sent
                </button>
              </form>
            ) : null}
            {!isLocked ? (
              <form action={acceptQuoteAsOwner.bind(null, id)}>
                <input
                  type="hidden"
                  name="signer_name"
                  value="Owner-accepted on customer's behalf"
                />
                <button
                  type="submit"
                  className="rounded-md border border-green-300 bg-white px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50"
                >
                  Accept on customer&apos;s behalf
                </button>
              </form>
            ) : null}
            {!isLocked ? (
              <form action={declineQuoteAsOwner.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  Mark declined
                </button>
              </form>
            ) : null}
            <a
              href={`/api/quotes/${id}/pdf`}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download PDF
            </a>
          </div>
        </div>
      </section>

      {isLocked ? (
        <div
          role="status"
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
        >
          This quote is {status}. Edit a locked quote by changing its status
          first, or duplicate it as a new draft (not yet implemented — for
          now, create a new one).
        </div>
      ) : (
        <QuoteBuilder
          action={updateAction}
          submitLabel="Save changes"
          customers={customers}
          properties={properties}
          leads={leads}
          defaultCustomerId={quote.customer_id ?? ""}
          defaultPropertyId={quote.property_id ?? ""}
          defaultLeadId={quote.lead_id ?? ""}
          defaultValidUntil={quote.valid_until ?? ""}
          defaultNotes={quote.notes ?? ""}
          defaultTerms={quote.terms ?? ""}
          defaultLineItems={lineItems}
          errorMessage={errorMessage}
          savedMessage={savedMessage}
          cancelHref="/quotes"
        />
      )}

      <form
        action={deleteQuote.bind(null, id)}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this quote</p>
        <p className="mt-1 text-xs text-red-700">
          Line items will be removed too (cascade). Any linked invoice will
          have its quote reference cleared but otherwise stays put.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Delete quote
        </button>
      </form>
    </div>
  );
}
