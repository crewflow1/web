import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { uploadPaymentProof } from "../../_upload-action";
import {
  invoiceBusinessToday,
  invoiceDisplayStatus,
} from "@/lib/invoices/overdue";
import { computePortalPayments } from "@/lib/customers/portal-payments";
import { loadPortalSchedule } from "../_schedule";
import type { PortalScheduleStatus } from "@/lib/customers/portal-schedule";

const UPLOAD_ERRORS: Record<string, string> = {
  no_file: "Choose a file to upload first.",
  file_too_large: "File is over 10 MB — please compress and try again.",
  bad_file_type:
    "Only PDF / JPG / PNG / HEIC / WebP files are accepted as payment proof.",
  invoice_not_yours: "This invoice isn't on your portal.",
  upload_failed: "Couldn't save the file. Try again, or email us if it keeps failing.",
  record_failed: "Saved the file but couldn't record it — please email us.",
  invalid_token: "Your portal link looks expired. Ask us for a fresh one.",
  missing_fields: "Choose a file before submitting.",
};

/**
 * Customer-side invoices list.
 *
 * Read-only — no pay button yet (Slice 4C Payments). Customers see:
 * invoice number, status, amount, due date. Invoices for this
 * customer = invoices whose quote_id is one of the customer's quotes.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  awaiting_payment: "bg-amber-100 text-amber-800",
  partially_paid: "bg-indigo-100 text-indigo-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  sent: "sent",
  awaiting_payment: "awaiting payment",
  partially_paid: "partially paid",
  paid: "paid",
  overdue: "overdue",
};

export default async function PortalInvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const banner = (() => {
    if (sp.saved === "uploaded")
      return {
        tone: "ok" as const,
        msg: "Proof uploaded — it's now listed on the invoice below. We'll review and update the invoice once it's matched.",
      };
    if (sp.error)
      return {
        tone: "err" as const,
        msg: UPLOAD_ERRORS[sp.error] ?? sp.error,
      };
    return null;
  })();

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;
  // Derived overdue — the customer sees the same definition the org's dashboard
  // counts. Before this, an invoice 60 days late still read "sent" here.
  const todayIso = invoiceBusinessToday();

  const admin = createAdminClient();

  // Scope invoices by their OWN customer anchor (Issue #349 Phase 1), not by
  // walking quote -> customer. This is authoritative and survives quote loss:
  // an invoice whose quote was deleted keeps its customer_id, so it still
  // appears here instead of vanishing. org_id + customer_id keeps it strictly
  // this customer's, on the RLS-bypassing admin client.
  const { data: invoicesData } = await admin
    .from("invoices")
    .select(
      "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at, created_at",
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(200);
  const invoices: Array<{
    id: string;
    number: string;
    status: string;
    amount: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    due_date: string | null;
    sent_at: string | null;
    paid_at: string | null;
    created_at: string;
  }> = invoicesData ?? [];

  // Paid-so-far per invoice for the partial-payment display.
  const paidByInvoice = new Map<string, number>();
  if (invoices.length > 0) {
    const ids = invoices.map((i) => i.id);
    const { data: payments } = await admin
      .from("invoice_payments")
      .select("invoice_id, amount")
      .in("invoice_id", ids);
    for (const p of payments ?? []) {
      const prev = paidByInvoice.get(p.invoice_id) ?? 0;
      paidByInvoice.set(p.invoice_id, prev + Number(p.amount ?? 0));
    }
  }

  // Payment proofs this customer has already submitted, keyed by invoice.
  // The upload action (`_upload-action.ts`) writes these into `portal_uploads`;
  // reading them back gives the customer a persistent "received" record instead
  // of the one-shot post-upload banner, so they aren't left re-sending the same
  // proof wondering whether it landed. Scoped to THIS org + customer + these
  // invoices; `kind` narrows to payment proofs (the only kind this page emits).
  // `portal_uploads` isn't in the generated types, so we cast exactly like the
  // write side and the messages page do — the DB stays the one authoritative
  // owner of the record; this page only reads it back.
  type ProofRow = {
    target_id: string;
    filename: string;
    uploaded_at: string;
    notes: string | null;
  };
  type ProofQuery = {
    eq: (k: string, v: unknown) => ProofQuery;
    in: (k: string, v: unknown[]) => ProofQuery;
    order: (
      k: string,
      opts: { ascending: boolean },
    ) => Promise<{
      data: ProofRow[] | null;
      error: { message: string } | null;
    }>;
  };
  const proofsByInvoice = new Map<string, ProofRow[]>();
  if (invoices.length > 0) {
    const ids = invoices.map((i) => i.id);
    const { data: proofs } = await (
      admin.from("portal_uploads" as never) as unknown as {
        select: (cols: string) => ProofQuery;
      }
    )
      .select("target_id, filename, uploaded_at, notes")
      .eq("org_id", customer.org_id)
      .eq("customer_id", customer.id)
      .eq("target_table", "invoices")
      .eq("kind", "payment_proof")
      .in("target_id", ids)
      .order("uploaded_at", { ascending: false });
    for (const pf of proofs ?? []) {
      const list = proofsByInvoice.get(pf.target_id) ?? [];
      list.push(pf);
      proofsByInvoice.set(pf.target_id, list);
    }
  }

  // H2-CASH M2 — customer-safe payments summary (their own invoices only).
  const paySummary = computePortalPayments(
    invoices.map((i) => ({ status: i.status, total: i.total, due_date: i.due_date, paid: paidByInvoice.get(i.id) ?? 0 })),
  );

  // H2-CASH M3 — the agreed payment schedule (deposit → stages → retention),
  // scoped to THIS customer's own jobs. Customer-safe by construction.
  const schedule = await loadPortalSchedule(customer.org_id, customer.id);
  const SCHED_STYLES: Record<PortalScheduleStatus, string> = {
    paid: "bg-green-100 text-green-700",
    part_paid: "bg-indigo-100 text-indigo-800",
    due: "bg-amber-100 text-amber-800",
    overdue: "bg-red-100 text-red-700",
    upcoming: "bg-slate-100 text-slate-600",
  };
  const SCHED_LABELS: Record<PortalScheduleStatus, string> = {
    paid: "paid",
    part_paid: "part paid",
    due: "due now",
    overdue: "overdue",
    upcoming: "upcoming",
  };

  return (
    <PortalShell customer={customer} org={org} token={token} active="invoices">
      {paySummary.paidToDate > 0 || paySummary.dueNow > 0 ? (
        <section aria-label="Your payments" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Paid to date</p>
            <p className="mt-1 text-xl font-bold text-green-700">{GBP.format(paySummary.paidToDate)}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">Due now</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{GBP.format(paySummary.dueNow)}</p>
          </div>
          {paySummary.overdue > 0 ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-xs uppercase tracking-wide text-red-600">Overdue</p>
              <p className="mt-1 text-xl font-bold text-red-700">{GBP.format(paySummary.overdue)}</p>
            </div>
          ) : null}
        </section>
      ) : null}
      {schedule.hasSchedule ? (
        <section aria-labelledby="schedule-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4">
            <h2 id="schedule-heading" className="text-sm font-semibold text-slate-900">Payment schedule</h2>
            <p className="mt-0.5 text-xs text-slate-500">The agreed stages for your project with {org.name}.</p>
          </div>
          <ol className="divide-y divide-slate-100">
            {schedule.stages.map((st, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{st.name}</p>
                  <p className="text-xs text-slate-500">{st.dueDate ? `Planned ${st.dueDate}` : "Date to be confirmed"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SCHED_STYLES[st.status]}`}>{SCHED_LABELS[st.status]}</span>
                  <span className="w-24 text-right text-sm font-semibold text-slate-900">{GBP.format(st.gross)}</span>
                </div>
              </li>
            ))}
          </ol>
          {schedule.retention ? (
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">Retention held</p>
                <p className="text-xs text-slate-500">
                  {schedule.retention.releaseDate ? `Due for release around ${schedule.retention.releaseDate}` : "Released after the defects period"}
                </p>
              </div>
              <span className="w-24 shrink-0 text-right text-sm font-semibold text-slate-900">{GBP.format(schedule.retention.held)}</span>
            </div>
          ) : null}
        </section>
      ) : null}
      {banner ? (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${banner.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
        >
          {banner.msg}
        </div>
      ) : null}
      {invoices.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No invoices yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Once you accept a quote from {org.name}, an invoice will appear
            here.
          </p>
        </section>
      ) : (
        <ol className="space-y-3">
          {invoices.map((inv) => {
            const total = Number(inv.total ?? 0);
            const paid = paidByInvoice.get(inv.id) ?? 0;
            const outstanding = Math.max(0, total - paid);
            const isFullyPaid = inv.status === "paid" || outstanding === 0;
            const submittedProofs = proofsByInvoice.get(inv.id) ?? [];
            return (
              <li
                key={inv.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-slate-900">
                      {inv.number}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {inv.sent_at ? `Sent ${inv.sent_at.slice(0, 10)}` : "Draft"}
                      {inv.due_date ? ` · Due ${inv.due_date}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[invoiceDisplayStatus(inv, todayIso)] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {STATUS_LABELS[invoiceDisplayStatus(inv, todayIso)] ??
                        invoiceDisplayStatus(inv, todayIso)}
                    </span>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      {GBP.format(total)}
                    </div>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-xs text-slate-600">
                  <div>
                    <dt className="text-slate-500">Paid so far</dt>
                    <dd className="font-medium text-green-700">
                      {GBP.format(paid)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Outstanding</dt>
                    <dd
                      className={
                        outstanding === 0
                          ? "text-slate-500"
                          : "font-medium text-slate-900"
                      }
                    >
                      {GBP.format(outstanding)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Paid at</dt>
                    <dd className="text-slate-900">
                      {inv.paid_at ? inv.paid_at.slice(0, 10) : "—"}
                    </dd>
                  </div>
                </dl>
                {isFullyPaid ? (
                  <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                    Paid in full — thank you.
                  </p>
                ) : inv.status === "partially_paid" ? (
                  <p className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                    {org.name} has recorded {GBP.format(paid)} so far against
                    this invoice. {GBP.format(outstanding)} remains
                    outstanding. Bank details + payment reference are on the
                    invoice PDF below.
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {org.name} accepts payment by bank transfer — bank
                    details + payment reference are on the invoice PDF
                    below. Payments are matched manually, so allow 1–2
                    working days for the status to update.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={`/customer-portal/${token}/invoices/${inv.id}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    <span aria-hidden>↓</span> Download invoice PDF
                  </a>
                </div>

                {/* Proofs this customer has already submitted — the read-back
                    side of the upload below. Persists across visits so the
                    customer can see their proof is on file. */}
                {submittedProofs.length > 0 ? (
                  <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2">
                    <p className="text-[11px] font-semibold text-slate-700">
                      Payment proof{submittedProofs.length > 1 ? "s" : ""}{" "}
                      received
                    </p>
                    <ul className="mt-1 space-y-1">
                      {submittedProofs.map((pf, i) => (
                        <li
                          key={i}
                          className="flex items-baseline justify-between gap-2 text-[11px] text-slate-600"
                        >
                          <span className="min-w-0 truncate">
                            <span aria-hidden className="text-green-600">
                              ✓{" "}
                            </span>
                            {pf.filename}
                            {pf.notes ? (
                              <span className="text-slate-500"> — {pf.notes}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-slate-500">
                            {pf.uploaded_at.slice(0, 10)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-[10px] text-slate-500">
                      {org.name} will confirm here once it&apos;s matched to your
                      payment.
                    </p>
                  </div>
                ) : null}

                {/* Phase 3 — payment proof upload. Hidden on fully-paid
                    invoices since there's nothing to prove. */}
                {!isFullyPaid ? (
                  <details
                    id={`inv-${inv.id}`}
                    className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3"
                  >
                    <summary className="cursor-pointer text-xs font-medium text-slate-700">
                      Upload payment proof
                    </summary>
                    <form
                      action={uploadPaymentProof}
                      encType="multipart/form-data"
                      className="mt-3 space-y-2"
                    >
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="invoice_id" value={inv.id} />
                      <input
                        type="file"
                        name="file"
                        accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
                        required
                        className="block w-full text-xs text-slate-700 file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-2 file:py-1 file:text-[11px] file:font-semibold file:text-white"
                      />
                      <input
                        type="text"
                        name="notes"
                        placeholder="Optional note (e.g. reference number)"
                        maxLength={500}
                        className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        Send proof
                      </button>
                      <p className="text-[10px] text-slate-500">
                        Accepted: PDF / JPG / PNG / HEIC / WebP, max 10 MB.
                      </p>
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
