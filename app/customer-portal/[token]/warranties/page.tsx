import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalWarranties } from "../../_warranties";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  NO_CERTIFICATE_NOTE,
  WARRANTY_STATUS_STYLES,
  type WarrantyStatus,
} from "@/lib/warranties/schedule";

/**
 * Customer-side warranties + servicing (Phase 7).
 *
 * NOTHING ON THIS PAGE IS SENT. Every date here is DERIVED at render time from
 * the frozen completion date on the job's issued completion certificate — there
 * is no reminder job, no queue and no email. CrewFlow does not contact anyone
 * about a warranty or a service; the customer sees the schedule when they open
 * this page, and that is the whole mechanism.
 *
 * Rows arrive from `listPortalWarranties`, which scopes by the customer's own
 * jobs and rebuilds a customer-safe shape field by field. This component renders
 * that shape and reads nothing else.
 *
 * No `force-dynamic`, matching every sibling portal route: the `[token]` segment
 * has no generateStaticParams, so this renders on demand already.
 */

function DateOrDash({ value }: { value: string | null }) {
  return <>{value ?? "—"}</>;
}

export default async function PortalWarrantiesPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const warranties = await listPortalWarranties(customer.id, customer.org_id);

  return (
    <PortalShell customer={customer} org={org} token={token} active="warranties">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your warranties</h2>
        <p className="mt-1 text-sm text-slate-600">
          Cover {org.name} has given you after completion, and any servicing that
          keeps it valid.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          These dates are shown here for you to check — we don&apos;t send
          warranty or service reminders, so please diarise anything you need to
          act on.
        </p>
      </section>

      {warranties.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No warranties yet</p>
          <p className="mt-1 text-xs text-slate-500">
            When {org.name} issues warranty cover for your work, it&apos;ll
            appear here.
          </p>
        </section>
      ) : (
        <ol className="space-y-3">
          {warranties.map((w) => (
            <li
              key={w.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-slate-900">{w.title}</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {w.kind_label} · {w.period_months}{" "}
                    {w.period_months === 1 ? "month" : "months"} · Job{" "}
                    {w.job_reference}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    WARRANTY_STATUS_STYLES[w.status as WarrantyStatus] ??
                    "bg-slate-100 text-slate-700"
                  }`}
                >
                  {w.status_label}
                </span>
              </div>

              {w.awaiting_completion_certificate ? (
                <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {NO_CERTIFICATE_NOTE}
                </p>
              ) : (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-slate-500">Cover starts</dt>
                    <dd className="text-slate-900">
                      <DateOrDash value={w.start_date} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Cover ends</dt>
                    <dd className="font-medium text-slate-900">
                      <DateOrDash value={w.expiry_date} />
                    </dd>
                  </div>
                  {w.days_remaining !== null ? (
                    <div>
                      <dt className="text-xs text-slate-500">
                        {w.days_remaining >= 0 ? "Days left" : "Expired"}
                      </dt>
                      <dd className="text-slate-700">
                        {w.days_remaining >= 0
                          ? w.days_remaining
                          : `${Math.abs(w.days_remaining)} days ago`}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              )}

              <p className="mt-3 whitespace-pre-wrap border-t border-slate-100 pt-3 text-sm text-slate-700">
                {w.cover}
              </p>
              {w.exclusions ? (
                <div className="mt-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Not covered
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">
                    {w.exclusions}
                  </p>
                </div>
              ) : null}

              {w.provider || w.reference ? (
                <p className="mt-2 text-xs text-slate-500">
                  {w.provider ? `Provided by ${w.provider}` : null}
                  {w.provider && w.reference ? " · " : null}
                  {w.reference ? `Ref ${w.reference}` : null}
                </p>
              ) : null}

              {w.service_interval_months ? (
                <div className="mt-3 rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Servicing
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    Every {w.service_interval_months}{" "}
                    {w.service_interval_months === 1 ? "month" : "months"}
                    {w.next_service_due ? ` · next due ${w.next_service_due}` : null}
                  </p>
                  {w.service_notes ? (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
                      {w.service_notes}
                    </p>
                  ) : null}
                  {w.service_schedule.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {w.service_schedule.map((s) => (
                        <li
                          key={s.sequence}
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            s.state === "overdue"
                              ? "bg-red-100 text-red-700"
                              : s.state === "due_soon"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-white text-slate-600 ring-1 ring-slate-200"
                          }`}
                        >
                          {s.due}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </PortalShell>
  );
}
