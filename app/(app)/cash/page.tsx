import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { buildOrgCash } from "@/server/services/org-cash";
import {
  buildOrgCashOut,
  cashOutVisibleToRole,
  computeCashPosition,
  EMPTY_CASH_OUT_VIEW,
} from "@/server/services/org-cash-out";
import { formatGbp } from "@/lib/money";
import {
  CASH_OUT_CERTAINTY_LABEL,
  type CashOutComponent,
  type CashOutQueueItem,
} from "@/lib/commercial/cash-out";
import type { CashQueueItem } from "@/lib/commercial/org-cash";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 truncate text-xl font-bold tabular-nums sm:text-2xl ${accent ?? "text-slate-900"}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function QueueList({ title, items, empty, showDays }: { title: string; items: CashQueueItem[]; empty: string; showDays?: boolean }) {
  // Slugify: a space in an id breaks aria-labelledby (space is the IDREF separator).
  const hid = `q-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={hid} className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <h2 id={hid} className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900">{title}</h2>
      {items.length === 0 ? (
        <p className="p-3 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.slice(0, 8).map((it) => (
            <li key={it.id}>
              <Link href={it.href} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{it.number ?? "Invoice"}{it.jobLabel ? ` · ${it.jobLabel}` : ""}</p>
                  <p className="text-xs text-slate-500">
                    {showDays && it.daysOverdue != null
                      ? `${it.daysOverdue} ${it.daysOverdue === 1 ? "day" : "days"} overdue`
                      : it.dueDate ? `due ${it.dueDate}` : "no due date"}
                    {it.remaining < it.total ? ` · ${formatGbp(it.total - it.remaining)} paid` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-slate-900">{formatGbp(it.remaining)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One row of the cash outlook. `certainty` is plain English, never a fake %:
 * invoiced money is a ledger fact; planned billing is a plan; unscheduled is a gap.
 */
function OutlookRow({ label, amount, certainty, accent }: { label: string; amount: string; certainty: string; accent?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{label}</p>
        <p className="text-xs text-slate-500">{certainty}</p>
      </div>
      <span className={`shrink-0 text-lg font-bold tabular-nums ${accent ?? "text-slate-900"}`}>{amount}</span>
    </div>
  );
}

/**
 * One money-OUT row. Every row states its own certainty in plain English and
 * flags an ESTIMATE as an estimate — an estimate must never be presented as a
 * liability (the same doctrine as `OutlookRow` on the money-in side). Each row
 * links through to the records the figure came from.
 */
function OutflowRow({ row }: { row: CashOutComponent }) {
  // Muted for the two rows OUTSIDE the position: they are real money, but they
  // are not part of "what you owe now" and must not read with the same weight.
  const tone = row.inPosition ? "text-slate-900" : "text-slate-600";
  return (
    <Link
      href={row.href}
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50"
    >
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900">
          <span className="min-w-0 break-words">{row.label}</span>
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
            {CASH_OUT_CERTAINTY_LABEL[row.certainty]}
          </span>
          {row.isEstimate ? (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
              Estimate
            </span>
          ) : null}
          {row.inPosition ? null : (
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-600">
              not in the position
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {row.count != null && row.count > 0 ? `${row.count} ${row.count === 1 ? "record" : "records"} · ` : ""}
          {row.dueOn ? `pay by ${row.dueOn} · ` : ""}
          {row.basis}
        </p>
      </div>
      <span className={`shrink-0 text-lg font-bold tabular-nums ${tone}`}>{formatGbp(row.amount)}</span>
    </Link>
  );
}

/** One open supplier bill in the payables queue. */
function BillRow({ item }: { item: CashOutQueueItem }) {
  return (
    <li>
      <Link href={item.href} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">
            {item.supplierName ?? "Supplier"}
            {item.reference ? ` · ${item.reference}` : ""}
          </p>
          <p className="text-xs text-slate-500">
            {item.billDate ? `bill dated ${item.billDate}` : "no bill date"}
            {item.status === "part_paid" ? ` · ${formatGbp(item.gross - item.outstanding)} paid` : ""}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold text-slate-900">{formatGbp(item.outstanding)}</span>
      </Link>
    </li>
  );
}

export default async function CashPage() {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role === "staff") {
    const { redirect } = await import("next/navigation");
    redirect("/me");
  }
  // Money-out reads the admin-only ledgers (supplier payments, CIS snapshots,
  // payroll). Today the role domain is owner|admin|staff and staff are already
  // redirected above, so this is always true — it is here so that ADDING a role
  // cannot silently produce an OVERSTATED payables figure: without admin rights
  // the settlement ledger comes back empty and every bill reads as fully unpaid,
  // which is wrong in the dangerous direction. Withheld beats understated.
  const showOutflows = cashOutVisibleToRole(ctx.membership.role);
  const [
    { summary: s, forecast: f, queues, recentlyPaid, readyStages, unscheduledJobs, loadError },
    out,
  ] = await Promise.all([
    buildOrgCash(ctx.org.id),
    showOutflows
      ? buildOrgCashOut(ctx.org.id)
      : Promise.resolve({ ...EMPTY_CASH_OUT_VIEW, loadError: false }),
  ]);

  // THE position: what you can collect now, minus what you owe now. Money-in
  // comes from computeOrgCashSummary; money-out from computeOrgCashOut. Nothing
  // is recomputed here.
  const position = computeCashPosition({
    collectableNow: s.collectableNow,
    outflowDueNow: out.summary.outflowDueNow,
    estimatedOutflow: out.summary.outflowEstimated,
  });

  // Group ready-to-invoice stages by job for a compact drill-down list.
  const readyByJob = new Map<string, { jobLabel: string | null; total: number; count: number }>();
  for (const st of readyStages) {
    const g = readyByJob.get(st.jobId) ?? { jobLabel: st.jobLabel, total: 0, count: 0 };
    g.total = Math.round((g.total + st.amount) * 100) / 100;
    g.count += 1;
    readyByJob.set(st.jobId, g);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Cash position</h1>
        <p className="mt-1 text-sm text-slate-600">
          {showOutflows
            ? "What you can collect, what you owe, and the difference."
            : "What you’re owed, what’s late, what’s coming, and what’s ready to invoice."}
        </p>
      </header>

      {loadError || out.loadError ? (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          We couldn&rsquo;t load your cash position just now — the figures below may be incomplete. Please refresh; if it keeps happening, contact support rather than trusting a &ldquo;nothing owed&rdquo; reading.
        </div>
      ) : null}

      {showOutflows ? (
        <section
          aria-labelledby="position-heading"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 id="position-heading" className="text-sm font-semibold text-slate-900">
            Net position
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Collectable now</dt>
              <dd className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">
                {formatGbp(position.collectableNow)}
              </dd>
              <p className="mt-0.5 text-xs text-slate-500">invoiced, net of retention still withheld</p>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Owed out now</dt>
              <dd className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">
                &minus;{formatGbp(position.outflowDueNow)}
              </dd>
              <p className="mt-0.5 text-xs text-slate-500">
                bills, CIS, VAT and draft payroll — see the breakdown below
              </p>
            </div>
            <div className="min-w-0 border-t border-slate-100 pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Net position</dt>
              <dd
                className={`mt-0.5 text-2xl font-bold tabular-nums ${
                  position.net < 0 ? "text-red-700" : "text-green-700"
                }`}
              >
                {formatGbp(position.net)}
              </dd>
              <p className="mt-0.5 text-xs text-slate-500">
                {position.net < 0
                  ? "you owe more than you can collect right now"
                  : "what you could collect beyond what you owe"}
              </p>
            </div>
          </dl>
          <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
            {position.hasEstimate ? (
              <>
                <strong className="font-semibold text-amber-800">
                  {formatGbp(position.estimatedOutflow)} of the outflow is an estimate
                </strong>{" "}
                (VAT and draft payroll), so treat the net figure as an indication, not a bank balance. This
                is not your cash at bank — CrewFlow doesn&rsquo;t see your bank account. It excludes rent,
                finance, PAYE/NI and anything else you haven&rsquo;t recorded here.
              </>
            ) : (
              <>
                This is not your cash at bank — CrewFlow doesn&rsquo;t see your bank account. It excludes rent,
                finance, PAYE/NI and anything else you haven&rsquo;t recorded here.
              </>
            )}
          </p>
        </section>
      ) : null}

      <section aria-label="Money in" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Collectable now" value={formatGbp(s.collectableNow)} accent="text-slate-900" hint={s.retentionWithheldFromCollectable > 0 ? `${formatGbp(s.owedNow)} owed − ${formatGbp(s.retentionWithheldFromCollectable)} retention still withheld` : `${formatGbp(s.owedNow)} owed`} />
        <Stat label="Overdue" value={formatGbp(s.overdue)} accent={s.overdue > 0 ? "text-red-700" : undefined} hint={`${s.overdueCount} ${s.overdueCount === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Due this week" value={formatGbp(s.dueThisWeek)} />
        <Stat label="Expected this month" value={formatGbp(s.dueThisMonth)} hint="invoiced & due (not a forecast)" />
        <Stat label="Retention held" value={formatGbp(s.retentionHeld)} hint={s.retentionDueNow > 0 ? `${formatGbp(s.retentionDueNow)} due for release` : "not yet due"} />
        <Stat label="Ready to invoice" value={formatGbp(s.readyToInvoice)} hint={`${readyStages.length} planned ${readyStages.length === 1 ? "stage" : "stages"}`} />
      </section>

      <section aria-labelledby="outlook-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-4">
          <h2 id="outlook-heading" className="text-sm font-semibold text-slate-900">Money in — cash outlook</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Sorted by certainty — invoiced money is committed; planned billing is a plan, not guaranteed cash.
          </p>
        </div>
        <OutlookRow
          label="Overdue"
          amount={formatGbp(f.overdue)}
          certainty="Already invoiced, past its due date"
          accent={f.overdue > 0 ? "text-red-700" : "text-slate-900"}
        />
        <OutlookRow
          label="Due — next 7 days"
          amount={formatGbp(f.dueNext7)}
          certainty="Invoices issued, due within a week"
        />
        <OutlookRow
          label="Due — next 30 days"
          amount={formatGbp(f.dueNext30)}
          certainty="Invoices issued, due within a month (incl. the next 7 days)"
        />
        <OutlookRow
          label="Planned billing"
          amount={formatGbp(f.plannedCapped)}
          certainty="Agreed billing stages not yet invoiced (capped at the remaining contract) — a plan, not guaranteed cash"
        />
        <OutlookRow
          label="Unscheduled contract value"
          amount={formatGbp(f.unscheduled)}
          certainty="Agreed contract with no billing stage and no invoice"
          accent={f.unscheduled > 0 ? "text-amber-700" : "text-slate-900"}
        />
        {f.draftedNotIssued > 0 ? (
          <OutlookRow
            label="Drafted, not sent"
            amount={formatGbp(f.draftedNotIssued)}
            certainty="Invoices drafted but not yet issued to the customer"
          />
        ) : null}
      </section>

      {showOutflows ? (
        <section aria-labelledby="outflow-heading" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4">
            <h2 id="outflow-heading" className="text-sm font-semibold text-slate-900">
              Money out — what you owe
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Sorted by certainty, and nothing counted twice: a purchase order the supplier has already
              invoiced is in unpaid bills, never also in committed spend. Tap a row for the records behind
              it.
            </p>
          </div>
          {out.components.map((row) => (
            <OutflowRow key={row.key} row={row} />
          ))}
          <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-semibold text-slate-900">Owed out now</p>
              <span className="text-lg font-bold tabular-nums text-slate-900">
                {formatGbp(out.summary.outflowDueNow)}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Unpaid bills + CIS due + VAT + draft payroll. Committed orders and CIS past its deadline are
              deliberately outside this total. CIS figures cover the last {out.cisLookbackMonths} tax months.
              {out.summary.vatReclaim > 0
                ? ` Your VAT estimate is a ${formatGbp(out.summary.vatReclaim)} reclaim this quarter, so VAT adds nothing to the total — we don't book an estimated refund as money in.`
                : ""}
            </p>
          </div>
        </section>
      ) : null}

      {showOutflows && out.unpaidBillQueue.length > 0 ? (
        <section aria-labelledby="q-bills" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <h2 id="q-bills" className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900">
            Supplier bills to pay
            {out.unpaidBillTotalCount > out.unpaidBillQueue.length
              ? ` — biggest ${out.unpaidBillQueue.length} of ${out.unpaidBillTotalCount}`
              : ""}
          </h2>
          <ul className="divide-y divide-slate-100">
            {out.unpaidBillQueue.map((item) => (
              <BillRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      {unscheduledJobs.length > 0 ? (
        <section aria-labelledby="unsched-heading" className="rounded-xl border border-amber-200 bg-amber-50/40 shadow-sm">
          <h2 id="unsched-heading" className="border-b border-amber-100 p-3 text-sm font-semibold text-amber-900">
            {formatGbp(f.unscheduled)} unscheduled across {unscheduledJobs.length} {unscheduledJobs.length === 1 ? "job" : "jobs"}
          </h2>
          <p className="px-3 pt-2 text-xs text-amber-800">Contract value you haven&rsquo;t planned how to bill yet — add a billing stage or raise an invoice.</p>
          <ul className="divide-y divide-amber-100">
            {unscheduledJobs.slice(0, 8).map((u) => (
              <li key={u.jobId}>
                <Link href={u.href} className="flex items-center justify-between gap-3 p-3 hover:bg-amber-100/40">
                  <p className="truncate text-sm font-medium text-amber-900">{u.jobLabel ?? "Job"}</p>
                  <span className="shrink-0 text-sm font-semibold text-amber-900">{formatGbp(u.amount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <QueueList title="Overdue" items={queues.overdue} empty="Nothing overdue — nicely done." showDays />
        <QueueList title="Due soon" items={queues.dueSoon} empty="Nothing due in the next 7 days." />
        <QueueList title="Part paid" items={queues.partPaid} empty="No part-paid invoices." />

        <section aria-labelledby="q-ready" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <h2 id="q-ready" className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900">Ready to invoice</h2>
          {readyByJob.size === 0 ? (
            <p className="p-3 text-sm text-slate-500">No planned stages waiting to be billed.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {[...readyByJob.entries()].slice(0, 8).map(([jobId, g]) => (
                <li key={jobId}>
                  <Link href={`/jobs/${jobId}/billing`} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{g.jobLabel ?? "Job"}</p>
                      <p className="text-xs text-slate-500">{g.count} {g.count === 1 ? "stage" : "stages"} ready</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-slate-900">{formatGbp(g.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {recentlyPaid.length > 0 ? (
        <section aria-labelledby="q-paid" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <h2 id="q-paid" className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900">Recently paid</h2>
          <ul className="divide-y divide-slate-100">
            {recentlyPaid.map((p, i) => (
              <li key={i}>
                <Link href={p.href} className="flex items-center justify-between gap-3 p-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{p.invoiceNumber ?? "Payment"}{p.jobLabel ? ` · ${p.jobLabel}` : ""}</p>
                    <p className="text-xs text-slate-500">{p.paidAt ? `paid ${p.paidAt}` : "paid"}</p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-green-700">{formatGbp(p.amount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
