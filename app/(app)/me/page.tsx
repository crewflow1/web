import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  entryHours,
  hoursInWindow,
  isOnBreak,
  isOpen,
  startOfWeekIso,
  startOfMonthIso,
  addDaysIso,
  type TimeEntry,
} from "@/lib/time/compute";
import {
  computePayrollLine,
  computeEmployeeDeductionsForStoredLine,
  employeeInputFromStoredProfile,
} from "@/lib/payroll/compute";
import { getPayrollTaxProfile } from "@/server/services/payroll-tax-profile";
import { getPensionEnrolment } from "@/server/services/pension-enrolment";
import { formatTimeUK, formatDateUK } from "@/lib/time/format";
import {
  selectMyOpenTasks,
  isTaskOverdue,
  type MyTaskRow,
} from "@/lib/jobs/my-tasks";
import { clockIn, clockOut, startBreak, endBreak } from "./actions";

/**
 * Staff mobile dashboard ("My day").
 *
 * Everything a field worker needs without scrolling:
 *   - Big clock-in / clock-out button
 *   - Break toggle (only while clocked-in)
 *   - Today's hours + this week's hours
 *   - Expected gross pay this week (hours × hourly_pay) + PAYE/NI estimate
 *   - Today's rota
 *   - Pending leave requests
 *
 * Mobile-first: single column on small screens; tiles spread on md+.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const ERROR_MESSAGES: Record<string, string> = {
  already_clocked_in: "You're already clocked in. Clock out first.",
  not_clocked_in: "You're not clocked in.",
  already_on_break: "You're already on a break.",
  not_on_break: "You're not on a break.",
  on_leave: "You're marked as on leave today — clock-in blocked.",
  clock_in_failed: "Couldn't clock in — try again or ask an admin.",
  clock_out_failed: "Couldn't clock out — try again.",
  break_failed: "Couldn't update your break — try again.",
};

const SAVED_MESSAGES: Record<string, string> = {
  clocked_in: "Clocked in. Have a good shift.",
  clocked_out: "Clocked out. Hours saved.",
  break_started: "Break started.",
  break_ended: "Back to work.",
};

type SP = Promise<{ error?: string; saved?: string }>;

export default async function MePage({ searchParams }: { searchParams: SP }) {
  const { user, ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const weekStartIso = startOfWeekIso(now);
  const weekEndIso = addDaysIso(weekStartIso, 6);
  const monthStartIso = startOfMonthIso(now);

  const [profileRes, compRes, openRes, weekRes, rotaRes, leavesRes, jobsRes, monthRes] =
    await Promise.all([
      supabase
        .from("users")
        .select("full_name, employment_type")
        .eq("id", user.id)
        .maybeSingle(),
      // Own pay from staff_compensation (20261218) — the self-read RLS admits the
      // caller's OWN row, so this drives the /me earnings estimate without exposing
      // any co-worker's rate.
      supabase
        .from("staff_compensation")
        .select("hourly_pay")
        .eq("user_id", user.id)
        .maybeSingle(),
      // ACTIVE-org pins throughout. `user_id` alone is NOT a scope for a person
      // who works for two companies through CrewFlow: their org-B shifts, leave
      // and hours would be summed into org A's "this week"/"this month" pay
      // figures. RLS admits both orgs, so each read carries the org too.
      supabase
        .from("time_entries")
        .select(
          "id, user_id, job_id, started_at, ended_at, breaks, gps_lat, gps_lng, note",
        )
        .eq("org_id", ctx.org.id)
        .eq("user_id", user.id)
        .is("ended_at", null)
        .maybeSingle(),
      // PAGED (F-1): drives this week's hours/pay tiles — a bare `.select()`
      // clamped at max_rows (1000) would under-count a heavy week and understate
      // the worker's own pay estimate. Page on the unique `started_at`+`id` order.
      fetchAllRows<TimeEntry>(
        (from, to) =>
          supabase
            .from("time_entries")
            .select("id, user_id, job_id, started_at, ended_at, breaks")
            .eq("org_id", ctx.org.id)
            .eq("user_id", user.id)
            .gte("started_at", `${weekStartIso}T00:00:00Z`)
            .order("started_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: TimeEntry[] | null;
            error: unknown;
          }>,
      ),
      supabase
        .from("rota_entries")
        .select("id, starts_at, ends_at, job_id, notes")
        .eq("org_id", ctx.org.id)
        .eq("user_id", user.id)
        .gte("starts_at", `${todayIso}T00:00:00Z`)
        .lt("starts_at", `${addDaysIso(todayIso, 1)}T00:00:00Z`)
        .order("starts_at", { ascending: true }),
      supabase
        .from("leave_requests")
        .select("id, type, starts_at, ends_at, status")
        .eq("org_id", ctx.org.id)
        .eq("user_id", user.id)
        .in("status", ["pending", "approved"])
        .gte("ends_at", `${todayIso}T00:00:00Z`)
        .order("starts_at", { ascending: true }),
      supabase
        .from("jobs")
        // `assigned_to` MUST be selected: the "My jobs" filter below narrows to
        // rows where assigned_to === user.id, and PostgREST only returns columns
        // named here — omitting it made every row's assigned_to `undefined`, so
        // the panel rendered permanently empty for every worker (Customer #1
        // rehearsal defect, 2026-08-29).
        .select("id, status, scheduled_date, assigned_to, customer:customers ( name )")
        .eq("org_id", ctx.org.id)
        .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
        // Active work only: completed is done, cancelled (20261220) is dead —
        // a field worker's "My jobs" must never point them at a cancelled site.
        .not("status", "in", "(completed,cancelled)")
        .order("scheduled_date", { ascending: true })
        .limit(20),
      // PAGED (F-1): drives this month's hours + the shift-history list — a
      // clamped read would hide older shifts and under-count monthly pay. Page
      // on the unique `started_at`+`id` order.
      fetchAllRows<TimeEntry>(
        (from, to) =>
          supabase
            .from("time_entries")
            .select("id, user_id, job_id, started_at, ended_at, breaks")
            .eq("org_id", ctx.org.id)
            .eq("user_id", user.id)
            .gte("started_at", `${monthStartIso}T00:00:00Z`)
            .order("started_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: TimeEntry[] | null;
            error: unknown;
          }>,
      ),
    ]);
  // Fail loud on the hours reads — a failed read must not silently zero-out the
  // worker's hours/pay tiles (payroll-adjacent figures are RED).
  if (weekRes.error) throw readFailure("me: week entries", weekRes.error);
  if (monthRes.error) throw readFailure("me: month entries", monthRes.error);

  const profile = profileRes.data;
  // Own-pay for the earnings estimate. Error-aware (not a silent discard): if the
  // read failed we surface no rate rather than a stale/guessed one — a personal
  // best-effort estimate, so it degrades to 0 (shown as "set your rate") instead
  // of throwing and 500-ing the worker's home page.
  const hourlyPay = compRes.error
    ? 0
    : Number((compRes.data as { hourly_pay?: number | string | null } | null)?.hourly_pay ?? 0);
  const fullName = profile?.full_name ?? user.email ?? "you";

  const open = openRes.data as TimeEntry | null;
  const weekEntries = (weekRes.data ?? []) as TimeEntry[];

  const weekStart = new Date(`${weekStartIso}T00:00:00Z`);
  const weekEnd = new Date(`${addDaysIso(weekEndIso, 1)}T00:00:00Z`);
  const todayStart = new Date(`${todayIso}T00:00:00Z`);
  const todayEnd = new Date(`${addDaysIso(todayIso, 1)}T00:00:00Z`);
  const hoursToday = hoursInWindow(weekEntries, todayStart, todayEnd, now);
  const hoursWeek = hoursInWindow(weekEntries, weekStart, weekEnd, now);

  const monthEntries = (monthRes.data ?? []) as TimeEntry[];
  const monthStart = new Date(`${monthStartIso}T00:00:00Z`);
  const hoursMonth = hoursInWindow(monthEntries, monthStart, now, now);
  // Completed shifts only for the history list (open shift shown separately).
  const historyEntries = monthEntries.filter((e) => e.ended_at);
  const openHours = open ? entryHours(open, now) : 0;
  const onBreak = open ? isOnBreak(open) : false;
  const clockedIn = open ? isOpen(open) : false;

  // The worker's OWN view: gross, PAYE, employee NI, net. Employer NI and employer
  // pension are deliberately NOT surfaced here and never touch net pay — they are
  // the employer's cost, not a deduction from this person's wages.
  const expected = computePayrollLine(hoursWeek, hourlyPay, "weekly", weekStartIso);
  // Refine take-home with THIS worker's own stored tax profile (Scottish bands,
  // student loan, salary sacrifice) and pension contribution — the same overlay the
  // admin run detail page shows, so the worker sees the figures their payslip will
  // carry rather than the standard-code base. Org-pinned reads; no profile ⇒ the
  // refined figures equal the base to the penny.
  const [ownTaxProfile, ownPension] = await Promise.all([
    getPayrollTaxProfile(ctx.org.id, user.id),
    getPensionEnrolment(ctx.org.id, user.id),
  ]);
  const ownPensionRate =
    ownPension?.status === "enrolled" && ownPension.employee_contribution_rate > 0
      ? ownPension.employee_contribution_rate
      : undefined;
  const refined = computeEmployeeDeductionsForStoredLine(
    expected.gross_pay,
    "weekly",
    weekStartIso,
    {
      ...employeeInputFromStoredProfile(ownTaxProfile),
      employeePensionRate: ownPensionRate,
    },
  );
  // Sub-caption for the take-home tile: PAYE + NI always, plus student loan /
  // pension when they actually apply, so the number reconciles for the worker.
  const takeHomeParts = [
    `PAYE ${GBP.format(refined.paye_estimate)}`,
    `NI ${GBP.format(refined.ni_estimate)}`,
  ];
  if (refined.student_loan_estimate > 0) {
    takeHomeParts.push(`SL ${GBP.format(refined.student_loan_estimate)}`);
  }
  if (refined.employee_pension_estimate > 0) {
    takeHomeParts.push(`pension ${GBP.format(refined.employee_pension_estimate)}`);
  }

  const errorKey = sp.error ?? "";
  const savedKey = sp.saved ?? "";
  const errorMessage = ERROR_MESSAGES[errorKey] ?? null;
  const savedMessage = SAVED_MESSAGES[savedKey] ?? null;

  const myJobs = (jobsRes.data ?? []).filter(
    (j) => (j as { assigned_to?: string | null }).assigned_to === user.id,
  );

  // "My tasks" — checklist items assigned to me, still open (migration
  // 20261182000000). ACTIVE-org pinned + assigned + open at the DB (RLS admits
  // every org I belong to, so the org pin is the real scope); the pure
  // selectMyOpenTasks re-asserts "mine and open" and orders by due date.
  //
  // COMPLETE (F-1): a personal open-worklist must show EVERY open task, so it is
  // PAGED via fetchAllRows on a stable total order (due_on asc, id asc) rather
  // than clamped — a capped read would silently hide a busy worker's later
  // tasks. Read LOUDLY — a failed read must not render an empty task list.
  // job_checklists isn't in the generated types yet — the `as never` idiom.
  type MyTaskDbRow = {
    id: string;
    label: string;
    job_id: string;
    is_done: boolean;
    assigned_to: string | null;
    due_on: string | null;
    job: { customer: { name: string | null } | null } | null;
  };
  const tasksRes = await fetchAllRows<MyTaskDbRow>(
    (from, to) =>
      supabase
        .from("job_checklists" as never)
        .select(
          "id, label, job_id, is_done, assigned_to, due_on, job:jobs ( customer:customers ( name ) )" as never,
        )
        .eq("org_id" as never, ctx.org.id as never)
        .eq("assigned_to" as never, user.id as never)
        .eq("is_done" as never, false as never)
        .order("due_on" as never, { ascending: true, nullsFirst: false })
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: MyTaskDbRow[] | null;
        error: unknown;
      }>,
  );
  if (tasksRes.error) throw readFailure("me: my tasks", tasksRes.error);
  const myTasks = selectMyOpenTasks(
    (tasksRes.data ?? []).map(
      (r): MyTaskRow => ({
        id: r.id,
        label: r.label,
        job_id: r.job_id,
        is_done: r.is_done,
        assigned_to: r.assigned_to,
        due_on: r.due_on,
        customer_name: r.job?.customer?.name ?? null,
      }),
    ),
    user.id,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">My day</h1>
        <p className="mt-1 text-sm text-slate-600">
          {fullName} · {ctx.org.name}
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

      {/* Big primary action — clock in/out */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {clockedIn && open ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Clocked in
              </div>
              <div className="mt-1 text-3xl font-bold text-slate-900">
                {openHours.toFixed(2)} h
              </div>
              <div className="text-xs text-slate-500">
                started {formatTimeUK(open.started_at)}
                {open.job_id ? " · on a job" : ""}
                {onBreak ? " · on break" : ""}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {onBreak ? (
                <form action={endBreak}>
                  <button
                    type="submit"
                    className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    End break
                  </button>
                </form>
              ) : (
                <form action={startBreak}>
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Start break
                  </button>
                </form>
              )}
              <form action={clockOut} className="flex-1">
                <button
                  type="submit"
                  className="w-full rounded-md bg-red-600 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-red-700"
                >
                  Clock out
                </button>
              </form>
            </div>
          </div>
        ) : (
          <form action={clockIn} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">
                Job (optional)
                <select
                  name="job_id"
                  defaultValue=""
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                >
                  <option value="">— general work —</option>
                  {myJobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {(j.customer?.name ?? "Job")} · {j.status}
                      {j.scheduled_date ? ` · ${j.scheduled_date}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">
                Note (optional)
                <input
                  type="text"
                  name="note"
                  maxLength={500}
                  placeholder="e.g. starting on the loft conversion"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
                />
              </label>
            </div>
            <button
              type="submit"
              className="w-full rounded-md bg-green-600 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-green-700"
            >
              Clock in
            </button>
            <p className="text-[11px] text-slate-500">
              Your start time is set when you tap. End-of-day clock-out
              auto-closes any open breaks.
            </p>
          </form>
        )}
      </section>

      {/* Today + week tiles */}
      <section className="grid grid-cols-2 gap-3">
        <Tile label="Today" value={`${hoursToday.toFixed(2)} h`} sub={clockedIn ? "live" : "logged"} />
        <Tile label="This week" value={`${hoursWeek.toFixed(2)} h`} sub={`${weekStartIso} → ${weekEndIso}`} />
        <Tile
          label="Expected gross"
          value={GBP.format(expected.gross_pay)}
          sub={hourlyPay > 0 ? `${GBP.format(hourlyPay)}/h` : "no hourly rate set"}
        />
        <Tile
          label="Expected take-home"
          value={GBP.format(refined.net_pay)}
          sub={takeHomeParts.join(" · ")}
        />
      </section>

      {/* Timesheet history — daily/weekly/monthly + clock in/out history */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">My timesheet</h2>
          <div className="text-xs text-slate-500">
            Today {hoursToday.toFixed(2)}h · Week {hoursWeek.toFixed(2)}h · Month{" "}
            {hoursMonth.toFixed(2)}h
          </div>
        </div>
        {historyEntries.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No completed shifts this month yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {historyEntries.map((e) => {
              const breaks = Array.isArray(e.breaks) ? e.breaks.length : 0;
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div>
                    <div className="font-medium text-slate-900">
                      {formatDateUK(e.started_at)}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatTimeUK(e.started_at)} – {formatTimeUK(e.ended_at)}
                      {breaks > 0
                        ? ` · ${breaks} break${breaks > 1 ? "s" : ""}`
                        : ""}
                      {e.job_id ? " · on a job" : ""}
                    </div>
                  </div>
                  <div className="text-right font-semibold text-slate-900">
                    {entryHours(e, now).toFixed(2)} h
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-slate-500">
          Showing this month. Times shown in UK time (BST/GMT).
        </p>
      </section>

      {/* Today's rota */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Today&apos;s rota</h2>
        {(rotaRes.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No rota entries for today.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {(rotaRes.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <div>
                  <div className="font-medium text-slate-900">
                    {formatTimeUK(r.starts_at)}
                    {" – "}
                    {formatTimeUK(r.ends_at)}
                  </div>
                  {r.notes ? <div className="text-xs text-slate-500">{r.notes}</div> : null}
                </div>
                {r.job_id ? (
                  <Link href={`/jobs/${r.job_id}`} className="text-xs text-slate-500 hover:text-slate-900">
                    View job →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* My jobs */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">My jobs</h2>
          <Link href="/jobs" className="text-xs font-medium text-slate-500 hover:text-slate-900">
            All jobs →
          </Link>
        </div>
        {myJobs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No jobs assigned to you right now.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {myJobs.slice(0, 5).map((j) => (
              <li key={j.id} className="flex items-center justify-between py-1.5">
                <Link href={`/jobs/${j.id}`} className="truncate text-slate-700 hover:text-slate-900">
                  {j.customer?.name ?? "Job"}
                </Link>
                <span className="ml-2 shrink-0 text-xs text-slate-500">
                  {j.status}
                  {j.scheduled_date ? ` · ${j.scheduled_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* My tasks — assigned checklist items */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">My tasks</h2>
          {myTasks.length > 0 ? (
            <span className="text-xs text-slate-500">
              {myTasks.length} open
            </span>
          ) : null}
        </div>
        {myTasks.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No tasks assigned to you right now.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {myTasks.map((t) => {
              const overdue = isTaskOverdue(t.due_on, todayIso);
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 py-1.5">
                  <Link
                    href={`/jobs/${t.job_id}#checklist`}
                    className="min-w-0 flex-1 truncate text-slate-700 hover:text-slate-900"
                  >
                    {t.label}
                    {t.customer_name ? (
                      <span className="ml-1 text-xs text-slate-400">
                        · {t.customer_name}
                      </span>
                    ) : null}
                  </Link>
                  {t.due_on ? (
                    <span
                      className={
                        overdue
                          ? "shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700"
                          : "shrink-0 text-xs text-slate-500"
                      }
                    >
                      {overdue ? "overdue · " : "due "}
                      {t.due_on}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-slate-400">no date</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Leave */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Upcoming leave</h2>
          <Link href="/staff/leave" className="text-xs font-medium text-slate-500 hover:text-slate-900">
            Request leave →
          </Link>
        </div>
        {(leavesRes.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No leave booked or pending.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {(leavesRes.data ?? []).map((l) => (
              <li key={l.id} className="flex items-center justify-between py-1.5">
                <div>
                  <div className="font-medium text-slate-900">
                    {l.type} · {l.starts_at.slice(0, 10)} → {l.ends_at.slice(0, 10)}
                  </div>
                </div>
                <span
                  className={
                    l.status === "approved"
                      ? "rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800"
                      : "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                  }
                >
                  {l.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 truncate text-xl font-bold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}
