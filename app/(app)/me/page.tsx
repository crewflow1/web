import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  entryHours,
  hoursInWindow,
  isOnBreak,
  isOpen,
  startOfWeekIso,
  addDaysIso,
  type TimeEntry,
} from "@/lib/time/compute";
import { computePayrollLine } from "@/lib/payroll/compute";
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

  const [profileRes, openRes, weekRes, rotaRes, leavesRes, jobsRes] =
    await Promise.all([
      supabase
        .from("users")
        .select("full_name, hourly_pay, employment_type")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("time_entries")
        .select(
          "id, user_id, job_id, started_at, ended_at, breaks, gps_lat, gps_lng, note",
        )
        .eq("user_id", user.id)
        .is("ended_at", null)
        .maybeSingle(),
      supabase
        .from("time_entries")
        .select("id, user_id, job_id, started_at, ended_at, breaks")
        .eq("user_id", user.id)
        .gte("started_at", `${weekStartIso}T00:00:00Z`)
        .order("started_at", { ascending: false }),
      supabase
        .from("rota_entries")
        .select("id, starts_at, ends_at, job_id, notes")
        .eq("user_id", user.id)
        .gte("starts_at", `${todayIso}T00:00:00Z`)
        .lt("starts_at", `${addDaysIso(todayIso, 1)}T00:00:00Z`)
        .order("starts_at", { ascending: true }),
      supabase
        .from("leave_requests")
        .select("id, type, starts_at, ends_at, status")
        .eq("user_id", user.id)
        .in("status", ["pending", "approved"])
        .gte("ends_at", `${todayIso}T00:00:00Z`)
        .order("starts_at", { ascending: true }),
      supabase
        .from("jobs")
        .select("id, status, scheduled_date, customer:customers ( name )")
        .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
        .neq("status", "completed")
        .order("scheduled_date", { ascending: true })
        .limit(20),
    ]);

  const profile = profileRes.data;
  const hourlyPay = Number(profile?.hourly_pay ?? 0);
  const fullName = profile?.full_name ?? user.email ?? "you";

  const open = openRes.data as TimeEntry | null;
  const weekEntries = (weekRes.data ?? []) as TimeEntry[];

  const weekStart = new Date(`${weekStartIso}T00:00:00Z`);
  const weekEnd = new Date(`${addDaysIso(weekEndIso, 1)}T00:00:00Z`);
  const todayStart = new Date(`${todayIso}T00:00:00Z`);
  const todayEnd = new Date(`${addDaysIso(todayIso, 1)}T00:00:00Z`);
  const hoursToday = hoursInWindow(weekEntries, todayStart, todayEnd, now);
  const hoursWeek = hoursInWindow(weekEntries, weekStart, weekEnd, now);
  const openHours = open ? entryHours(open, now) : 0;
  const onBreak = open ? isOnBreak(open) : false;
  const clockedIn = open ? isOpen(open) : false;

  const expected = computePayrollLine(hoursWeek, hourlyPay, "weekly");

  const errorKey = sp.error ?? "";
  const savedKey = sp.saved ?? "";
  const errorMessage = ERROR_MESSAGES[errorKey] ?? null;
  const savedMessage = SAVED_MESSAGES[savedKey] ?? null;

  const myJobs = (jobsRes.data ?? []).filter(
    (j) => (j as { assigned_to?: string | null }).assigned_to === user.id,
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
                started {new Date(open.started_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
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
          value={GBP.format(expected.net_pay)}
          sub={`PAYE ${GBP.format(expected.paye_estimate)} · NI ${GBP.format(expected.ni_estimate)}`}
        />
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
                    {new Date(r.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    {" – "}
                    {new Date(r.ends_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
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
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}
