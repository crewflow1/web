import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { buildOrgCash } from "@/server/services/org-cash";
import { formatGbp } from "@/lib/money";
import type { CashQueueItem } from "@/lib/commercial/org-cash";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent ?? "text-slate-900"}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function QueueList({ title, items, empty, showDays }: { title: string; items: CashQueueItem[]; empty: string; showDays?: boolean }) {
  return (
    <section aria-labelledby={`q-${title}`} className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <h2 id={`q-${title}`} className="border-b border-slate-100 p-3 text-sm font-semibold text-slate-900">{title}</h2>
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

export default async function CashPage() {
  const { ctx } = await requireOrgContext();
  if (ctx.membership.role === "staff") {
    const { redirect } = await import("next/navigation");
    redirect("/me");
  }
  const { summary: s, queues, recentlyPaid, readyStages } = await buildOrgCash(ctx.org.id);

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
        <h1 className="text-2xl font-bold text-slate-900">Get paid</h1>
        <p className="mt-1 text-sm text-slate-600">What you&rsquo;re owed, what&rsquo;s late, what&rsquo;s coming, and what&rsquo;s ready to invoice.</p>
      </header>

      <section aria-label="Cash summary" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Collectable now" value={formatGbp(s.collectableNow)} accent="text-slate-900" hint={s.retentionHeld > 0 ? `${formatGbp(s.owedNow)} owed − ${formatGbp(s.retentionHeld)} retention` : `${formatGbp(s.owedNow)} owed`} />
        <Stat label="Overdue" value={formatGbp(s.overdue)} accent={s.overdue > 0 ? "text-red-700" : undefined} hint={`${s.overdueCount} ${s.overdueCount === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Due this week" value={formatGbp(s.dueThisWeek)} />
        <Stat label="Expected this month" value={formatGbp(s.dueThisMonth)} hint="invoiced & due (not a forecast)" />
        <Stat label="Retention held" value={formatGbp(s.retentionHeld)} hint={s.retentionDueNow > 0 ? `${formatGbp(s.retentionDueNow)} due for release` : "not yet due"} />
        <Stat label="Ready to invoice" value={formatGbp(s.readyToInvoice)} hint={`${readyStages.length} planned ${readyStages.length === 1 ? "stage" : "stages"}`} />
      </section>

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
