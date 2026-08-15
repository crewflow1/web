import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalWarranties } from "../../_warranties";
import { listPortalWarrantyClaims } from "../../_warranty-claims";
import { submitWarrantyClaim } from "../../_warranty-claim-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  NO_CERTIFICATE_NOTE,
  WARRANTY_STATUS_STYLES,
  type WarrantyStatus,
} from "@/lib/warranties/schedule";
import {
  CLAIM_STAGE_LABELS,
  CLAIM_STAGE_STYLES,
} from "@/lib/warranties/claims";
import { maintenanceRemindersSending } from "@/lib/maintenance/readiness";

/**
 * Customer-side warranties + servicing (Phase 7) + WARRANTY CLAIMS (P3).
 *
 * NOTHING ON THIS PAGE IS SENT: every warranty/service date is DERIVED at render
 * time from the frozen completion date on the job's issued completion certificate
 * (see _warranties.ts) — there is no reminder job, no queue, no email. CrewFlow
 * does not contact anyone about a warranty or a service.
 *
 * The one action here that WRITES is a customer-initiated warranty CLAIM: it
 * opens an internal support ticket (category 'warranty_claim') the customer then
 * follows on the Messages thread. That is an internal record + the existing
 * support automation, NOT a warranty/service reminder email — the "no send"
 * invariant above is about reminders, and it still holds. The coarse claim
 * status reads back here, all scoped to the customer's own jobs.
 */

type SP = Promise<{ saved?: string; error?: string }>;

function DateOrDash({ value }: { value: string | null }) {
  return <>{value ?? "—"}</>;
}

export default async function PortalWarrantiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const warranties = await listPortalWarranties(customer.id, customer.org_id);
  // Claim read-back — scoped to the customer's OWN visible warranty ids.
  const claims = await listPortalWarrantyClaims(
    customer.id,
    customer.org_id,
    warranties.map((w) => w.id),
  );
  const claimsByWarranty = new Map<string, typeof claims>();
  for (const c of claims) {
    const arr = claimsByWarranty.get(c.warranty_id) ?? [];
    arr.push(c);
    claimsByWarranty.set(c.warranty_id, arr);
  }

  const banner = (() => {
    if (sp.saved === "claim_submitted")
      return {
        tone: "ok" as const,
        msg: `Claim submitted. ${org.name} will be in touch — you can follow it under Messages.`,
      };
    const errors: Record<string, string> = {
      invalid_token: "This link is not valid.",
      rate_limited: "Too many requests — please wait a minute and try again.",
      invalid_input: "Please check the form and try again.",
      warranty_not_found: "That warranty could not be found.",
      could_not_submit: "Something went wrong submitting your claim. Please try again.",
    };
    if (sp.error)
      return {
        tone: "err" as const,
        msg: errors[sp.error] ?? "Something went wrong. Please try again.",
      };
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="warranties">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your warranties</h2>
        <p className="mt-1 text-sm text-slate-600">
          Cover {org.name} has given you after completion, and any servicing that
          keeps it valid.
        </p>
        {maintenanceRemindersSending() ? (
          <p className="mt-2 text-xs text-slate-500">
            We&apos;ll email you a reminder before each service is due and before
            your cover ends — but please still check these dates and keep your
            own note of anything you need to act on.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            These dates are shown here for you to check — we don&apos;t send
            warranty or service reminders, so please diarise anything you need to
            act on.
          </p>
        )}
      </section>

      {banner ? (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${banner.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
        >
          {banner.msg}
        </div>
      ) : null}

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
          {warranties.map((w) => {
            const wClaims = claimsByWarranty.get(w.id) ?? [];
            const canClaim = w.status === "active" && !w.awaiting_completion_certificate;
            return (
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

              {/* ── Warranty claims (P3) ─────────────────────────────────── */}
              {wClaims.length > 0 ? (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Your claims
                  </div>
                  <ul className="mt-1.5 space-y-1.5">
                    {wClaims.map((c) => (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate text-slate-700">
                          #{c.ticket_number} · {c.summary}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CLAIM_STAGE_STYLES[c.stage]}`}
                        >
                          {CLAIM_STAGE_LABELS[c.stage]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {canClaim ? (
                <details className="mt-3 border-t border-slate-100 pt-3">
                  <summary className="cursor-pointer text-sm font-medium text-slate-700 hover:text-slate-900">
                    Report an issue with this cover
                  </summary>
                  <form action={submitWarrantyClaim} className="mt-3 space-y-3">
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="warranty_id" value={w.id} />
                    <label className="block text-sm">
                      <span className="font-medium text-slate-700">
                        What&apos;s the issue?
                      </span>
                      <input
                        name="summary"
                        type="text"
                        required
                        minLength={3}
                        maxLength={200}
                        placeholder="e.g. Boiler losing pressure"
                        className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="font-medium text-slate-700">Tell us more</span>
                      <textarea
                        name="details"
                        required
                        minLength={10}
                        maxLength={5000}
                        rows={4}
                        placeholder="What's happening, since when, anything you've tried…"
                        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                      />
                    </label>
                    <button
                      type="submit"
                      className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Submit claim
                    </button>
                  </form>
                </details>
              ) : null}
            </li>
            );
          })}
        </ol>
      )}
    </PortalShell>
  );
}
