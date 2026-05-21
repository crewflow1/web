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
  requestQuoteApproval,
  reviewQuote,
} from "../actions";
import type { LineItem } from "@/lib/quotes/schema";
import { QUOTE_STATUSES, type QuoteStatus } from "@/lib/quotes/schema";
import { ShareLinkPanel } from "@/app/_components/share-link-panel";
import { env } from "@/lib/env";

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
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-700",
  sent: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-slate-200 text-slate-600",
};

const ERROR_MAP: Record<string, string> = {
  send_failed: "Couldn't mark as sent. Try again.",
  accept_failed: "Couldn't accept the quote.",
  decline_failed: "Couldn't decline the quote.",
  delete_failed: "Couldn't delete.",
  line_items_failed: "Line items didn't save — please re-enter them and save again.",
  request_failed: "Couldn't request approval. Try again.",
  review_failed: "Couldn't record the review. Try again.",
  not_found: "Quote not found.",
  invalid_action: "Invalid action.",
};

const SAVED_MAP: Record<string, string> = {
  "1": "Saved.",
  approval_requested: "Sent for approval. An owner or admin will review.",
  approved: "Approved. You can now send to the customer.",
  rejected: "Rejected. Edit and request approval again to resubmit.",
  changes_requested: "Changes requested — comment recorded.",
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

  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Role + quote in parallel.
  const [{ data: myRow }, { data: quote }] = await Promise.all([
    supabase.from("memberships").select("role").eq("org_id", ctx.org.id).single(),
    supabase
      .from("quotes")
      .select(
        `
          id, number, status, currency, subtotal, vat_total, total,
          customer_id, property_id, lead_id, valid_until, notes, terms,
          public_token, sent_at, viewed_at, accepted_at, declined_at,
          accept_signature, created_at, job_id,
          approved_by, approved_at, approval_comment,
          approver:users!quotes_approved_by_fkey ( id, full_name, email )
        `,
      )
      .eq("id", id)
      .maybeSingle(),
  ]);
  if (!quote) notFound();
  const isAdmin = myRow?.role === "owner" || myRow?.role === "admin";

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
  // Banner messages from lifecycle button actions (send/approve/etc.)
  // which still redirect with ?error/?saved. Form-level update errors
  // surface inline via useActionState inside QuoteBuilder.
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

  const publicAbsoluteUrl = quote.public_token
    ? `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/q/${quote.public_token}`
    : null;

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
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {savedMessage}
        </div>
      ) : null}

      {/* Lifecycle actions panel */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Share + lifecycle</h2>
        <div className="mt-3 space-y-3 text-sm">
          {publicAbsoluteUrl ? (
            <ShareLinkPanel
              title="Send this link to your client"
              hint={`They can view, accept, or decline online. Loading the link stamps a viewed-at timestamp on quote ${quote.number}.`}
              url={publicAbsoluteUrl}
              subject={`Your quote ${quote.number}`}
              bodyText={`Here's your quote ${quote.number} — you can view it and accept or decline online:`}
            />
          ) : null}

          <ul className="space-y-1 text-xs text-slate-600">
            <li>Sent: {quote.sent_at ?? "—"}</li>
            <li>Viewed: {quote.viewed_at ?? "—"}</li>
            <li>Accepted: {quote.accepted_at ?? "—"}</li>
            <li>Declined: {quote.declined_at ?? "—"}</li>
          </ul>

          {quote.job_id ? (
            <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              Linked job:{" "}
              <Link
                href={`/jobs/${quote.job_id}`}
                className="font-semibold underline hover:text-emerald-900"
              >
                /jobs/{quote.job_id.slice(0, 8)}
              </Link>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-2">
            {/* Draft or rejected → request approval */}
            {(status === "draft" || status === "rejected") ? (
              <form action={requestQuoteApproval.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                >
                  Request approval
                </button>
              </form>
            ) : null}

            {/* Approved → send to customer */}
            {status === "approved" ? (
              <form action={sendQuote.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                >
                  Send to customer
                </button>
              </form>
            ) : null}

            {/* Owner-accept / mark-declined remain available once the quote
                is actually live with the customer (approved + onwards). */}
            {(status === "sent" || status === "viewed" || status === "approved") ? (
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
            {(status === "sent" || status === "viewed" || status === "approved") ? (
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

      {/* Approval panel — visible when pending_approval, approved, or
          rejected. Admins see Approve / Reject / Request changes; staff
          see a read-only status note. */}
      {(status === "pending_approval" || status === "approved" || status === "rejected") ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Approval</h2>

          {/* Header line — who/when */}
          {status === "approved" ? (
            <p className="mt-1 text-sm text-slate-600">
              Approved by{" "}
              <strong className="text-slate-900">
                {quote.approver?.full_name ?? quote.approver?.email ?? "—"}
              </strong>
              {quote.approved_at ? ` on ${quote.approved_at.slice(0, 10)}` : ""}.
            </p>
          ) : status === "rejected" ? (
            <p className="mt-1 text-sm text-slate-600">
              Rejected by{" "}
              <strong className="text-slate-900">
                {quote.approver?.full_name ?? quote.approver?.email ?? "—"}
              </strong>
              {quote.approved_at ? ` on ${quote.approved_at.slice(0, 10)}` : ""}.
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-600">
              Awaiting approval from an owner or admin.
            </p>
          )}

          {/* Last comment */}
          {quote.approval_comment ? (
            <div className="mt-3 rounded-md border-l-2 border-slate-900 bg-slate-50 p-3 text-sm">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                Comment
              </div>
              <p className="mt-1 whitespace-pre-wrap text-slate-700">
                {quote.approval_comment}
              </p>
            </div>
          ) : null}

          {/* Action form — admins only, only when pending_approval */}
          {isAdmin && status === "pending_approval" ? (
            <form action={reviewQuote.bind(null, id)} className="mt-4 space-y-2">
              <label className="block text-xs text-slate-600">
                Comment
                <textarea
                  name="comment"
                  rows={2}
                  placeholder="Required for reject or request-changes; optional for approve"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  name="action"
                  value="approve"
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  Approve
                </button>
                <button
                  type="submit"
                  name="action"
                  value="request_changes"
                  className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
                >
                  Request changes
                </button>
                <button
                  type="submit"
                  name="action"
                  value="reject"
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  Reject
                </button>
              </div>
            </form>
          ) : !isAdmin && status === "pending_approval" ? (
            <p className="mt-3 text-xs text-slate-500">
              Only owners and admins can approve quotes.
            </p>
          ) : null}
        </section>
      ) : null}

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
