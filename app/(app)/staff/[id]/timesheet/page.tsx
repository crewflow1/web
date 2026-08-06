import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  entryHours,
  hoursInWindow,
  startOfWeekIso,
  startOfMonthIso,
  addDaysIso,
  type TimeEntry,
} from "@/lib/time/compute";
import { formatDateUK, formatTimeUK } from "@/lib/time/format";

/**
 * Owner / admin view of one staff member's hours.
 *
 *   /staff/[id]/timesheet?weekStart=YYYY-MM-DD
 *
 * Defaults to the current week. Shows day-by-day breakdown + this week
 * total + this month total. Staff themselves see this on /me, so this
 * page is for owners triaging payroll questions.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type SP = Promise<{ weekStart?: string }>;

export default async function TimesheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { ctx, user: viewer } = await requireOrgContext();
  const { id: staffId } = await params;
  const { weekStart: weekStartParam } = await searchParams;
  // Staff can only look at their own timesheet here; owners/admins anyone.
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin && viewer.id !== staffId) {
    return (
      <p className="text-sm text-slate-700">
        Forbidden — your timesheet lives on{" "}
        <Link href="/me" className="font-medium underline">
          your dashboard
        </Link>
        .
      </p>
    );
  }

  const supabase = await createClient();
  const weekStartIso =
    weekStartParam && /^\d{4}-\d{2}-\d{2}$/.test(weekStartParam)
      ? weekStartParam
      : startOfWeekIso();
  const weekEndIso = addDaysIso(weekStartIso, 6);
  const monthStartIso = startOfMonthIso();

  const [profileRes, entriesRes] = await Promise.all([
    supabase
      .from("users")
      .select("full_name, email, hourly_pay, employment_type")
      .eq("id", staffId)
      .maybeSingle(),
    // PAGED (F-1): this timesheet's week/month hour tiles sum the whole month —
    // a bare `.select()` clamped at max_rows (1000) would drop shifts past the
    // cap and under-report a busy worker's hours. Page on the unique
    // `started_at`+`id` order. ACTIVE-org pin — a person who works for two
    // companies through CrewFlow must not have the other company's hours (and
    // pay) shown on this org's timesheet. `user_id` alone is not a scope.
    fetchAllRows<TimeEntry>(
      (from, to) =>
        supabase
          .from("time_entries")
          .select("id, user_id, job_id, started_at, ended_at, breaks, note, payroll_line_id")
          .eq("org_id", ctx.org.id)
          .eq("user_id", staffId)
          .gte("started_at", `${monthStartIso}T00:00:00Z`)
          .order("started_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: TimeEntry[] | null;
          error: unknown;
        }>,
    ),
  ]);

  if (!profileRes.data) notFound();
  if (entriesRes.error) throw readFailure("staff timesheet: entries", entriesRes.error);
  const profile = profileRes.data;
  const entries = (entriesRes.data ?? []) as TimeEntry[];

  const now = new Date();
  const weekStart = new Date(`${weekStartIso}T00:00:00Z`);
  const weekEnd = new Date(`${addDaysIso(weekEndIso, 1)}T00:00:00Z`);
  const monthStart = new Date(`${monthStartIso}T00:00:00Z`);
  const monthEnd = new Date(`${addDaysIso(monthStartIso, 31)}T00:00:00Z`);

  const hoursWeek = hoursInWindow(entries, weekStart, weekEnd, now);
  const hoursMonth = hoursInWindow(entries, monthStart, monthEnd, now);
  const hourlyPay = Number(profile.hourly_pay ?? 0);
  const labourCostWeek = Math.round(hoursWeek * hourlyPay * 100) / 100;
  const labourCostMonth = Math.round(hoursMonth * hourlyPay * 100) / 100;

  // Previous / next week navigation.
  const prevWeek = addDaysIso(weekStartIso, -7);
  const nextWeek = addDaysIso(weekStartIso, 7);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/staff" className="hover:text-slate-900">Staff</Link>
        <span aria-hidden>/</span>
        <Link href={`/staff/${staffId}`} className="hover:text-slate-900">
          {profile.full_name ?? profile.email}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Timesheet</span>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Timesheet · {profile.full_name ?? profile.email}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Week {weekStartIso} → {weekEndIso} ·{" "}
            {hourlyPay > 0 ? `${GBP.format(hourlyPay)} / h` : "no hourly rate set"}
            {profile.employment_type ? ` · ${profile.employment_type}` : ""}
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <Link
            href={`/staff/${staffId}/timesheet?weekStart=${prevWeek}`}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Prev week
          </Link>
          <Link
            href={`/staff/${staffId}/timesheet?weekStart=${nextWeek}`}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
          >
            Next week →
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Hours this week" value={`${hoursWeek.toFixed(2)} h`} />
        <Tile label="Labour cost (week)" value={GBP.format(labourCostWeek)} />
        <Tile label="Hours this month" value={`${hoursMonth.toFixed(2)} h`} />
        <Tile label="Labour cost (month)" value={GBP.format(labourCostMonth)} />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Ended</th>
                <th className="px-4 py-2 text-right">Hours</th>
                <th className="px-4 py-2">Job</th>
                <th className="px-4 py-2">Note</th>
                <th className="px-4 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-500">
                    No time logged this month.
                  </td>
                </tr>
              ) : null}
              {entries.map((e) => {
                const h = entryHours(e, now);
                const started = new Date(e.started_at);
                const ended = e.ended_at ? new Date(e.ended_at) : null;
                return (
                  <tr key={e.id}>
                    <td className="px-4 py-2 text-slate-700 text-xs">
                      {formatDateUK(started)} {formatTimeUK(started)}
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs">
                      {ended ? `${formatDateUK(ended)} ${formatTimeUK(ended)}` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-slate-900">
                      {h.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs">
                      {e.job_id ? (
                        <Link href={`/jobs/${e.job_id}`} className="hover:underline">
                          {e.job_id.slice(0, 8)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-500 text-xs">
                      {(e as { note?: string | null }).note ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {e.ended_at ? (
                        e.payroll_line_id ? (
                          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                            locked
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">
                            closed
                          </span>
                        )
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          open
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
    </div>
  );
}
