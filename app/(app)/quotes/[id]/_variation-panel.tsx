import Link from "next/link";
import { jobHref } from "@/lib/jobs/schema";
import { formatVariationLabel } from "@/lib/variations/schema";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import {
  recordVariationEotAgreement,
  reclassifyVariationValidUntilAsEot,
} from "../actions";

/**
 * Variation-specific surface on the quote detail page.
 *
 * A variation IS a quote (a row with `variation_number` set — 20260520180000),
 * so /quotes/[id] is its detail page. Until now that page rendered a variation
 * as an ordinary quote: no variation number, no cost basis, and no home for the
 * extension of time it was asking for. This panel is that home.
 *
 * Three jobs:
 *   1. Identify the row as a variation and link back to its job.
 *   2. Show the PRICED COST BASIS and the margin derived from it — the numbers
 *      computeVariation() used to throw away (20261073). Cost is internal: this
 *      panel is operator-only, and none of it reaches the customer portal or PDF.
 *   3. Hold the extension of time: what was requested, what was agreed, and a
 *      form to record an agreement. It states plainly that agreeing an EoT does
 *      NOT move the job — because it doesn't, and an operator who assumes it
 *      does would leave a live job silently mis-dated.
 *
 * Evidence lives in the existing <AttachmentsPanel targetTable="quotes"> already
 * mounted further down this page: `quotes` has been in the tenant_attachments
 * CHECK and in ATTACHMENT_TARGET_TABLES since Phase F, so a variation's site
 * instructions, emails, photos and drawings attach to it with no widening.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type VariationPanelQuote = {
  id: string;
  job_id: string | null;
  variation_number: number;
  subtotal: number | string | null;
  valid_until: string | null;
  eot_requested_completion_date: string | null;
  eot_agreed_completion_date: string | null;
  eot_agreed_at: string | null;
  cost_labour: number | string | null;
  cost_materials: number | string | null;
  cost_subcontractors: number | string | null;
  cost_misc: number | string | null;
  cost_total: number | string | null;
  agreedBy?: { full_name: string | null; email: string | null } | null;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

export function VariationPanel({
  quote,
  isAdmin,
}: {
  quote: VariationPanelQuote;
  isAdmin: boolean;
}) {
  const label = formatVariationLabel(quote.variation_number);
  const costTotal = num(quote.cost_total);
  const subtotal = num(quote.subtotal) ?? 0;
  // Margin is DERIVED, never stored — one number per fact, so a stored margin
  // can never disagree with the cost basis it came from.
  const grossProfit = costTotal === null ? null : Math.round((subtotal - costTotal) * 100) / 100;
  const marginPct =
    grossProfit === null || subtotal === 0
      ? null
      : Math.round((grossProfit / subtotal) * 100);

  // The pre-20261073 signature: a date sitting in the expiry column with no EoT
  // request recorded. Ambiguous by construction (see the action's docblock), so
  // we surface it and let the person who raised it decide — we never guess.
  const legacyMisfiledDate =
    !!quote.valid_until && !quote.eot_requested_completion_date;

  return (
    <section
      aria-labelledby="variation-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="variation-heading" className="text-base font-semibold text-slate-900">
          {label}
        </h2>
        {quote.job_id ? (
          <Link
            href={jobHref(quote.job_id)}
            className="text-xs font-medium text-slate-500 underline hover:text-slate-900"
          >
            View job &rarr;
          </Link>
        ) : null}
      </div>

      {/* ── Priced cost basis (internal) ─────────────────────────────────── */}
      <div className="mt-4">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Cost basis (internal)
        </h3>
        {costTotal === null ? (
          <p className="mt-2 text-xs text-slate-500">
            No cost basis recorded. Variations raised before this was persisted
            kept only the revenue split across their line items, so the margin
            they were priced at can&apos;t be recovered.
          </p>
        ) : (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Cell label="Labour" value={GBP.format(num(quote.cost_labour) ?? 0)} />
            <Cell label="Materials" value={GBP.format(num(quote.cost_materials) ?? 0)} />
            <Cell
              label="Subcontractors"
              value={GBP.format(num(quote.cost_subcontractors) ?? 0)}
            />
            <Cell label="Other" value={GBP.format(num(quote.cost_misc) ?? 0)} />
            <Cell label="Total cost" value={GBP.format(costTotal)} />
            <Cell
              label="Gross profit"
              value={`${GBP.format(grossProfit ?? 0)}${marginPct === null ? "" : ` · ${marginPct}%`}`}
              emphasis
            />
          </dl>
        )}
      </div>

      {/* ── Extension of time ────────────────────────────────────────────── */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Extension of time
        </h3>

        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <Cell
            label="Completion date requested"
            value={quote.eot_requested_completion_date ?? "—"}
          />
          <Cell
            label="Completion date agreed"
            value={quote.eot_agreed_completion_date ?? "Not agreed"}
            emphasis={!!quote.eot_agreed_completion_date}
          />
        </dl>

        {quote.eot_agreed_completion_date ? (
          <p className="mt-2 text-xs text-slate-500">
            Recorded
            {quote.eot_agreed_at ? ` ${quote.eot_agreed_at.slice(0, 10)}` : ""}
            {quote.agreedBy?.full_name || quote.agreedBy?.email
              ? ` by ${quote.agreedBy.full_name ?? quote.agreedBy.email}`
              : ""}
            . This job&apos;s programme was not changed — update the job&apos;s
            dates yourself if the plan is moving.
          </p>
        ) : null}

        {/* Legacy-row remediation. Deliberately loud: while it stands, this
            variation still carries an expiry that the accept gate will act on. */}
        {legacyMisfiledDate ? (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold text-amber-900">
              This variation has a &ldquo;valid until&rdquo; date of{" "}
              {quote.valid_until}.
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Variations used to store the requested completion date in the
              expiry field by mistake. While a date sits there, your customer
              can&apos;t accept this variation after it passes. If{" "}
              {quote.valid_until} is a completion date rather than an offer
              expiry, move it — otherwise leave it and clear it on the quote
              form when the offer really does lapse.
            </p>
            {isAdmin ? (
              <ConfirmForm
                action={reclassifyVariationValidUntilAsEot.bind(null, quote.id)}
                confirm={`Record ${quote.valid_until} as the requested completion date and clear the expiry? Do this only if that date is a completion date, not an offer expiry.`}
                className="mt-2 block"
              >
                <button
                  type="submit"
                  className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                >
                  It&apos;s a completion date — move it
                </button>
              </ConfirmForm>
            ) : (
              <p className="mt-2 text-xs text-amber-800">
                An owner or admin can correct this.
              </p>
            )}
          </div>
        ) : null}

        {isAdmin && !quote.eot_agreed_completion_date ? (
          <form
            action={recordVariationEotAgreement.bind(null, quote.id)}
            className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <label className="block flex-1 text-xs text-slate-600">
              Record the agreed completion date
              <input
                type="date"
                name="eot_agreed_completion_date"
                required
                className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 sm:py-1.5"
            >
              Record agreement
            </button>
          </form>
        ) : null}

        <p className="mt-3 text-[11px] text-slate-500">
          Recording an agreed extension does not move this job&apos;s dates.
          Whether an agreed EoT re-baselines the works programme is a decision
          for you, not the system — an agreed date can change the contractual
          completion date for damages without the programme moving with it.
        </p>
      </div>

      {/* ── Evidence pointer ─────────────────────────────────────────────── */}
      {/* The files themselves live in the AttachmentsPanel further down this
          page (target_table 'quotes' — already allowed, no widening needed).
          This exists because nothing previously told an operator that a
          variation's evidence has a home, and a disputed variation is won or
          lost on exactly these documents. */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Evidence
        </h3>
        <p className="mt-1 text-xs text-slate-600">
          Attach the site instruction, email, photo or drawing that authorises
          this variation in <strong className="text-slate-800">Attachments</strong>{" "}
          below. A disputed variation is won or lost on that paper trail.
        </p>
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          emphasis
            ? "mt-0.5 text-sm font-semibold text-slate-900"
            : "mt-0.5 text-sm text-slate-800"
        }
      >
        {value}
      </dd>
    </div>
  );
}
