import Link from "next/link";

import { requireOrgContext } from "@/server/auth/session";
import {
  getContractorProfile,
  getPreparedReturn,
  liveReturnDataset,
  listStatements,
  preparedReturnIsStale,
  recentTaxMonthEnds,
} from "@/server/services/cis-statements";
import { assessContractorReadiness } from "@/lib/cis/contractor";
import {
  CIS_NO_FILING_NOTICE,
  CIS_RETURN_STATUS_DESCRIPTIONS,
  CIS_RETURN_STATUS_LABELS,
  CIS_STATEMENT_STATUS_LABELS,
  daysUntil,
  describeVerificationNumber,
  type CisStatementStatus,
} from "@/lib/cis/statements";
import { cisStatementDueDate, cisTaxMonthEnd, cisTaxMonthLabel } from "@/lib/cis/tax-month";
import { formatGbp } from "@/lib/money";

import { ContractorProfileForm, IssueStatementButton, MarkExportedButton, PrepareReturnButton } from "./_forms";
import { exportCisReturn, issueCisStatement, prepareCisReturn, saveContractorProfile } from "./actions";

/**
 * CIS monthly centre — payment & deduction statements and the CIS300-shape
 * return dataset for one tax month.
 *
 * ADMIN ONLY. Every M4 table is admin-only under RLS, so a non-admin would see
 * an empty page and every button would fail on submit. They get a plain refusal
 * instead — the same treatment the M1 CIS page gives.
 *
 * ── THE PAGE MAKES ONE PROMISE AND KEEPS IT ─────────────────────────────────
 * CrewFlow does not file. That notice is rendered on the return card, the status
 * descriptions repeat it, and no control on this page is labelled in a way that
 * could be read as submitting anything to HMRC.
 *
 * ── TAX MONTHS, NOT CALENDAR MONTHS ─────────────────────────────────────────
 * Every period here runs 6th → 5th and is labelled in full ("6 July 2026 to
 * 5 August 2026") precisely because a label like "July" invites the reader to
 * assume a calendar month, which files payments in the wrong return.
 */

export const dynamic = "force-dynamic";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const STATEMENT_BADGE: Record<CisStatementStatus, string> = {
  issued: "border-emerald-200 bg-emerald-50 text-emerald-800",
  superseded: "border-slate-200 bg-slate-100 text-slate-600",
  withdrawn: "border-amber-200 bg-amber-50 text-amber-900",
};

function DeadlineNote({ due, today, what }: { due: string; today: string; what: string }) {
  const days = daysUntil(due, today);
  if (days === null) return null;
  const late = days < 0;
  const soon = days >= 0 && days <= 5;
  return (
    <span
      className={
        late
          ? "text-sm font-semibold text-red-700"
          : soon
            ? "text-sm font-semibold text-amber-800"
            : "text-sm text-slate-600"
      }
    >
      {what} {due}
      {late ? ` — ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` : days === 0 ? " — due today" : ` — ${days} day${days === 1 ? "" : "s"} left`}
    </span>
  );
}

export default async function CisPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">CIS</h1>
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Only an owner or admin can work with CIS statements and returns. They contain tax
          identifiers and determine what is reported to HMRC.
        </div>
      </div>
    );
  }

  const today = todayIso();
  const months = recentTaxMonthEnds(today, 13);
  const requested = (await searchParams).month;
  const month =
    requested && months.includes(requested) ? requested : (cisTaxMonthEnd(today) ?? months[0]!);

  const [profile, dataset, prepared, statements] = await Promise.all([
    getContractorProfile(ctx.org.id),
    liveReturnDataset(ctx.org.id, month),
    getPreparedReturn(ctx.org.id, month),
    listStatements(ctx.org.id, { taxMonthEnd: month }),
  ]);

  const readiness = assessContractorReadiness(profile);
  const currentBySupplier = new Map(
    statements.filter((s) => s.status === "issued").map((s) => [s.supplier_id, s]),
  );

  // A prepared return that no longer matches the live ledger is STALE. PROVEN by
  // recomputing the SHA-256 fingerprint of the month's figures in the database
  // and comparing it to the one stored at preparation — never inferred from a
  // timestamp or a row count, either of which can miss an equal-and-opposite
  // change (void one payment, post another for the same amount).
  const preparedStale = prepared ? await preparedReturnIsStale(prepared) : false;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-slate-900">CIS</h1>
        <p className="text-sm text-slate-600">
          Payment and deduction statements for your subcontractors, and the figures for your
          monthly return.
        </p>
      </header>

      {/* ── tax month picker ─────────────────────────────────────────────── */}
      <nav aria-label="Tax month" className="flex flex-wrap gap-2">
        {months.slice(0, 7).map((m) => (
          <Link
            key={m}
            href={`/cis?month=${m}`}
            className={
              m === month
                ? "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
                : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            }
          >
            {cisTaxMonthLabel(m) ?? m}
          </Link>
        ))}
      </nav>

      {!readiness.ready ? (
        <section className="space-y-4">
          <div
            role="alert"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {readiness.reason}
          </div>
          <ContractorProfileForm
            action={saveContractorProfile}
            defaults={{
              legal_name: profile?.legal_name ?? ctx.org.name,
              employer_paye_reference: profile?.employer_paye_reference ?? "",
              accounts_office_reference: profile?.accounts_office_reference ?? "",
              contractor_utr: profile?.contractor_utr ?? "",
            }}
          />
        </section>
      ) : null}

      {/* ── the monthly return dataset ───────────────────────────────────── */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Monthly return figures · {cisTaxMonthLabel(month) ?? month}
            </h2>
            <DeadlineNote due={dataset.dueOn} today={today} what="Due to HMRC by" />
          </div>
          {prepared ? (
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
              {CIS_RETURN_STATUS_LABELS[prepared.status]}
            </span>
          ) : null}
        </div>

        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {CIS_NO_FILING_NOTICE}
        </p>

        {dataset.isNil ? (
          <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            <strong className="font-semibold">Nil return.</strong> You made no CIS payments in this
            tax month. HMRC still expects a return showing your payments were 0 — a nil return is
            an obligation, not an absence of one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4">Subcontractor</th>
                  <th className="py-2 pr-4">UTR</th>
                  <th className="py-2 pr-4">Verification</th>
                  <th className="py-2 pr-4 text-right">Gross (ex-VAT)</th>
                  <th className="py-2 pr-4 text-right">Materials</th>
                  <th className="py-2 text-right">Deducted</th>
                </tr>
              </thead>
              <tbody>
                {dataset.lines.map((line) => {
                  const ver = describeVerificationNumber({
                    required: line.verificationNumberRequired,
                    number: line.verificationNumber,
                  });
                  return (
                    <tr key={line.supplierId} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium text-slate-900">
                        {line.subcontractorName}
                        {!line.rate.uniform ? (
                          <span className="ml-2 text-xs text-amber-700">rate varied</span>
                        ) : (
                          <span className="ml-2 text-xs text-slate-500">{line.rate.rate}%</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">{line.utrMasked ?? "—"}</td>
                      <td className="py-2 pr-4 text-slate-600">
                        {ver.kind === "not_required" ? (
                          <span className="text-slate-500">Not required</span>
                        ) : ver.kind === "present" ? (
                          ver.text
                        ) : (
                          <span className="text-amber-700">Not held</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(line.grossAmount)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(line.materialsAmount)}</td>
                      <td className="py-2 text-right font-semibold tabular-nums">
                        {formatGbp(line.deductionAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold text-slate-900">
                  <td className="py-2 pr-4" colSpan={3}>
                    {dataset.subcontractorCount} subcontractor
                    {dataset.subcontractorCount === 1 ? "" : "s"} · {dataset.paymentCount} payment
                    {dataset.paymentCount === 1 ? "" : "s"}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(dataset.totalGross)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(dataset.totalMaterials)}</td>
                  <td className="py-2 text-right tabular-nums">{formatGbp(dataset.totalDeduction)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <PrepareReturnButton
            action={prepareCisReturn}
            taxMonthEnd={month}
            label={prepared ? "Re-prepare figures" : "Prepare figures"}
          />
          {prepared ? <MarkExportedButton action={exportCisReturn} returnId={prepared.id} /> : null}
        </div>

        {prepared ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <p>
              Prepared {prepared.prepared_at.slice(0, 10)} · {CIS_RETURN_STATUS_DESCRIPTIONS[prepared.status]}
            </p>
            {preparedStale ? (
              <p className="mt-1 font-semibold text-amber-800">
                The ledger has changed since these figures were prepared. Re-prepare before you
                file.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ── statements ───────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Payment and deduction statements</h2>
          {/* 14 days after the tax month end (CISR12160) — from the ONE
              definition, never recomputed inline. */}
          <DeadlineNote
            due={cisStatementDueDate(month) ?? month}
            today={today}
            what="Give to subcontractors by"
          />
        </div>

        {dataset.lines.length === 0 ? (
          <p className="text-sm text-slate-600">
            No subcontractors were paid in this tax month, so no statements are due.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {dataset.lines.map((line) => {
              const existing = currentBySupplier.get(line.supplierId);
              return (
                <li key={line.supplierId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-slate-900">{line.subcontractorName}</p>
                    <p className="text-sm text-slate-600">
                      {formatGbp(line.grossAmount)} gross · {formatGbp(line.deductionAmount)} deducted
                      {line.deductionAmount === 0 ? (
                        <span className="ml-2 text-xs text-slate-500">
                          paid gross — a statement is good practice, not required
                        </span>
                      ) : null}
                    </p>
                    {existing ? (
                      <p className="mt-1 text-xs text-slate-500">
                        <Link href={`/cis/statements/${existing.id}`} className="underline hover:text-slate-900">
                          {existing.statement_number}
                        </Link>{" "}
                        issued {existing.issued_on}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3">
                    {existing ? (
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATEMENT_BADGE[existing.status]}`}
                      >
                        {CIS_STATEMENT_STATUS_LABELS[existing.status]}
                      </span>
                    ) : null}
                    <IssueStatementButton
                      action={issueCisStatement}
                      supplierId={line.supplierId}
                      taxMonthEnd={month}
                      label={existing ? "Reissue" : "Issue statement"}
                      disabled={!readiness.ready}
                      disabledReason={readiness.ready ? null : "Add your contractor details first."}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {statements.length > 0 ? (
          <details className="pt-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              All statements for this tax month ({statements.length})
            </summary>
            <ul className="mt-3 space-y-2">
              {statements.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link href={`/cis/statements/${s.id}`} className="underline hover:text-slate-900">
                    {s.statement_number} · {s.subcontractor_name}
                  </Link>
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATEMENT_BADGE[s.status]}`}>
                    {CIS_STATEMENT_STATUS_LABELS[s.status]}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {readiness.ready ? (
        <section>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              Your CIS contractor details
            </summary>
            <div className="mt-3">
              <ContractorProfileForm
                action={saveContractorProfile}
                defaults={{
                  legal_name: profile?.legal_name ?? ctx.org.name,
                  employer_paye_reference: profile?.employer_paye_reference ?? "",
                  accounts_office_reference: profile?.accounts_office_reference ?? "",
                  contractor_utr: profile?.contractor_utr ?? "",
                }}
              />
            </div>
          </details>
        </section>
      ) : null}
    </div>
  );
}
