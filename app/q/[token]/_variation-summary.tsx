import type { PortalVariationView } from "@/lib/variations/portal";
import { formatGbp } from "@/lib/money";

/**
 * The variation approval surface (Phase 7).
 *
 * A variation is a quote row, so the customer could always accept one — but the
 * page they accepted it on read like an ordinary quote. A client agreeing a
 * variation is agreeing three separate things, and this component is the only
 * place all three are put in front of them before they sign:
 *
 *   SCOPE     — what work is being added. The itemised table below this panel
 *               already carries it, so this panel points at it rather than
 *               duplicating it in a second, drift-prone summary.
 *   VALUE     — not just "£1,240", but what the contract becomes. A customer who
 *               cannot see the running total cannot consent to it.
 *   PROGRAMME — the extension of time. Until 20261073 this date was written into
 *               `quotes.valid_until` and printed to the customer under the label
 *               "Valid until", so the one fact a variation exists to communicate
 *               was being shown as its opposite: an offer expiry.
 *
 * Renders a `PortalVariationView` and nothing else. That shape is built field by
 * field by `buildPortalVariationView`, which never receives the priced cost
 * basis (20261073's cost_labour / cost_materials / cost_subcontractors /
 * cost_misc / cost_total) — the margin the business priced this variation at
 * lives on the very same row and must never reach this screen.
 *
 * Mobile-first: the grids collapse to a single column at 375px.
 */
export function VariationSummary({ view }: { view: PortalVariationView }) {
  const p = view.programme;
  const hasProgramme = Boolean(p.requested_completion_date || p.agreed_completion_date);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">
        What this variation changes
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        A variation is a change to work that&apos;s already agreed. Here&apos;s
        the effect on your contract — the itemised work is listed below.
      </p>

      {/* VALUE */}
      <div className="mt-4 rounded-xl bg-slate-50 p-3 sm:p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Value
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">Contract before this</dt>
            <dd className="font-medium text-slate-900">
              {formatGbp(view.contract.before)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">This variation</dt>
            <dd className="font-medium text-slate-900">
              {view.value.total >= 0 ? "+" : ""}
              {formatGbp(view.value.total)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">
              {view.decision === "accepted" ? "Contract now" : "Contract if you approve"}
            </dt>
            <dd className="text-base font-bold text-slate-900">
              {formatGbp(view.contract.after)}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">
          Includes VAT.{" "}
          {view.contract.approved_variations_count > 0
            ? `${view.contract.approved_variations_count} variation${
                view.contract.approved_variations_count === 1 ? "" : "s"
              } already approved on this job.`
            : "This is the first variation on this job."}
        </p>
      </div>

      {/* PROGRAMME */}
      <div className="mt-3 rounded-xl bg-slate-50 p-3 sm:p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Programme
        </div>
        {hasProgramme ? (
          <>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              {p.previous_agreed_completion_date ? (
                <div>
                  <dt className="text-xs text-slate-500">Completion date now</dt>
                  <dd className="text-slate-900">{p.previous_agreed_completion_date}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-xs text-slate-500">
                  {p.is_agreed ? "Completion date agreed" : "Completion date requested"}
                </dt>
                <dd className="font-medium text-slate-900">
                  {p.agreed_completion_date ?? p.requested_completion_date}
                </dd>
              </div>
              {p.days_added !== null ? (
                <div>
                  <dt className="text-xs text-slate-500">
                    {p.days_added >= 0 ? "Extra time" : "Time saved"}
                  </dt>
                  <dd className="text-slate-900">
                    {Math.abs(p.days_added)} {Math.abs(p.days_added) === 1 ? "day" : "days"}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              {p.is_agreed
                ? "This extension of time has been agreed."
                : "Approving this variation agrees the completion date above. It is a request to extend the programme — not a deadline for you to respond by."}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-700">
            No change to the completion date is being requested.
          </p>
        )}
      </div>
    </section>
  );
}
