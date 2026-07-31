import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { loadJobForOrg } from "@/lib/jobs/load";
import { StateForm } from "@/components/forms/StateForm";
import { WarrantyForm } from "./_form";
import { publishWarranty, voidWarranty, withdrawWarrantyFromPortal } from "./actions";
import {
  computeWarrantyClock,
  NO_CERTIFICATE_NOTE,
  WARRANTY_KIND_LABELS,
  WARRANTY_STATUS_LABELS,
  WARRANTY_STATUS_STYLES,
} from "@/lib/warranties/schedule";

/**
 * Job warranties + servicing (Phase 7, migration 20261079).
 *
 * WHAT THIS MODULE DOES NOT DO: it does not send anything. Every date below is
 * DERIVED at render time — there is no reminder table, no scheduled job and no
 * email. Transactional email is live in production, so putting unrequested
 * warranty mail in front of real customers is a product decision this module
 * deliberately does not make. The screen says so, in place, so nobody assumes a
 * reminder went out.
 *
 * THE CLOCK. A warranty runs from the completion date FROZEN on this job's
 * ISSUED completion certificate (20261014) — the same date the retention release
 * schedule keys off, and the only completion date in the system that cannot be
 * silently retyped. `jobs.practical_completion_date` is deliberately NOT used:
 * it is an editable working field with no freeze and no audit, so a
 * customer-facing expiry derived from it could move without a trace. When no
 * certificate has been issued this page says the warranty has no start date
 * rather than inventing one.
 *
 * Active-org pinned: the job load and every warranty read carry ctx.org.id, so a
 * job in another org the viewer also belongs to is indistinguishable from one
 * that does not exist.
 *
 * `force-dynamic` + NO `revalidatePath` (the /jobs/[id]/billing precedent). The
 * writes here return FormState and navigate with a full document load, so the
 * post-success render is always fresh; adding revalidatePath alongside
 * useActionState on a force-dynamic [id] route is the known hang pattern.
 */

export const dynamic = "force-dynamic";

const SAVED_COPY: Record<string, string> = {
  created: "Warranty added.",
  published: "Published to the customer portal.",
  withdrawn: "Withdrawn from the customer portal.",
  voided: "Warranty withdrawn.",
};

type WarrantyRow = {
  id: string;
  title: string;
  kind: string;
  cover: string;
  exclusions: string | null;
  provider: string | null;
  reference: string | null;
  period_months: number;
  service_interval_months: number | null;
  service_notes: string | null;
  status: string;
  void_reason: string | null;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
};

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type WarrantyChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        order: (k: string, o: { ascending: boolean }) => PromiseLike<Res<WarrantyRow[]>>;
      };
    };
  };
};
type CertChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<Res<{ completion_date: string; certificate_number: string }>>;
        };
      };
    };
  };
};

export default async function JobWarrantiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;

  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();

  const job = await loadJobForOrg<{ id: string; status: string }>(
    supabase,
    id,
    ctx.org.id,
    "id, status",
  );
  if (!job) notFound();

  // The one authoritative clock. Active-org pinned, and pinned to the ISSUED
  // certificate — a draft has not frozen its completion date yet.
  const { data: cert, error: certError } = await (
    supabase.from("completion_certificates" as never) as unknown as CertChain
  )
    .select("completion_date, certificate_number")
    .eq("job_id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "issued")
    .maybeSingle();
  // Loud: a failed read here would silently claim there is no certificate, and
  // every expiry on the page would read "not started yet".
  if (certError) throw readFailure("job warranties: certificate", certError);
  const completionDate = cert?.completion_date ?? null;

  const { data: rows, error: warrantyError } = await (
    supabase.from("job_warranties" as never) as unknown as WarrantyChain
  )
    .select(
      "id, title, kind, cover, exclusions, provider, reference, period_months, " +
        "service_interval_months, service_notes, status, void_reason, portal_published_at, portal_withdrawn_at",
    )
    .eq("job_id", id)
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false });
  if (warrantyError) throw readFailure("job warranties: warranties", warrantyError);
  const warranties = rows ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href={`/jobs/${id}`} className="hover:text-slate-900">
          Job
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Warranties</span>
      </div>

      {saved ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {SAVED_COPY[saved] ?? "Saved."}
        </div>
      ) : null}

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Warranties &amp; servicing</h1>
        <p className="mt-1 text-sm text-slate-600">
          Cover you&apos;ve given the customer after completion, and the servicing
          that keeps it valid.
        </p>
        <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <strong>Reminders are shown, never sent.</strong> CrewFlow does not
          email or text anyone about a warranty or a service — these dates are
          calculated for you and the customer to read on screen. Diarise anything
          you need to act on.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Warranty start date</h2>
        {completionDate ? (
          <p className="mt-1 text-sm text-slate-600">
            Every warranty on this job runs from{" "}
            <strong className="text-slate-900">{completionDate}</strong> — the
            completion date frozen on certificate {cert?.certificate_number}.
          </p>
        ) : (
          <p className="mt-1 text-sm text-amber-800">
            No completion certificate has been issued for this job, so a warranty
            here has <strong>no honest start date</strong> and none is invented.
            You can record the terms now; the dates appear the moment the
            certificate is issued.{" "}
            <Link href={`/jobs/${id}/certificate`} className="font-medium underline">
              Issue the certificate
            </Link>
            .
          </p>
        )}
      </section>

      {warranties.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          No warranties recorded for this job yet.
        </section>
      ) : (
        <ol className="space-y-3">
          {warranties.map((w) => {
            const clock = computeWarrantyClock({
              periodMonths: w.period_months,
              serviceIntervalMonths: w.service_interval_months,
              certificateCompletionDate: completionDate,
              voided: w.status === "void",
            });
            const published = Boolean(w.portal_published_at && !w.portal_withdrawn_at);
            return (
              <li
                key={w.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-slate-900">{w.title}</h3>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {WARRANTY_KIND_LABELS[w.kind] ?? "Warranty"} · {w.period_months}{" "}
                      {w.period_months === 1 ? "month" : "months"}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${WARRANTY_STATUS_STYLES[clock.status]}`}
                  >
                    {WARRANTY_STATUS_LABELS[clock.status]}
                  </span>
                </div>

                {clock.start ? (
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-slate-500">Starts</dt>
                      <dd className="text-slate-900">{clock.start}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Expires</dt>
                      <dd className="font-medium text-slate-900">{clock.expiry}</dd>
                    </div>
                    {clock.daysRemaining !== null ? (
                      <div>
                        <dt className="text-xs text-slate-500">Days left</dt>
                        <dd className="text-slate-700">{clock.daysRemaining}</dd>
                      </div>
                    ) : null}
                    {clock.nextService ? (
                      <div>
                        <dt className="text-xs text-slate-500">Next service</dt>
                        <dd className="text-slate-700">{clock.nextService.due}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : w.status === "void" ? null : (
                  <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {NO_CERTIFICATE_NOTE}
                  </p>
                )}

                <p className="mt-3 whitespace-pre-wrap border-t border-slate-100 pt-3 text-sm text-slate-600">
                  {w.cover}
                </p>
                {w.status === "void" && w.void_reason ? (
                  <p className="mt-2 text-xs text-red-700">
                    Withdrawn — {w.void_reason}
                  </p>
                ) : null}

                {w.status === "active" ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {isAdmin ? (
                      published ? (
                        <StateForm action={withdrawWarrantyFromPortal.bind(null, id, w.id)}>
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            Withdraw from portal
                          </button>
                        </StateForm>
                      ) : (
                        <StateForm action={publishWarranty.bind(null, id, w.id)}>
                          <button
                            type="submit"
                            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            Publish to customer portal
                          </button>
                        </StateForm>
                      )
                    ) : null}
                    <span className="text-xs text-slate-500">
                      {published
                        ? "Visible to the customer in their portal."
                        : "Not yet shared with the customer."}
                    </span>
                    {isAdmin ? (
                      <details className="w-full text-xs text-slate-500">
                        <summary className="cursor-pointer hover:text-slate-900">
                          Withdraw this warranty
                        </summary>
                        <StateForm
                          action={voidWarranty.bind(null, id, w.id)}
                          className="mt-2 space-y-2"
                          confirm="Withdraw this warranty? Its terms stay on record and it disappears from the customer's portal."
                        >
                          <input
                            name="void_reason"
                            required
                            maxLength={1000}
                            placeholder="Why is this being withdrawn?"
                            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs"
                          />
                          <button
                            type="submit"
                            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            Withdraw warranty
                          </button>
                        </StateForm>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-slate-900">Add a warranty</h2>
          <WarrantyForm jobId={id} />
        </section>
      ) : null}
    </div>
  );
}
