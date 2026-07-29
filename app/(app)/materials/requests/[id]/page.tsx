import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formatDateUK, formatDayKeyUK } from "@/lib/time/format";
import { StateForm } from "@/components/forms/StateForm";
import { listSitesForOrg, type SiteRow, type SitesClient } from "@/server/services/sites";
import {
  loadMaterialRequest,
  userLabel,
  jobLabel,
  jobLocation,
} from "@/server/services/material-requests";
import {
  materialRequestActions,
  MATERIAL_REQUEST_PRIORITY_CLASS,
  MATERIAL_REQUEST_PRIORITY_LABEL,
  MATERIAL_REQUEST_STATUS_CLASS,
  MATERIAL_REQUEST_STATUS_LABEL,
  type MaterialRequestPriority,
} from "@/lib/material-requests/schema";
import {
  formatMaterialQty,
  isMaterialRequestOverdue,
} from "@/lib/material-requests/fulfilment";
import {
  cancelMaterialRequest,
  createPoDraftFromRequest,
  decideMaterialRequest,
  fulfilRequestLineFromStock,
  submitMaterialRequest,
} from "../actions";

/**
 * One materials request — the office's decision surface.
 *
 * WHAT IS AND IS NOT SHOWN. The per-line "fulfilled" figures are DERIVED from
 * stock issue movements; there is no stored counter. When the stock module
 * cannot be reached the panel says so explicitly instead of rendering "0 of
 * 20", because those are different claims and only one of them is true.
 *
 * BUTTONS MIRROR THE DATABASE. `materialRequestActions` is the TypeScript
 * mirror of the transition trigger's authorisation rules, so this page never
 * offers a button the database will refuse. Neither of the two DERIVED
 * statuses appears anywhere here — no button produces them.
 */

export const dynamic = "force-dynamic";

export default async function MaterialRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const { ctx, user } = await requireOrgContext();

  // ACTIVE-ORG PINNED inside the service: a dual-org member passes RLS for
  // BOTH companies, so an RLS-only read would happily render the other
  // company's request inside this company's shell.
  const detail = await loadMaterialRequest(ctx.org.id, id);
  if (!detail) notFound();

  const { request, lines, fulfilment } = detail;
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const isOwnRequest = request.requested_by === user.id || request.created_by === user.id;
  const actions = materialRequestActions(request.status, { isAdmin, isOwnRequest });
  const todayIso = formatDayKeyUK(new Date());
  const overdue = isMaterialRequestOverdue(request, todayIso);
  const priority = (request.priority as MaterialRequestPriority) ?? "normal";
  const who = jobLabel(request.job);
  const where = jobLocation(request.job);

  const canRaisePo =
    isAdmin &&
    (request.status === "approved" || request.status === "partially_fulfilled") &&
    fulfilment.totalOutstanding > 0;

  // THE PRODUCER of fulfilment. A request that is live and measurable can have
  // its catalogue-linked lines issued straight from stock — the one path that
  // stamps a material_request_line_id onto a movement and advances the request
  // (fulfilRequestLineFromStock → the cross-lane seam). Only offered when the
  // stock module is actually reachable: "stock module pending" means we cannot
  // measure fulfilment, so we must not invite an issue against it either.
  const canFulfilFromStock =
    !fulfilment.stockModulePending &&
    (request.status === "approved" || request.status === "partially_fulfilled");
  let fulfilSites: { id: string; name: string }[] = [];
  if (canFulfilFromStock) {
    const supabase = await createClient();
    const rows = await listSitesForOrg<SiteRow>(supabase as unknown as SitesClient, ctx.org.id);
    fulfilSites = rows.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <div>
        <Link href="/materials/requests" className="text-sm text-slate-500 hover:text-slate-800">
          ← Materials
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900">{request.number}</h1>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${MATERIAL_REQUEST_STATUS_CLASS[request.status]}`}
          >
            {MATERIAL_REQUEST_STATUS_LABEL[request.status]}
          </span>
          {priority === "urgent" ? (
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${MATERIAL_REQUEST_PRIORITY_CLASS.urgent}`}
            >
              {MATERIAL_REQUEST_PRIORITY_LABEL.urgent}
            </span>
          ) : null}
          {overdue ? (
            <span className="rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800">
              Past needed-by
            </span>
          ) : null}
        </div>
      </div>

      {saved === "1" ? (
        <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Request saved.
        </p>
      ) : null}

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-slate-500">Job</dt>
            <dd className="font-medium text-slate-900">
              {who ? (
                <Link href={`/jobs/${request.job?.id}`} className="hover:underline">
                  {who}
                </Link>
              ) : (
                <span className="text-slate-500">Yard / van stock</span>
              )}
              {where ? <span className="block text-xs font-normal text-slate-500">{where}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Asked by</dt>
            <dd className="font-medium text-slate-900">{userLabel(request.requester)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Needed by</dt>
            <dd className={`font-medium ${overdue ? "text-red-700" : "text-slate-900"}`}>
              {request.needed_by ? (
                <time dateTime={request.needed_by}>{formatDateUK(request.needed_by)}</time>
              ) : (
                "No date given"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Raised</dt>
            <dd className="font-medium text-slate-900">{formatDateUK(request.created_at)}</dd>
          </div>
          {request.decided_at ? (
            <div className="sm:col-span-2">
              <dt className="text-xs text-slate-500">
                {request.status === "rejected" ? "Rejected" : "Approved"} by
              </dt>
              <dd className="font-medium text-slate-900">
                {userLabel(request.decider)} · {formatDateUK(request.decided_at)}
              </dd>
            </div>
          ) : null}
        </dl>

        {request.notes ? (
          <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
            {request.notes}
          </p>
        ) : null}

        {request.rejection_reason ? (
          <p className="mt-4 whitespace-pre-wrap rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <span className="font-semibold">Rejected: </span>
            {request.rejection_reason}
          </p>
        ) : null}
      </section>

      {/* ── Lines + derived fulfilment ──────────────────────────────────── */}
      <section
        aria-labelledby="mr-lines-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="mr-lines-heading" className="text-base font-semibold text-slate-900">
            What was asked for
          </h2>
          {fulfilment.stockModulePending ? (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              Stock module pending
            </span>
          ) : (
            <span className="text-xs text-slate-500">
              {formatMaterialQty(fulfilment.totalFulfilled)} of{" "}
              {formatMaterialQty(fulfilment.totalRequested)} issued · {fulfilment.pct}%
            </span>
          )}
        </div>

        {fulfilment.stockModulePending ? (
          <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            Fulfilment is worked out from stock issues. The stock module isn&rsquo;t
            available here yet, so we can show what was asked for but not what has
            gone out. This is deliberately blank rather than zero — they mean
            different things.
          </p>
        ) : null}

        <ul className="mt-3 divide-y divide-slate-100">
          {lines.map((line) => {
            const pos = fulfilment.lines.find((l) => l.lineId === line.id);
            return (
              <li key={line.id} className="py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 basis-full font-medium text-slate-900 sm:flex-1 sm:basis-0">
                    {line.description}
                  </span>
                  <span className="text-sm text-slate-700">
                    {formatMaterialQty(line.qty)} {line.unit ?? "ea"}
                  </span>
                </div>
                {pos && !fulfilment.stockModulePending ? (
                  <p className="mt-1 text-xs">
                    {pos.complete ? (
                      <span className="font-medium text-emerald-700">Issued in full</span>
                    ) : (
                      <span className="text-slate-600">
                        {formatMaterialQty(pos.fulfilled)} issued ·{" "}
                        <span className="font-medium text-amber-800">
                          {formatMaterialQty(pos.outstanding)} {pos.unit} still outstanding
                        </span>
                      </span>
                    )}
                    {/*
                      An over-issue is SURFACED, never swallowed. The displayed
                      "fulfilled" figure is clamped to what was requested (a bar
                      past 100% reads as a bug), so without this line the extra
                      would vanish silently from every screen.
                    */}
                    {pos.over ? (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                        {formatMaterialQty(pos.overBy)} {pos.unit} more than asked for went out
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {/*
                  THE PRODUCER. Issuing from stock stamps this line's id onto the
                  movement and advances the request (fulfilRequestLineFromStock →
                  the seam). Only offered for a catalogue-linked, still-outstanding
                  line while the stock module is reachable — a free-text line is
                  sourced through "Create PO draft" instead.
                */}
                {canFulfilFromStock && fulfilSites.length > 0 && line.stock_item_id && pos && !pos.complete ? (
                  <StateForm
                    action={fulfilRequestLineFromStock}
                    className="mt-2 flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="request_id" value={request.id} />
                    <input type="hidden" name="material_request_line_id" value={line.id} />
                    <label className="text-xs">
                      <span className="block text-slate-500">Issue</span>
                      <input
                        type="number"
                        name="qty"
                        step="0.01"
                        min="0.01"
                        defaultValue={pos.outstanding}
                        className="mt-0.5 w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                      />
                    </label>
                    <label className="text-xs">
                      <span className="block text-slate-500">From</span>
                      <select
                        name="site_id"
                        required
                        defaultValue=""
                        className="mt-0.5 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                      >
                        <option value="" disabled>
                          Pick a site
                        </option>
                        {fulfilSites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="min-h-9 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Issue from stock
                    </button>
                  </StateForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Decision / actions ──────────────────────────────────────────── */}
      {actions.length > 0 || canRaisePo ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">What happens next</h2>

          {actions.includes("submitted") ? (
            <StateForm action={submitMaterialRequest}>
              <input type="hidden" name="id" value={request.id} />
              <button
                type="submit"
                className="min-h-11 w-full rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
              >
                Send for approval
              </button>
            </StateForm>
          ) : null}

          {actions.includes("approved") ? (
            <StateForm action={decideMaterialRequest} className="space-y-3">
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="decision" value="approved" />
              <button
                type="submit"
                className="min-h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 sm:w-auto"
              >
                Approve
              </button>
            </StateForm>
          ) : null}

          {actions.includes("rejected") ? (
            <StateForm action={decideMaterialRequest} className="space-y-2">
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="decision" value="rejected" />
              <label className="block">
                <span className="text-xs font-medium text-slate-600">
                  Why are you turning it down?
                </span>
                <textarea
                  name="rejection_reason"
                  rows={2}
                  required
                  maxLength={1000}
                  placeholder="e.g. we already have 30 bags in the yard"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </label>
              <button
                type="submit"
                className="min-h-11 w-full rounded-lg border border-rose-300 bg-white px-4 text-sm font-semibold text-rose-800 hover:bg-rose-50 sm:w-auto"
              >
                Reject
              </button>
            </StateForm>
          ) : null}

          {canRaisePo ? (
            <StateForm action={createPoDraftFromRequest} className="space-y-1">
              <input type="hidden" name="id" value={request.id} />
              <button
                type="submit"
                className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 sm:w-auto"
              >
                Create PO draft for the shortfall
              </button>
              <p className="text-xs text-slate-500">
                Copies the {formatMaterialQty(fulfilment.totalOutstanding)} still
                outstanding onto a <strong>draft</strong> purchase order. You pick the
                supplier and the prices — nothing is sent.
              </p>
            </StateForm>
          ) : null}

          {actions.includes("cancelled") ? (
            <StateForm
              action={cancelMaterialRequest}
              confirm="Cancel this request? The site will see it was stood down."
            >
              <input type="hidden" name="id" value={request.id} />
              <button
                type="submit"
                className="min-h-11 text-sm font-medium text-slate-500 underline hover:text-slate-800"
              >
                Cancel this request
              </button>
            </StateForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
