import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOrgContext } from "@/server/auth/session";
import {
  getStatement,
  listStatementPayments,
  statementFreshness,
} from "@/server/services/cis-statements";
import {
  CIS_STATEMENT_STATUS_LABELS,
  describeVerificationNumber,
} from "@/lib/cis/statements";
import { cisTaxMonthLabel } from "@/lib/cis/tax-month";
import { formatGbp, round2, toPounds } from "@/lib/money";

import { WithdrawStatementForm } from "../../_forms";
import { issueCisStatement, withdrawCisStatement } from "../../actions";
import { IssueStatementButton } from "../../_forms";

/**
 * One issued payment and deduction statement.
 *
 * Everything shown is the FROZEN row — this page never recomputes a figure from
 * the live ledger, because the whole point of freezing was that re-verifying a
 * subcontractor or editing a bill must not silently rewrite a document already
 * given to them.
 *
 * What IS live is the freshness check: the statement's stored ledger fingerprint
 * is compared against the ledger today, so a payment voided after issue surfaces
 * as "this needs replacing" rather than as a document that quietly stopped being
 * true.
 *
 * ADMIN ONLY via RLS — a non-admin gets no row and therefore a 404.
 */

export const dynamic = "force-dynamic";

export default async function CisStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();

  const statement = await getStatement(ctx.org.id, id);
  if (!statement) notFound();

  const [payments, freshness] = await Promise.all([
    listStatementPayments(ctx.org.id, id),
    statementFreshness(statement),
  ]);

  const gross = round2(toPounds(statement.gross_amount));
  const materials = round2(toPounds(statement.materials_amount));
  const deduction = round2(toPounds(statement.deduction_amount));
  const verification = describeVerificationNumber({
    required: statement.verification_number_required,
    number: statement.verification_number,
  });

  // Proof, not assertion: the header must equal the payments it claims to
  // summarise. The database enforces this at COMMIT; showing it here means an
  // operator can see the reconciliation rather than take it on trust.
  const ledgerGross = payments.reduce((n, p) => round2(n + toPounds(p.cis_gross_payment)), 0);
  const ledgerMaterials = payments.reduce((n, p) => round2(n + toPounds(p.materials_total)), 0);
  const ledgerDeduction = payments.reduce((n, p) => round2(n + toPounds(p.cis_deduction)), 0);
  const reconciles =
    ledgerGross === gross && ledgerMaterials === materials && ledgerDeduction === deduction;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/cis" className="hover:text-slate-900">
          CIS
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{statement.statement_number}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Payment and deduction statement</h1>
          <p className="text-sm text-slate-600">
            {statement.subcontractor_name} · {cisTaxMonthLabel(statement.tax_month_end) ?? statement.tax_month_end}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
            {CIS_STATEMENT_STATUS_LABELS[statement.status]}
          </span>
          <a
            href={`/api/cis/statements/${statement.id}/pdf`}
            className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50"
          >
            Download PDF
          </a>
        </div>
      </header>

      {!freshness.fresh ? (
        <div
          role="alert"
          className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900"
        >
          <p>{freshness.reason}</p>
          <IssueStatementButton
            action={issueCisStatement}
            supplierId={statement.supplier_id}
            taxMonthEnd={statement.tax_month_end}
            label="Issue replacement statement"
          />
        </div>
      ) : null}

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Contractor</p>
          <p className="text-slate-900">{statement.contractor_name}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Employer PAYE reference</p>
          <p className="text-slate-900">{statement.contractor_paye_reference}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Tax month ending</p>
          <p className="text-slate-900">{statement.tax_month_end}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Due to subcontractor by</p>
          <p className="text-slate-900">{statement.statement_due_on}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Subcontractor UTR</p>
          <p className="text-slate-900">{statement.subcontractor_utr_masked ?? "Not held"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Verification number</p>
          <p className={verification.kind === "missing" ? "text-amber-800" : "text-slate-900"}>
            {verification.kind === "not_required" ? "Not required" : verification.text}
          </p>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Figures</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between border-b border-slate-100 pb-2">
            <dt className="text-slate-600">Gross amount paid (excluding VAT)</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatGbp(gross)}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-100 pb-2">
            <dt className="text-slate-600">Less cost of materials</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatGbp(materials)}</dd>
          </div>
          <div className="flex justify-between border-b border-slate-100 pb-2">
            <dt className="text-slate-600">
              Amount liable to deduction
              {statement.rate_is_uniform
                ? ` · ${round2(toPounds(statement.deduction_rate))}%`
                : " · rate varied within the month"}
            </dt>
            <dd className="font-semibold tabular-nums text-slate-900">
              {formatGbp(round2(gross - materials))}
            </dd>
          </div>
          <div className="flex justify-between pt-1">
            <dt className="font-semibold text-slate-900">Amount deducted</dt>
            <dd className="text-lg font-bold tabular-nums text-slate-900">{formatGbp(deduction)}</dd>
          </div>
        </dl>

        {!statement.is_statutory ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            No deduction was made. HMRC does not require a statement where a subcontractor is paid
            gross — this one is a record, not an obligation.
          </p>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">
          Payments covered ({payments.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4">Paid on</th>
                <th className="py-2 pr-4 text-right">Gross (ex-VAT)</th>
                <th className="py-2 pr-4 text-right">Materials</th>
                <th className="py-2 text-right">Deducted</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.payment_id} className="border-b border-slate-100">
                  <td className="py-2 pr-4">{p.paid_on}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(p.cis_gross_payment)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatGbp(p.materials_total)}</td>
                  <td className="py-2 text-right tabular-nums">{formatGbp(p.cis_deduction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={reconciles ? "text-xs text-emerald-700" : "text-xs font-semibold text-red-700"}>
          {reconciles
            ? "These payments reconcile exactly to the totals above."
            : "These payments do not reconcile to the totals above — report this."}
        </p>
      </section>

      {statement.status === "issued" ? (
        <WithdrawStatementForm action={withdrawCisStatement} statementId={statement.id} />
      ) : null}

      {statement.status === "withdrawn" && statement.withdraw_reason ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Withdrawn: {statement.withdraw_reason}
        </div>
      ) : null}

      <p className="text-xs text-slate-600">Content hash {statement.content_hash}</p>
    </div>
  );
}
