import { createAdminClient } from "@/lib/supabase/admin";
import { publicAcceptQuote, publicDeclineQuote } from "./actions";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Public customer-facing quote view.
 *
 * Accessed via the shareable /q/<public_token> URL. The route is allow-listed
 * in middleware so anonymous users hit it without redirect. All DB access
 * uses the service-role admin client, gated only by knowledge of the token.
 *
 * On page load we best-effort stamp `viewed_at` (only if not already
 * set) — that's how the owner knows the customer opened the link.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function PublicQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const admin = createAdminClient();

  const { data: quote, error: quoteError } = await admin
    .from("quotes")
    .select(
      `
        id, org_id, number, status, currency, subtotal, vat_total, total,
        notes, terms, valid_until, public_token,
        sent_at, viewed_at, accepted_at, declined_at, accept_signature,
        job_id, variation_number,
        eot_requested_completion_date, eot_agreed_completion_date,
        customer:customers ( id, name, email ),
        org:organizations ( id, name, logo_path, logo_url, vat_number, address, bank_details, phone, default_terms )
      `,
    )
    .eq("public_token", token)
    .maybeSingle();
  // Loud fail: a query failure must never tell a paying customer their quote
  // link is invalid — that costs acceptances.
  if (quoteError) throw readFailure("public quote: load", quoteError);

  // Wave 2 — hide quotes that haven't cleared the approval gate. We still
  // serve a friendly "link not available" page rather than a bare 404
  // because customers don't know what a 404 means, and they DO know the
  // contractor sent them a link. When the token doesn't resolve at all,
  // we have no contractor contact info to surface; otherwise we pass the
  // org's phone/email so the customer can chase a fresh link.
  const VISIBLE = new Set([
    "approved",
    "sent",
    "viewed",
    "accepted",
    "declined",
    "expired",
  ]);
  if (!quote || !VISIBLE.has(quote.status)) {
    const orgForFallback = quote?.org as
      | { name?: string | null; phone?: string | null }
      | null
      | undefined;
    return (
      <InvalidLinkPage
        kind="quote"
        contractor={
          orgForFallback
            ? { name: orgForFallback.name, phone: orgForFallback.phone }
            : undefined
        }
      />
    );
  }

  // Stamp viewed_at on first open. Don't await heavily — the failure mode
  // is a missing analytics datapoint, not a broken page.
  if (!quote.viewed_at && (quote.status === "sent" || quote.status === "draft")) {
    await admin
      .from("quotes")
      .update({
        viewed_at: new Date().toISOString(),
        status: quote.status === "draft" ? quote.status : "viewed",
      })
      .eq("id", quote.id);
  }

  const { data: lineItems, error: lineItemsError } = await admin
    .from("quote_line_items")
    .select("description, qty, unit, unit_price, vat_rate, line_total, sort_order")
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true });
  // Never render an acceptable quote with totals but zero scope lines.
  if (lineItemsError) throw readFailure("public quote: line items", lineItemsError);

  const org = quote.org;
  // Uploaded logos live in a private bucket → resolve a short-lived signed URL.
  // Legacy external logo_url values pass through unchanged (back-compat).
  const logoSrc = await resolveOrgLogoSrc(org, admin);
  const orgAddress =
    (org?.address as {
      line1?: string;
      city?: string;
      postcode?: string;
    } | null) ?? {};
  const orgBank =
    (org?.bank_details as {
      name?: string;
      sort_code?: string;
      account_number?: string;
      reference?: string;
    } | null) ?? null;

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const acceptedMessage = sp.saved === "accepted" || quote.status === "accepted";
  const declinedMessage = sp.saved === "declined" || quote.status === "declined";

  const isLocked =
    quote.status === "accepted" ||
    quote.status === "declined" ||
    quote.status === "expired";

  // Variation surface: when quotes.variation_number is set, the same
  // record represents a Variation Order. Header copy, badge, and the
  // accept/decline labels switch accordingly.
  const variationNumber =
    (quote as unknown as { variation_number: number | null }).variation_number ?? null;
  const isVariation = variationNumber !== null;
  const variationLabel = isVariation
    ? `Variation #${String(variationNumber).padStart(3, "0")}`
    : null;

  // Extension of time. This is part of what the customer is being asked to
  // agree, so it belongs on the document they accept from — and it is a
  // DIFFERENT fact from "Valid until", which is when the offer lapses. Until
  // 20261073 the requested completion date was written into valid_until, so this
  // page printed a completion date under the label "Valid until".
  const eot = quote as unknown as {
    eot_requested_completion_date: string | null;
    eot_agreed_completion_date: string | null;
  };
  const completionDate = isVariation
    ? eot.eot_agreed_completion_date ?? eot.eot_requested_completion_date
    : null;
  const completionAgreed = isVariation && !!eot.eot_agreed_completion_date;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header / brand */}
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {isVariation ? variationLabel : "Quote"}
              </div>
              <h1 className="mt-1 text-2xl font-bold text-slate-900">
                {isVariation ? variationLabel : quote.number}
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                From <span className="font-medium text-slate-900">{org?.name}</span>
                {org?.vat_number ? ` · VAT ${org.vat_number}` : ""}
              </p>
              {orgAddress.line1 || orgAddress.city || orgAddress.postcode ? (
                <p className="mt-0.5 text-xs text-slate-500">
                  {[orgAddress.line1, orgAddress.city, orgAddress.postcode]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              {logoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoSrc}
                  alt={`${org?.name ?? "Company"} logo`}
                  className="h-12 w-auto object-contain"
                />
              ) : null}
              <a
                href={`/q/${token}/pdf`}
                className="mt-2 inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                target="_blank"
                rel="noopener noreferrer"
              >
                Download PDF
              </a>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500">For</dt>
              <dd className="font-medium text-slate-900">
                {quote.customer?.name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Valid until</dt>
              <dd className="text-slate-700">{quote.valid_until ?? "—"}</dd>
            </div>
            {completionDate ? (
              <div>
                <dt className="text-xs text-slate-500">
                  {completionAgreed ? "Completion date agreed" : "Completion date requested"}
                </dt>
                <dd className="text-slate-700">{completionDate}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-slate-500">Status</dt>
              <dd className="text-slate-700">{quote.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Total</dt>
              <dd className="font-semibold text-slate-900">
                {GBP.format(Number(quote.total ?? 0))}
              </dd>
            </div>
          </dl>
        </header>

        {/* Alerts */}
        {errorMessage ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {errorMessage}
          </div>
        ) : null}
        {acceptedMessage ? (
          <div
            role="status"
            className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          >
            <strong>Quote accepted successfully.</strong> Invoice generated and
            emailed{quote.customer?.email ? ` to ${quote.customer.email}` : ""}.
            {org?.name ? ` ${org.name} will be in touch to schedule the work.` : ""}
          </div>
        ) : null}
        {declinedMessage ? (
          <div
            role="status"
            className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
          >
            Quote declined.
          </div>
        ) : null}

        {/* Line items */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Description</th>
                  <th className="px-6 py-3 text-right">Qty</th>
                  <th className="px-6 py-3 text-right">Unit</th>
                  <th className="px-6 py-3 text-right">VAT %</th>
                  <th className="px-6 py-3 text-right">Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(lineItems ?? []).map((li, i) => (
                  <tr key={i}>
                    <td className="px-6 py-3 text-slate-900">{li.description}</td>
                    <td className="px-6 py-3 text-right text-slate-700">
                      {Number(li.qty)}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-700">
                      {GBP.format(Number(li.unit_price ?? 0))}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-700">
                      {Number(li.vat_rate)}%
                    </td>
                    <td className="px-6 py-3 text-right font-medium text-slate-900">
                      {GBP.format(Number(li.line_total ?? 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-200 px-6 py-4">
            <dl className="ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Subtotal</dt>
                <dd className="font-medium text-slate-900">
                  {GBP.format(Number(quote.subtotal ?? 0))}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">VAT</dt>
                <dd className="font-medium text-slate-900">
                  {GBP.format(Number(quote.vat_total ?? 0))}
                </dd>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <dt className="font-medium text-slate-900">Total</dt>
                <dd className="font-bold text-slate-900">
                  {GBP.format(Number(quote.total ?? 0))}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Notes + terms */}
        {quote.notes || quote.terms ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4 text-sm text-slate-700">
            {quote.notes ? (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Notes
                </div>
                <p className="mt-1 whitespace-pre-wrap">{quote.notes}</p>
              </div>
            ) : null}
            {quote.terms ? (
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Terms
                </div>
                <p className="mt-1 whitespace-pre-wrap">{quote.terms}</p>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Bank details (only shown after acceptance) */}
        {quote.status === "accepted" && orgBank ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              How to pay
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              You&apos;ll receive a separate invoice — these are the bank
              details to pay it.
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-slate-500">Account name</dt>
                <dd className="text-slate-900">{orgBank.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Sort code</dt>
                <dd className="text-slate-900">{orgBank.sort_code ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Account number</dt>
                <dd className="text-slate-900">{orgBank.account_number ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Reference</dt>
                <dd className="text-slate-900">
                  {orgBank.reference ?? quote.number}
                </dd>
              </div>
            </dl>
          </section>
        ) : null}

        {/* Accept / decline */}
        {!isLocked ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              {isVariation ? "Approve this variation" : "Accept this quote"}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Type your full name below — this counts as your electronic
              signature. We&apos;ll record the date, your name, and send{" "}
              {org?.name} a notification so they can schedule the work.
            </p>
            <form
              action={publicAcceptQuote.bind(null, token)}
              className="mt-4 space-y-3"
            >
              <label
                htmlFor="signer_name"
                className="block text-sm font-medium text-slate-800"
              >
                Your full name (this is your signature)
              </label>
              <input
                id="signer_name"
                type="text"
                name="signer_name"
                required
                placeholder="e.g. Alex Smith"
                autoComplete="name"
                className="block w-full rounded-md border border-slate-300 px-3 py-2.5 font-[cursive] text-lg focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                style={{ fontFamily: 'ui-serif, Georgia, "Times New Roman", serif', fontStyle: "italic" }}
              />
              <p className="text-xs text-slate-500">
                By typing your name and submitting, you agree to the terms of
                this {isVariation ? "variation" : "quote"} and confirm you are
                authorised to accept on behalf of the customer. The signature,
                today&apos;s date, your IP and browser are all recorded as part
                of the audit trail.
              </p>
              <textarea
                name="comment"
                rows={2}
                placeholder="Optional — leave a comment for the team"
                className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                {isVariation ? "Approve & sign" : "Accept & sign"}
              </button>
            </form>

            <details className="mt-4 text-sm text-slate-600">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-900">
                {isVariation ? "Reject instead" : "Decline instead"}
              </summary>
              <form
                action={publicDeclineQuote.bind(null, token)}
                className="mt-3 space-y-2"
              >
                <textarea
                  name="reason"
                  rows={3}
                  placeholder={isVariation ? "Optional — reason for rejecting" : "Optional — reason for declining"}
                  className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <textarea
                  name="comment"
                  rows={2}
                  placeholder="Optional — additional comment for the team"
                  className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  {isVariation ? "Reject variation" : "Decline quote"}
                </button>
              </form>
            </details>
          </section>
        ) : null}

        <footer className="pt-4 text-center text-xs text-slate-600">
          Powered by CrewFlow
        </footer>
      </div>
    </div>
  );
}
