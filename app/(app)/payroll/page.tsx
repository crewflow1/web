import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { defaultPeriod } from "@/lib/payroll/compute";
import { createPayrollRun } from "./actions";
import { CreateRunForm } from "./_create-run-form";
import { EmptyState } from "../_components/empty-state";

/**
 * Payroll overview — admins only.
 *
 *   /payroll              — list runs + new-run form
 *   /payroll/[id]         — line items for a single run + finalise / CSV / payslip PDFs
 *
 * Staff users hit this page and get punted to /me, since their own
 * earnings live on the staff dashboard.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ error?: string; saved?: string }>;

export default async function PayrollPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const role = ctx.membership.role;
  const isAdmin = role === "owner" || role === "admin";
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-700">
        Payroll is admin-only. See your own earnings on{" "}
        <Link href="/me" className="font-medium text-slate-900 underline">
          your dashboard
        </Link>
        .
      </div>
    );
  }

  const sp = await searchParams;
  const supabase = await createClient();

  const { data: runs, error: runsError } = await supabase
    .from("payroll_runs")
    .select("id, cycle, period_start, period_end, status, finalised_at, created_at")
    // ACTIVE-org pin — payroll is the most sensitive list in the product; RLS
    // admits every org the viewer belongs to, so a dual-org owner saw both
    // companies' runs (and their gross/net totals) in one register.
    .eq("org_id", ctx.org.id)
    .order("period_start", { ascending: false })
    .limit(50);
  if (runsError) throw readFailure("payroll register: runs", runsError);

  // Sum gross/net per run for the list view.
  const runIds = (runs ?? []).map((r) => r.id);
  const totalsByRun = new Map<string, { gross: number; net: number; count: number }>();
  if (runIds.length > 0) {
    // F-1: ≤50 runs × many employees can exceed the 1000-row PostgREST cap, so
    // page the per-run lines rather than reading a single truncated page.
    const { data: lines, error: linesError } = await fetchAllRows<{
      payroll_run_id: string;
      gross_pay: number | null;
      net_pay: number | null;
    }>((from, to) =>
      supabase
        .from("payroll_lines")
        .select("id, payroll_run_id, gross_pay, net_pay")
        .eq("org_id", ctx.org.id)
        .in("payroll_run_id", runIds)
        .order("id", { ascending: true })
        .range(from, to),
    );
    // Money figures — a failed read must not render every run as £0.00.
    if (linesError) throw readFailure("payroll register: totals", linesError);
    for (const l of lines ?? []) {
      const t = totalsByRun.get(l.payroll_run_id) ?? { gross: 0, net: 0, count: 0 };
      t.gross += Number(l.gross_pay ?? 0);
      t.net += Number(l.net_pay ?? 0);
      t.count++;
      totalsByRun.set(l.payroll_run_id, t);
    }
  }

  const weekly = defaultPeriod("weekly");
  const monthly = defaultPeriod("monthly");

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = sp.saved
    ? sp.saved === "created"
      ? "Draft run created — review the lines, then finalise."
      : sp.saved === "deleted"
        ? "Draft run deleted."
        : null
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Payroll</h1>
        <p className="mt-1 text-sm text-slate-600">
          Generate weekly or monthly payroll batches from the hours logged
          in CrewFlow. Numbers are <strong>estimates</strong>; export the
          CSV for your accountant or payroll bureau before paying anyone.
        </p>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {savedMessage}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <RunForm
          title="New weekly run"
          cycle="weekly"
          defaultStart={weekly.period_start}
          defaultEnd={weekly.period_end}
        />
        <RunForm
          title="New monthly run"
          cycle="monthly"
          defaultStart={monthly.period_start}
          defaultEnd={monthly.period_end}
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-6 py-3">
          <h2 className="text-base font-semibold text-slate-900">Run history</h2>
        </header>
        {(runs ?? []).length === 0 ? (
          <EmptyState
            icon="📆"
            title="No payroll runs yet"
            body="Start a weekly run above to calculate gross-to-net pay and export it for payment."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(runs ?? []).map((r) => {
              const t = totalsByRun.get(r.id) ?? { gross: 0, net: 0, count: 0 };
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                  <div>
                    <Link
                      href={`/payroll/${r.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {r.cycle} · {r.period_start} → {r.period_end}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {t.count} {t.count === 1 ? "line" : "lines"} · gross{" "}
                      {GBP.format(t.gross)} · net {GBP.format(t.net)}
                    </div>
                  </div>
                  <span
                    className={
                      r.status === "finalised"
                        ? "rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800"
                        : "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                    }
                  >
                    {r.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunForm({
  title,
  cycle,
  defaultStart,
  defaultEnd,
}: {
  title: string;
  cycle: "weekly" | "monthly";
  defaultStart: string;
  defaultEnd: string;
}) {
  return (
    <CreateRunForm
      title={title}
      cycle={cycle}
      defaultStart={defaultStart}
      defaultEnd={defaultEnd}
      action={createPayrollRun}
    />
  );
}
