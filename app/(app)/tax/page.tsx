import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  computeVatQuarter,
  computePayeMonth,
  computeCorpTaxYear,
  startOfQuarterIso,
  endOfQuarterExclusiveIso,
  startOfTaxYearIso,
} from "@/lib/tax/compute";

/**
 * Tax dashboard — VAT, PAYE/NI, Corporation Tax estimates.
 *
 * Estimates ONLY. Banner at the top makes that clear; every tile carries
 * a confidence flag and a "confirm with your accountant" footnote. Numbers
 * derive from the org's actual invoices + finance rows (RLS-scoped).
 *
 * UK assumptions:
 *   - Calendar quarter VAT (Jan/Apr/Jul/Oct). VAT-staggers are a follow-up.
 *   - Tax year starts 6 April.
 *   - Small profits rate 19% under £50k; main rate 25% over £250k;
 *     HMRC marginal relief (3/200) applied between thresholds.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function nextVatDeadline(quarterStart: Date): Date {
  // Filing/payment due 1 month + 7 days after the quarter ends.
  const qEnd = new Date(
    Date.UTC(quarterStart.getUTCFullYear(), quarterStart.getUTCMonth() + 3, 0),
  );
  return new Date(
    Date.UTC(qEnd.getUTCFullYear(), qEnd.getUTCMonth() + 1, 7),
  );
}

export default async function TaxDashboardPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const quarterStartIso = startOfQuarterIso();
  const yearStartIso = startOfTaxYearIso();

  const monthKey = new Date().toISOString().slice(0, 7);
  const [
    { data: invoicesRaw, error: invoicesError },
    { data: financesRaw, error: financesError },
    { data: payrollRaw, error: payrollError },
  ] =
    await Promise.all([
      // ACTIVE-org pins. Every figure on this page is an HMRC-facing estimate
      // (VAT due, PAYE/NI, Corporation Tax): RLS admits every org the viewer
      // belongs to, so a dual-org owner's tax dashboard SUMMED both companies.
      supabase
        .from("invoices")
        .select("status, vat_total, total, amount, paid_at, created_at")
        .eq("org_id", ctx.org.id)
        .gte("created_at", yearStartIso),
      supabase
        .from("finances")
        .select("vat_total, amount, created_at")
        .eq("org_id", ctx.org.id)
        .gte("created_at", yearStartIso),
      supabase
        .from("payroll_lines")
        // `gross_pay` is required by computePayeMonth — employer NI is derived from
        // it, and employer NI is part of the monthly PAYE bill.
        .select(
          "paye_estimate, ni_estimate, gross_pay, run:payroll_runs ( period_start, status, cycle )",
        )
        .eq("org_id", ctx.org.id)
        .gte("created_at", `${monthKey}-01T00:00:00Z`),
    ]);
  // Loud fail: every figure here is an HMRC-facing estimate — an errored read
  // must never render as £0 VAT/PAYE/CT due.
  if (invoicesError) throw readFailure("tax: invoices", invoicesError);
  if (financesError) throw readFailure("tax: finances", financesError);
  if (payrollError) throw readFailure("tax: payroll lines", payrollError);

  const invoices = (invoicesRaw ?? []).map((i) => ({
    status: i.status as string,
    vat_total: i.vat_total,
    total: i.total,
    amount: i.amount,
    paid_at: i.paid_at as string | null,
    created_at: i.created_at as string,
  }));
  const finances = (financesRaw ?? []).map((f) => ({
    vat_total: f.vat_total,
    amount: f.amount,
    created_at: f.created_at as string,
  }));

  const payrollLines = (payrollRaw ?? []).map((l) => ({
    paye_estimate: l.paye_estimate,
    ni_estimate: l.ni_estimate,
    gross_pay: l.gross_pay,
    run: l.run
      ? {
          period_start: l.run.period_start as string,
          status: l.run.status as string,
          cycle: l.run.cycle as string,
        }
      : null,
  }));

  // Invoices/finances are fetched for the whole tax year, so the quarter's
  // EXCLUSIVE upper bound is what keeps a next-quarter payment out of this tile.
  const vat = computeVatQuarter(
    invoices,
    finances,
    quarterStartIso,
    endOfQuarterExclusiveIso(quarterStartIso),
  );
  const paye = computePayeMonth(payrollLines);
  const corp = computeCorpTaxYear(invoices, finances, yearStartIso);

  const quarterStartDate = new Date(quarterStartIso);
  const vatDeadline = nextVatDeadline(quarterStartDate);
  const yearStartDate = new Date(yearStartIso);
  // CT filing deadline = 12 months after year end; payment = 9 months + 1 day.
  const yearEnd = new Date(
    Date.UTC(yearStartDate.getUTCFullYear() + 1, yearStartDate.getUTCMonth(), yearStartDate.getUTCDate() - 1),
  );
  const ctPayDate = new Date(
    Date.UTC(yearEnd.getUTCFullYear(), yearEnd.getUTCMonth() + 9, yearEnd.getUTCDate() + 1),
  );
  // PAYE/NI for a tax month is due to HMRC by the 22nd of the following
  // month (electronic). The PAYE tile aggregates this calendar month's
  // payroll runs, so the liability falls due on the 22nd of next month.
  const now = new Date();
  const payeDeadline = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 22),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Tax dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          {ctx.org.name} — running estimates of your VAT, PAYE and
          Corporation Tax based on the invoices and finances logged in
          CrewFlow this tax year.
        </p>
      </header>

      <div
        role="alert"
        className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        <strong className="font-semibold">Estimate only.</strong> These are
        ballpark numbers from your CrewFlow data — they aren&apos;t a tax
        return. Confirm everything with your accountant before filing with
        HMRC. Each tile is tagged with its basis:{" "}
        <strong className="font-semibold">VAT output</strong> is cash (money
        actually received), while <strong className="font-semibold">
        Corporation Tax</strong> is accrual (invoiced), so don&apos;t read the
        two as like-for-like.
      </div>

      {/* VAT */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              VAT — this quarter
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Quarter starting {formatDate(quarterStartIso)} · filing due{" "}
              <span className="font-medium text-slate-700">
                {formatDate(vatDeadline.toISOString())}
              </span>
            </p>
          </div>
          <ConfidencePill value={vat.confidence} />
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Output VAT"
            value={GBP.format(vat.output_vat)}
            basis="Paid · cash"
            sub="VAT on invoices marked paid this quarter"
          />
          <Stat
            label="Input VAT"
            value={GBP.format(vat.input_vat)}
            basis="Invoiced · accrual"
            sub="VAT on expenses logged this quarter"
          />
          <Stat
            label="Net payable to HMRC"
            value={GBP.format(vat.net_payable)}
            basis="Estimate"
            sub={vat.net_payable >= 0 ? "you owe" : "HMRC owes you"}
            emphasis
          />
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          Heads up — the two halves use different bases: output VAT counts
          invoices <strong>marked paid</strong> this quarter (cash), while
          input VAT counts expenses <strong>logged</strong> this quarter
          (accrual), since logged costs carry no payment date. The net figure
          is therefore an estimate. If you&apos;re on a VAT stagger or the cash
          accounting scheme this needs a small adjustment — talk to your
          accountant.
        </p>
      </section>

      {/* Corp Tax */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Corporation Tax — this tax year
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Year starting {formatDate(yearStartIso)} · payment due ~{" "}
              <span className="font-medium text-slate-700">
                {formatDate(ctPayDate.toISOString())}
              </span>
            </p>
          </div>
          <ConfidencePill value={corp.confidence} />
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Estimated profit"
            value={GBP.format(corp.estimated_profit)}
            basis="Invoiced · accrual"
            sub="invoiced revenue (net) − finance costs (net)"
          />
          <Stat
            label="Rate applied"
            value={`${corp.rate_applied}%`}
            sub={
              corp.estimated_profit <= 50_000
                ? "small profits rate"
                : corp.estimated_profit >= 250_000
                  ? "main rate"
                  : "marginal — approximated"
            }
          />
          <Stat
            label="Estimated tax"
            value={GBP.format(corp.estimated_tax)}
            basis="Estimate"
            sub="set this aside, don't spend it"
            emphasis
          />
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          Profit is approximated as net invoice revenue minus net finance
          costs since the tax year started. This skips depreciation,
          director&apos;s salary, capital allowances and a dozen other
          adjustments your accountant handles at year end.
        </p>
      </section>

      {/* PAYE / NI — computed from this month's payroll runs */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              PAYE / NI — this month
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Estimate of monthly PAYE income tax + employee/employer NI on
              staff pay.
            </p>
          </div>
          <ConfidencePill value={paye.confidence} />
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Estimate"
            value={GBP.format(paye.estimate)}
            basis="Estimate"
            sub={
              paye.confidence === "computed"
                ? "from this month's payroll runs"
                : "awaiting your first payroll run"
            }
          />
          <div className="sm:col-span-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-600">
            {paye.note}
          </div>
        </dl>
      </section>

      {/* Upcoming liabilities */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Upcoming liabilities
        </h2>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          <Liability
            label="VAT payment"
            amount={vat.net_payable > 0 ? GBP.format(vat.net_payable) : "—"}
            due={formatDate(vatDeadline.toISOString())}
            note="Pay HMRC within ~1 month + 7 days of quarter end"
          />
          <Liability
            label="Corporation Tax"
            amount={GBP.format(corp.estimated_tax)}
            due={formatDate(ctPayDate.toISOString())}
            note="9 months + 1 day after company year end"
          />
          <Liability
            label="PAYE / NI"
            amount={
              paye.confidence === "computed" ? GBP.format(paye.estimate) : "—"
            }
            due={
              paye.confidence === "computed"
                ? formatDate(payeDeadline.toISOString())
                : "monthly (22nd)"
            }
            note={
              paye.confidence === "computed"
                ? "PAYE income tax + employee NI on this month's payroll — pay HMRC by the 22nd of next month"
                : "Available once you run payroll for this month"
            }
          />
        </ul>
      </section>

      {/* Footer actions */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <div className="text-slate-700">
          Need an audit trail? Export the underlying transactions:
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/invoices?status=paid"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Paid invoices
          </Link>
          <Link
            href="/finances"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Finances
          </Link>
          <a
            href={`/api/tax/quarterly-pdf?quarterStart=${quarterStartIso}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            Download quarterly PDF
          </a>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  basis,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  /**
   * M3 — accounting-basis tag (e.g. "Paid · cash", "Invoiced · accrual",
   * "Estimate"). The tax tiles deliberately mix bases (VAT output is cash,
   * Corporation Tax is accrual), so each figure states its basis to avoid
   * the QA finding where the two looked comparable but weren't.
   */
  basis?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="flex flex-wrap items-center gap-1.5 text-xs uppercase tracking-wide text-slate-500">
        {label}
        {basis ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-600">
            {basis}
          </span>
        ) : null}
      </dt>
      <dd
        className={
          emphasis
            ? "mt-0.5 text-2xl font-bold text-slate-900"
            : "mt-0.5 text-lg font-semibold text-slate-900"
        }
      >
        {value}
      </dd>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

function ConfidencePill({ value }: { value: "computed" | "placeholder" }) {
  return value === "computed" ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      computed from your data
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      placeholder
    </span>
  );
}

function Liability({
  label,
  amount,
  due,
  note,
}: {
  label: string;
  amount: string;
  due: string;
  note: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{label}</div>
        <div className="text-xs text-slate-500">{note}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-slate-900">{amount}</div>
        <div className="text-xs text-slate-500">due {due}</div>
      </div>
    </li>
  );
}
