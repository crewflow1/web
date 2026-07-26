import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOrgContext } from "@/server/auth/session";
import { isInvoiceOverdue } from "@/lib/invoices/overdue";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import { ActivityFeed } from "./_activity-feed";
import type { ActivityRow } from "@/lib/activity/render";
import { InsightsSection } from "./_insights";
import { SetupChecklist } from "./_setup-checklist";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import { buildRetentionSnapshot } from "@/server/services/retention-snapshot";
import { ensureMilestoneNotifications } from "@/server/services/retention-milestones";
import { RetentionPanel } from "./_retention";
import {
  computeActivitySummary,
  computeLeadInsights,
} from "@/lib/ai/aggregates";
import {
  computeAllJobsProfitability,
  topProfitableJobs,
  worstJobs,
  averageMargin,
  totalProfitThisMonth,
  profitByMonth,
  marginPillClass,
  marginBand,
  labourCostsFromTimeEntries,
  type JobProfitability,
} from "@/lib/profitability/compute";
import {
  hoursInWindow,
  hoursByJob,
  startOfWeekIso,
  addDaysIso,
  type TimeEntry,
} from "@/lib/time/compute";
import { computePayrollLine } from "@/lib/payroll/compute";

/**
 * Owner dashboard.
 *
 * All numbers are derived from the org's actual rows (RLS-scoped via the
 * user-context Supabase client). No mock data.
 *
 * Query approach — we fetch the underlying rows once per entity and
 * compute aggregations in TypeScript, so the code stays easy to follow.
 *
 * F-1 fix: the per-entity reads go through `fetchAllRows`, which pages
 * under the PostgREST max-rows cap (1000 by default). A bare `.select()`
 * with no `.range()` is SILENTLY TRUNCATED once an org crosses that many
 * rows, so every KPI here (counts, money sums, profitability, pipeline)
 * would have under-reported with no error. Paging the reads keeps the
 * aggregation arithmetic identical while making the inputs complete and
 * volume-independent. Each paged read uses a stable `created_at desc + id`
 * ordering so rows can't shift across page boundaries.
 *
 * Later-horizon note: once a single org carries tens of thousands of rows
 * (well past the 200-company target), move these per-entity reads to
 * DB-side SQL aggregates / RPC views. Paging is the correct, low-risk fix
 * for launch; SQL aggregates are the deliberate next step beyond it.
 *
 * Time windows:
 *   - "this week" = last 7 days rolling
 *   - "this month" = current calendar month
 *   - "this quarter" = current calendar quarter (Jan-Mar, Apr-Jun, ...)
 *
 * UK VAT note: many businesses use VAT staggers (March/June/September
 * or April/July/October) rather than calendar quarters. Calendar
 * quarter is the safe default; a per-org VAT-start-month setting is
 * a follow-up if owners ask.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function startOfMonthISO(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function startOfQuarterISO(now = new Date()): string {
  const q = Math.floor(now.getUTCMonth() / 3);
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)).toISOString();
}

function sevenDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

const JOB_STATUSES = ["new", "in-progress", "completed", "blocked"] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_STATUS_STYLES: Record<JobStatus, string> = {
  new: "bg-blue-100 text-blue-700",
  "in-progress": "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  blocked: "bg-red-100 text-red-700",
};

const INVOICE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function DashboardPage() {
  const { user, ctx } = await requireOrgContext();
  // Wave 4 — staff role goes to /me; the business dashboard is owner/admin.
  if (ctx.membership.role === "staff") {
    const { redirect } = await import("next/navigation");
    redirect("/me");
  }
  const supabase = await createClient();

  const monthStart = startOfMonthISO();
  const quarterStart = startOfQuarterISO();
  const weekStart = sevenDaysAgoISO();
  // Profitability charts span 6 calendar months — widen finance fetch
  // so the older buckets render with real data rather than zeros.
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5);
  sixMonthsAgo.setUTCDate(1);
  sixMonthsAgo.setUTCHours(0, 0, 0, 0);
  const sixMonthsAgoIso = sixMonthsAgo.toISOString();

  // Fetch everything in parallel under RLS.
  const ACTIVITY_PAGE_SIZE = 25;
  const [jobsRes, invoicesRes, financesRes, leadsRecentRes, membersRes, quotesRes, leadsAllRes, activityRes] =
    await Promise.all([
      fetchAllRows((from, to) =>
        supabase
          .from("jobs")
          .select(
            "id, status, scheduled_date, photos, assigned_to, created_at, customer:customers ( id, name )",
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase
          .from("invoices")
          .select(
            "id, number, status, amount, vat_total, total, due_date, paid_at, created_at, job_id",
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase
          .from("finances")
          .select("id, amount, vat_total, created_at, category, job_id")
          .gte("created_at", sixMonthsAgoIso)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      supabase
        .from("leads")
        .select(
          "id, source, urgency, service, postcode, created_at, customer:customers ( id, name )",
        )
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("memberships")
        .select("user_id, role, user:users ( id, full_name, email )"),
      fetchAllRows((from, to) =>
        supabase
          .from("quotes")
          .select("id, status, total, accepted_at, created_at, approved_at")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase
          .from("leads")
          .select("id, status, source, estimated_value, created_at")
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      supabase
        .from("activity_log")
        .select(
          "id, actor_id, actor_name, action, target_table, target_id, metadata, created_at",
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(0, ACTIVITY_PAGE_SIZE - 1),
    ]);

  // Wave 3 — payment + reconciliation rollups.
  const [{ data: paymentsThisMonth }, { data: unmatchedLines }] =
    await Promise.all([
      supabase
        .from("invoice_payments")
        .select("amount, paid_at, source")
        .gte("paid_at", monthStart.slice(0, 10)),
      supabase
        .from("bank_statement_lines")
        .select("id, amount, posted_at")
        .eq("match_status", "suggested"),
    ]);

  // Wave 4 — time + payroll rollups (last 30 days of time entries is plenty
  // for "this week" + "this month" tiles).
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: timeEntriesRaw }, { data: payableMembers }] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("time_entries")
        .select("id, user_id, job_id, started_at, ended_at, breaks")
        .gte("started_at", thirtyDaysAgoIso)
        .order("started_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    supabase
      .from("memberships")
      .select("user_id, role, user:users ( id, hourly_pay )"),
  ]);

  const jobs = jobsRes.data ?? [];
  // Cast: job_id is in the 20260520150000 migration but not yet in
  // the generated Supabase types — same pattern as the reminder cols.
  type InvoiceWithJob = {
    id: string;
    number: string;
    status: string;
    amount: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    due_date: string | null;
    paid_at: string | null;
    created_at: string;
    job_id: string | null;
  };
  type FinanceWithJob = {
    id: string;
    amount: number | string | null;
    vat_total: number | string | null;
    created_at: string;
    category: string | null;
    job_id: string | null;
  };
  const invoices = (invoicesRes.data ?? []) as unknown as InvoiceWithJob[];
  const finances = (financesRes.data ?? []) as unknown as FinanceWithJob[];
  const leads = leadsRecentRes.data ?? [];
  const members = membersRes.data ?? [];
  const quotes = quotesRes.data ?? [];
  const allLeads = leadsAllRes.data ?? [];

  // Contract retention "due back" (Programme C extension) — the portfolio view
  // of held retention + what's due for release. Read on the TENANT client (RLS)
  // and PAGED (never a truncated `.select()`); the rollup reuses the same
  // per-job derivation as the job page so the numbers agree. The `jobs`
  // retention columns aren't in the generated types yet — cast the reads.
  type RetTermsRow = {
    id: string;
    retention_percent: number | string | null;
    practical_completion_date: string | null;
    defects_liability_months: number | string | null;
    retention_first_release_pct: number | string | null;
  };
  type RetRelRow = { job_id: string | null; amount: number | string | null };
  type Paged<T> = {
    order: (k: string, o: { ascending: boolean }) => {
      range: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
    };
  };
  const [retentionJobsRes, retentionReleasesRes] = await Promise.all([
    fetchAllRows<RetTermsRow>((from, to) =>
      (supabase.from("jobs" as never) as unknown as { select: (c: string) => Paged<RetTermsRow> })
        .select("id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<RetRelRow>((from, to) =>
      (supabase.from("retention_releases" as never) as unknown as { select: (c: string) => Paged<RetRelRow> })
        .select("job_id, amount")
        // Order by the UNIQUE primary key, not the non-unique job_id: fetchAllRows
        // needs a stable total order or rows sharing a sort-key value can be
        // dropped/duplicated at a 500-row page boundary (the F-1 truncation class).
        // The rollup groups by job_id in JS, so the order only has to be stable.
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  const retentionRollup = computeRetentionDueRollup({
    jobs: (retentionJobsRes.data ?? []).map((j) => ({
      id: j.id,
      ratePercent: j.retention_percent,
      practicalCompletionDate: j.practical_completion_date,
      defectsLiabilityMonths: j.defects_liability_months,
      firstReleasePct: j.retention_first_release_pct,
    })),
    invoices: invoices.map((i) => ({ job_id: i.job_id, status: i.status, amount: i.amount })),
    releases: retentionReleasesRes.data ?? [],
  });
  const activity = (activityRes.data ?? []) as unknown as ActivityRow[];
  const activityTotal = activityRes.count ?? 0;
  const activityHasMore = activity.length < activityTotal;

  // Slice 6 — deterministic insight payloads. Run in parallel so the
  // page-render fan-out doesn't grow linearly. LLM prose lands later
  // when ANTHROPIC_API_KEY / OPENAI_API_KEY is added to Vercel.
  //
  // The onboarding snapshot is fetched alongside so the SetupChecklist
  // card has live data without an extra round-trip waterfall. We build it
  // ONCE and hand the in-flight promise to the retention snapshot, which
  // also needs it — that de-dupes an org-row fetch + 5 count queries that
  // were previously run twice per dashboard load.
  const onboardingSnapshotPromise = buildOnboardingSnapshot(ctx.org.id);
  const [activityInsights, leadInsights, onboardingSnapshot, retentionSnapshot] =
    await Promise.all([
      computeActivitySummary(ctx.org.id, 7),
      computeLeadInsights(ctx.org.id, 30),
      onboardingSnapshotPromise,
      buildRetentionSnapshot(ctx.org.id, {
        onboarding: onboardingSnapshotPromise,
      }),
    ]);

  // Phase 2 — fire the milestone notification + audit-log side
  // effects for any newly-crossed milestones. Best-effort; idempotent
  // via onboarding_state.notified_milestones. Errors are swallowed
  // so a transient DB blip can't break the dashboard.
  await ensureMilestoneNotifications(ctx.org.id, retentionSnapshot, {
    id: user.id,
    email: user.email ?? null,
  });

  // First-run state: the org has nothing yet. Show a welcome screen with CTAs.
  if (
    jobs.length === 0 &&
    invoices.length === 0 &&
    finances.length === 0 &&
    quotes.length === 0 &&
    allLeads.length === 0
  ) {
    return <FirstRun userEmail={user.email ?? ""} orgName={ctx.org.name} />;
  }

  // --- aggregations -------------------------------------------------------
  const jobsByStatus: Record<JobStatus, number> = {
    new: 0,
    "in-progress": 0,
    completed: 0,
    blocked: 0,
  };
  let jobsThisWeek = 0;
  let photosMissing = 0;
  for (const j of jobs) {
    if (JOB_STATUSES.includes(j.status as JobStatus)) {
      jobsByStatus[j.status as JobStatus]++;
    }
    if (j.scheduled_date && j.scheduled_date >= weekStart.slice(0, 10)) {
      jobsThisWeek++;
    }
    // Photos needed = active jobs (in-progress or completed) with no photos.
    if (
      (j.status === "in-progress" || j.status === "completed") &&
      (!j.photos || j.photos.length === 0)
    ) {
      photosMissing++;
    }
  }

  let invoicedThisMonth = 0;
  let outstandingCount = 0;
  let outstandingTotal = 0;
  let overdueCount = 0;
  let overdueTotal = 0;
  let dueThisWeekCount = 0;
  let dueThisWeekTotal = 0;
  let outputVatQuarter = 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekFromNowIso = new Date(Date.now() + 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const inv of invoices) {
    const total = Number(inv.total ?? 0);
    const vat = Number(inv.vat_total ?? 0);
    // M1: this tile is now an accrual ("invoiced") figure keyed off
    // created_at, NOT an inv.status === "paid" sum. A mis-marked or
    // synthetic invoice (status "paid" with no invoice_payments rows) used
    // to inflate "Revenue this month" to figures that money-in never backs.
    // Cash actually collected is tracked separately via cashInThisMonth,
    // which sums invoice_payments — the only source of truth for money in.
    if (inv.created_at && inv.created_at >= monthStart) {
      invoicedThisMonth += total;
    }
    // Overdue is DERIVED by the one authority (lib/invoices/overdue.ts) and
    // counted OUTSIDE the outstanding gate below. That gate admits only
    // `sent`/`overdue`, but money is equally owed on `awaiting_payment` and
    // `partially_paid` — so counting overdue inside it would keep this tile
    // selecting a narrower population than its own drill-through
    // (/invoices?status=overdue), which is the mismatch this change ends. The
    // outstanding / due-this-week tiles keep their existing status gate: they
    // are different metrics and not in scope here.
    const overdue = isInvoiceOverdue(inv, todayIso);
    if (overdue) {
      overdueCount++;
      overdueTotal += total;
    }
    if (inv.status === "sent" || inv.status === "overdue") {
      outstandingCount++;
      outstandingTotal += total;
      if (
        !overdue &&
        inv.due_date &&
        inv.due_date >= todayIso &&
        inv.due_date <= weekFromNowIso
      ) {
        dueThisWeekCount++;
        dueThisWeekTotal += total;
      }
    }
    if (inv.status === "paid" && inv.paid_at && inv.paid_at >= quarterStart) {
      outputVatQuarter += vat;
    }
  }

  let inputVatQuarter = 0;
  for (const f of finances) {
    inputVatQuarter += Number(f.vat_total ?? 0);
  }
  const netVatQuarter = outputVatQuarter - inputVatQuarter;

  // ---- time + labour (Wave 4) ----
  const timeEntries = (timeEntriesRaw ?? []) as TimeEntry[];
  const weekStartIsoDate = startOfWeekIso();
  const weekStartDate = new Date(`${weekStartIsoDate}T00:00:00Z`);
  const weekEndDate = new Date(`${addDaysIso(weekStartIsoDate, 7)}T00:00:00Z`);
  const monthStartDate = new Date(monthStart);
  // monthEndDate ≈ now + a hair so an open entry counts toward "this month".
  const monthEndDate = new Date(Date.now() + 86_400_000);
  const teamHoursWeek = hoursInWindow(timeEntries, weekStartDate, weekEndDate);
  const teamHoursMonth = hoursInWindow(timeEntries, monthStartDate, monthEndDate);
  const hoursPerJob = hoursByJob(timeEntries, monthStartDate, monthEndDate);

  // Per-user hourly rate for the labour cost roll-up.
  const hourlyByUser = new Map<string, number>();
  for (const m of payableMembers ?? []) {
    const uid = (m as { user_id: string }).user_id;
    const u = (m as { user?: { hourly_pay: number | null } }).user;
    hourlyByUser.set(uid, Number(u?.hourly_pay ?? 0));
  }

  // Sum org-wide labour cost this month + week.
  let labourCostWeek = 0;
  let labourCostMonth = 0;
  for (const e of timeEntries) {
    const rate = hourlyByUser.get(e.user_id) ?? 0;
    if (rate <= 0) continue;
    // Approximate: use entry's full hours and check which window it overlaps.
    const weekHrs = hoursInWindow([e], weekStartDate, weekEndDate);
    const monthHrs = hoursInWindow([e], monthStartDate, monthEndDate);
    labourCostWeek += weekHrs * rate;
    labourCostMonth += monthHrs * rate;
  }
  labourCostWeek = Math.round(labourCostWeek * 100) / 100;
  labourCostMonth = Math.round(labourCostMonth * 100) / 100;

  // Estimated payroll-due for the current week (sum across users of the
  // weekly computePayrollLine net pay) — what's actually owed if a run
  // is generated right now.
  let payrollDueThisWeek = 0;
  const hoursByUserThisWeek = new Map<string, number>();
  for (const e of timeEntries) {
    const h = hoursInWindow([e], weekStartDate, weekEndDate);
    if (h === 0) continue;
    hoursByUserThisWeek.set(
      e.user_id,
      (hoursByUserThisWeek.get(e.user_id) ?? 0) + h,
    );
  }
  for (const [uid, hours] of hoursByUserThisWeek) {
    const rate = hourlyByUser.get(uid) ?? 0;
    if (rate <= 0) continue;
    const c = computePayrollLine(hours, rate, "weekly");
    payrollDueThisWeek += c.net_pay;
  }
  payrollDueThisWeek = Math.round(payrollDueThisWeek * 100) / 100;

  // ---- cashflow (Wave 3) ----
  let cashInThisMonth = 0;
  let cashInFromBank = 0;
  for (const p of paymentsThisMonth ?? []) {
    const amt = Number(p.amount ?? 0);
    cashInThisMonth += amt;
    if (p.source === "bank_csv") cashInFromBank += amt;
  }
  const unmatchedSuggestions = (unmatchedLines ?? []).length;
  // Expected incoming = unpaid invoice totals minus what's already been
  // partially paid against them. Use outstandingTotal for the overall pool.
  const expectedIncoming = outstandingTotal;

  // ---- profitability ---------------------------------------------------
  // Per-job rollup. Invoices contribute revenue via job_id; finances
  // contribute costs via job_id. Jobs with neither don't appear.
  // Wave 4 — labour cost from time entries is treated as a virtual
  // finance row tagged 'labour', so the existing profitability code
  // picks it up under the labour bucket without bespoke wiring.
  const labourRows = labourCostsFromTimeEntries(
    Array.from(hoursPerJob.entries()).flatMap(([jobId]) => {
      const entriesForJob = timeEntries.filter((te) => te.job_id === jobId);
      // Aggregate hours per (user, job) for fair cost attribution.
      const byUser = new Map<string, number>();
      for (const te of entriesForJob) {
        const h = hoursInWindow([te], monthStartDate, monthEndDate);
        if (h > 0) byUser.set(te.user_id, (byUser.get(te.user_id) ?? 0) + h);
      }
      return Array.from(byUser.entries()).map(([userId, hours]) => ({
        job_id: jobId,
        user_id: userId,
        hours,
      }));
    }),
    hourlyByUser,
  );
  const profitabilityRows: JobProfitability[] = computeAllJobsProfitability(
    jobs,
    invoices,
    [...finances, ...labourRows],
  );
  const topProfitable = topProfitableJobs(profitabilityRows, 5);
  const worstMarginJobs = worstJobs(profitabilityRows, 5);
  const avgMargin = averageMargin(profitabilityRows);
  const profitMonth = totalProfitThisMonth(invoices, finances);
  const profitSeries = profitByMonth(invoices, finances, 6, "created_at");
  const profitChartMax = Math.max(1, ...profitSeries.map((b) => Math.abs(b.profit)));
  const revCostChartMax = Math.max(
    1,
    ...profitSeries.flatMap((b) => [b.revenue, b.costs]),
  );
  const jobNameById = new Map<string, string>();
  for (const j of jobs) {
    jobNameById.set(
      j.id,
      // jobs don't have a title column; surface the customer name to
      // make each row recognisable in the leaderboard.
      j.customer?.name ?? `Job ${j.id.slice(0, 8)}`,
    );
  }

  // ---- quote analytics -------------------------------------------------
  let pendingQuoteCount = 0; // draft / pending_approval / approved / sent / viewed
  let pendingApprovalCount = 0; // pending_approval only — for the approval tile
  let approvedTodayCount = 0;
  let rejectedCount = 0; // approver-rejected (not customer-declined)
  let acceptedThisMonthCount = 0;
  let acceptedThisMonthValue = 0;
  let conversionDecided = 0; // accepted + declined
  let conversionAccepted = 0;
  let totalQuoteValue = 0;
  const todayIsoStr = new Date().toISOString().slice(0, 10);
  for (const q of quotes) {
    const total = Number(q.total ?? 0);
    totalQuoteValue += total;
    if (
      q.status === "draft" ||
      q.status === "pending_approval" ||
      q.status === "approved" ||
      q.status === "sent" ||
      q.status === "viewed"
    ) {
      pendingQuoteCount++;
    }
    if (q.status === "pending_approval") pendingApprovalCount++;
    if (q.status === "rejected") rejectedCount++;
    if (q.approved_at && q.approved_at.slice(0, 10) === todayIsoStr) {
      approvedTodayCount++;
    }
    if (q.status === "accepted" || q.status === "declined") {
      conversionDecided++;
      if (q.status === "accepted") conversionAccepted++;
    }
    if (
      q.status === "accepted" &&
      q.accepted_at &&
      q.accepted_at >= monthStart
    ) {
      acceptedThisMonthCount++;
      acceptedThisMonthValue += total;
    }
  }
  const conversionPct =
    conversionDecided === 0
      ? null
      : Math.round((conversionAccepted / conversionDecided) * 100);
  const avgQuoteValue =
    quotes.length === 0 ? 0 : totalQuoteValue / quotes.length;

  // ---- lead pipeline analytics ----------------------------------------
  let leadsThisMonth = 0;
  let leadsWon = 0;
  let leadsLost = 0;
  let pipelineForecast = 0;
  const leadsBySource = new Map<string, { count: number; won: number }>();
  for (const l of allLeads) {
    if (l.created_at >= monthStart) leadsThisMonth++;
    const src = l.source ?? "other";
    const prev = leadsBySource.get(src) ?? { count: 0, won: 0 };
    prev.count++;
    if (l.status === "won" || l.status === "job_booked") {
      prev.won++;
      leadsWon++;
    }
    if (l.status === "lost") leadsLost++;
    // Forecast: open stages × estimated_value (open = not won/lost/job_booked).
    if (
      l.status === "new" ||
      l.status === "contacted" ||
      l.status === "qualified" ||
      l.status === "quoted"
    ) {
      pipelineForecast += Number(l.estimated_value ?? 0);
    }
    leadsBySource.set(src, prev);
  }
  const leadDecided = leadsWon + leadsLost;
  const leadConversionPct =
    leadDecided === 0 ? null : Math.round((leadsWon / leadDecided) * 100);
  const topSources = Array.from(leadsBySource.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  // Recent jobs (top 5 from the full fetch).
  const recentJobs = jobs.slice(0, 5);
  const recentInvoices = invoices.slice(0, 5);

  // Staff workload — for each member, count assigned active + completed jobs.
  const staffWorkload = members.map((m) => {
    const userId = m.user?.id;
    if (!userId) return null;
    let active = 0;
    let done = 0;
    for (const j of jobs) {
      if (j.assigned_to !== userId) continue;
      if (j.status === "completed") done++;
      else active++;
    }
    return {
      id: userId,
      name: m.user?.full_name ?? m.user?.email ?? "—",
      role: m.role,
      active,
      done,
    };
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            {ctx.org.name} — overview of your last week.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            href="/leads/new"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            + Add lead
          </Link>
          <Link
            href="/jobs/new"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            + Add job
          </Link>
          <Link
            href="/staff"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            + Add staff
          </Link>
        </div>
      </header>

      {/* Onboarding checklist — pinned at the top until setup is 100% */}
      <SetupChecklist snapshot={onboardingSnapshot} />

      {/* Retention + experience layer — health, nudges, milestones,
          weekly summary, inactivity rescue. Sits above the existing
          KPI grid so the operator sees the highest-signal items
          first. */}
      <RetentionPanel signals={retentionSnapshot} />

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Jobs this week"
          value={jobsThisWeek.toString()}
          href="/jobs"
          sub={`${jobs.length} total`}
        />
        <Kpi
          label="Invoiced this month"
          value={GBP.format(invoicedThisMonth)}
          href="/invoices"
          sub="billed this month (accrual)"
        />
        <Kpi
          label="Outstanding"
          value={GBP.format(outstandingTotal)}
          href="/invoices?status=sent"
          sub={`${outstandingCount} ${outstandingCount === 1 ? "invoice" : "invoices"}`}
        />
        <Kpi
          label="VAT this quarter"
          value={GBP.format(netVatQuarter)}
          href="/finances"
          sub={`output ${GBP.format(outputVatQuarter)} − input ${GBP.format(inputVatQuarter)}`}
        />
      </section>

      {/* Receivables row — outstanding / overdue / due-this-week */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Total outstanding"
          value={GBP.format(outstandingTotal)}
          href="/invoices?status=sent"
          sub={`${outstandingCount} unpaid ${outstandingCount === 1 ? "invoice" : "invoices"}`}
        />
        <Kpi
          label="Overdue"
          value={GBP.format(overdueTotal)}
          href="/invoices?status=overdue"
          sub={`${overdueCount} past due_date`}
        />
        <Kpi
          label="Due this week"
          value={GBP.format(dueThisWeekTotal)}
          href="/invoices?status=sent"
          sub={`${dueThisWeekCount} ${dueThisWeekCount === 1 ? "invoice" : "invoices"} in next 7 days`}
        />
        <Kpi
          label="Retention due back"
          value={GBP.format(retentionRollup.dueNow)}
          href="/jobs"
          sub={
            retentionRollup.totalHeld > 0
              ? `${GBP.format(retentionRollup.totalHeld)} held · ${retentionRollup.heldJobCount} ${retentionRollup.heldJobCount === 1 ? "job" : "jobs"}`
              : "no retention held"
          }
        />
      </section>

      {/* Cashflow row (Wave 3) — incoming + bank reconciliation status */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Cash in this month"
          value={GBP.format(cashInThisMonth)}
          href="/payments"
          sub={
            cashInFromBank > 0
              ? `${GBP.format(cashInFromBank)} via bank CSV`
              : "from recorded payments"
          }
        />
        <Kpi
          label="Expected incoming"
          value={GBP.format(expectedIncoming)}
          href="/invoices?status=sent"
          sub={`${outstandingCount} unpaid ${outstandingCount === 1 ? "invoice" : "invoices"}`}
        />
        <Kpi
          label="Bank matches to review"
          value={unmatchedSuggestions.toString()}
          href="/payments"
          sub={
            unmatchedSuggestions === 0
              ? "no suggestions waiting"
              : "confirm or pick a different invoice"
          }
        />
        <Kpi
          label="Tax estimates"
          value="VAT · Corp · PAYE"
          href="/tax"
          sub="quarterly + annual rollups"
        />
      </section>

      {/* Field-ops row (Wave 4) — hours, labour cost, payroll due */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Hours this week"
          value={`${teamHoursWeek.toFixed(1)} h`}
          href="/payroll"
          sub={`${teamHoursMonth.toFixed(1)} h this month`}
        />
        <Kpi
          label="Labour cost (week)"
          value={GBP.format(labourCostWeek)}
          href="/payroll"
          sub={`${GBP.format(labourCostMonth)} this month`}
        />
        <Kpi
          label="Payroll due (week)"
          value={GBP.format(payrollDueThisWeek)}
          href="/payroll"
          sub="net pay if you run weekly now"
        />
        <Kpi
          label="Staff dashboard"
          value="Clock in/out"
          href="/me"
          sub="hours, leave, earnings"
        />
      </section>

      {/* Profitability ----------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900">
          Job profitability
        </h2>
        {profitabilityRows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
            No jobs have revenue or costs yet. Link an invoice to a job
            (Invoice → Link to job) and log finances against the job (Finance
            → select job) to see profitability appear here.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label="Total profit this month"
                value={GBP.format(profitMonth)}
                href="/jobs"
                sub="revenue minus costs (excl VAT)"
              />
              <Kpi
                label="Average margin"
                value={avgMargin === null ? "—" : `${avgMargin}%`}
                href="/jobs"
                sub={`${profitabilityRows.length} ${profitabilityRows.length === 1 ? "job" : "jobs"} with revenue`}
              />
              <Kpi
                label="Best margin"
                value={
                  topProfitable[0]?.margin_pct !== null && topProfitable[0]?.margin_pct !== undefined
                    ? `${topProfitable[0].margin_pct}%`
                    : "—"
                }
                href={topProfitable[0] ? `/jobs/${topProfitable[0].job_id}` : "/jobs"}
                sub={
                  topProfitable[0]
                    ? `${jobNameById.get(topProfitable[0].job_id) ?? "—"}`
                    : ""
                }
              />
              <Kpi
                label="Worst margin"
                value={
                  worstMarginJobs[0]?.margin_pct !== null &&
                  worstMarginJobs[0]?.margin_pct !== undefined
                    ? `${worstMarginJobs[0].margin_pct}%`
                    : "—"
                }
                href={worstMarginJobs[0] ? `/jobs/${worstMarginJobs[0].job_id}` : "/jobs"}
                sub={
                  worstMarginJobs[0]
                    ? `${jobNameById.get(worstMarginJobs[0].job_id) ?? "—"}`
                    : ""
                }
              />
            </div>

            {/* Top + Worst tables */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <ProfitTable
                title="Top profitable jobs"
                rows={topProfitable}
                jobNameById={jobNameById}
              />
              <ProfitTable
                title="Worst-margin jobs"
                rows={worstMarginJobs}
                jobNameById={jobNameById}
              />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <ChartCard title="Profit by month (last 6)">
                <div className="space-y-2">
                  {profitSeries.map((b) => {
                    const widthPct = (Math.abs(b.profit) / profitChartMax) * 100;
                    const negative = b.profit < 0;
                    return (
                      <div key={b.month} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">{b.month}</span>
                          <span
                            className={
                              negative
                                ? "font-semibold text-red-700"
                                : "font-semibold text-slate-900"
                            }
                          >
                            {GBP.format(b.profit)}
                          </span>
                        </div>
                        <div className="mt-1 h-2 w-full overflow-hidden rounded bg-slate-100">
                          <div
                            className={
                              negative
                                ? "h-full bg-red-500"
                                : "h-full bg-green-500"
                            }
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ChartCard>
              <ChartCard title="Revenue vs cost (last 6 months)">
                <div className="space-y-3">
                  {profitSeries.map((b) => (
                    <div key={b.month} className="text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-600">{b.month}</span>
                        <span className="text-slate-500">
                          {GBP.format(b.revenue)} · {GBP.format(b.costs)}
                        </span>
                      </div>
                      <div className="mt-1 flex h-2 w-full gap-px">
                        <div
                          className="h-full rounded-l bg-blue-500"
                          style={{
                            width: `${(b.revenue / revCostChartMax) * 50}%`,
                          }}
                          title={`Revenue: ${GBP.format(b.revenue)}`}
                        />
                        <div
                          className="h-full rounded-r bg-orange-500"
                          style={{
                            width: `${(b.costs / revCostChartMax) * 50}%`,
                          }}
                          title={`Costs: ${GBP.format(b.costs)}`}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="flex gap-3 text-[11px] text-slate-500">
                    <span>
                      <span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500" />
                      Revenue
                    </span>
                    <span>
                      <span className="mr-1 inline-block h-2 w-2 rounded-full bg-orange-500" />
                      Costs
                    </span>
                  </div>
                </div>
              </ChartCard>
            </div>
          </>
        )}
      </section>

      {/* Approval workflow row (Wave 2) */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Pending approvals"
          value={pendingApprovalCount.toString()}
          href="/quotes?status=pending_approval"
          sub={pendingApprovalCount === 0 ? "all clear" : "awaiting owner/admin review"}
        />
        <Kpi
          label="Approved today"
          value={approvedTodayCount.toString()}
          href="/quotes?status=approved"
          sub="cleared the approval gate today"
        />
        <Kpi
          label="Rejected"
          value={rejectedCount.toString()}
          href="/quotes?status=rejected"
          sub="awaiting edit + resubmit"
        />
        <Kpi
          label="Quote conversion"
          value={conversionPct === null ? "—" : `${conversionPct}%`}
          href="/quotes"
          sub={
            conversionDecided === 0
              ? "no decisions yet"
              : `${conversionAccepted}/${conversionDecided} accepted`
          }
        />
      </section>

      {/* Quote analytics row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Pending quotes"
          value={pendingQuoteCount.toString()}
          href="/quotes?status=sent"
          sub="all in-flight (draft → viewed)"
        />
        <Kpi
          label="Accepted this month"
          value={GBP.format(acceptedThisMonthValue)}
          href="/quotes?status=accepted"
          sub={`${acceptedThisMonthCount} ${acceptedThisMonthCount === 1 ? "quote" : "quotes"}`}
        />
        <Kpi
          label="Avg quote value"
          value={GBP.format(avgQuoteValue)}
          href="/quotes"
          sub={`across ${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"}`}
        />
        <Kpi
          label="Total quote value"
          value={GBP.format(totalQuoteValue)}
          href="/quotes"
          sub="all-time"
        />
      </section>

      {/* Lead pipeline KPI row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Leads this month"
          value={leadsThisMonth.toString()}
          href="/leads"
          sub={`${allLeads.length} total`}
        />
        <Kpi
          label="Lead conversion"
          value={leadConversionPct === null ? "—" : `${leadConversionPct}%`}
          href="/leads"
          sub={
            leadDecided === 0
              ? "no decisions yet"
              : `${leadsWon}/${leadDecided} won`
          }
        />
        <Kpi
          label="Pipeline forecast"
          value={GBP.format(pipelineForecast)}
          href="/leads"
          sub="sum of open lead values"
        />
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Top sources
            </div>
            <Link
              href="/leads"
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              View all →
            </Link>
          </div>
          {topSources.length === 0 ? (
            <div className="mt-2 text-sm text-slate-500">
              No leads yet. <Link href="/leads/new" className="text-slate-700 underline">Add one</Link>
            </div>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {topSources.map(([src, agg]) => (
                <li key={src} className="flex items-center justify-between">
                  <Link
                    href={`/leads?source=${encodeURIComponent(src)}`}
                    className="text-slate-700 hover:text-slate-900 hover:underline"
                  >
                    {src}
                  </Link>
                  <span className="text-xs text-slate-500">
                    {agg.count}
                    {agg.won > 0 ? (
                      <span className="ml-1 font-medium text-green-700">
                        · {agg.won} won
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Status + photos + staff */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="Jobs by status" href="/jobs">
          <ul className="space-y-2">
            {JOB_STATUSES.map((s) => (
              <li key={s} className="flex items-center justify-between text-sm">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${JOB_STATUS_STYLES[s]}`}
                >
                  {s}
                </span>
                <span className="font-medium text-slate-900">
                  {jobsByStatus[s]}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Photos missing" href="/jobs">
          <p className="text-3xl font-bold text-slate-900">{photosMissing}</p>
          <p className="mt-2 text-xs text-slate-500">
            In-progress or completed jobs with zero photos. Field staff should
            add before/during/after shots.
          </p>
        </Card>

        <Card title="Staff workload" href="/staff">
          {staffWorkload.length === 0 ? (
            <p className="text-sm text-slate-500">
              No team members yet. <Link href="/staff" className="text-slate-700 underline">Add staff</Link>
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {staffWorkload.map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <Link
                    href={`/staff/${s.id}`}
                    className="truncate text-slate-700 hover:text-slate-900 hover:underline"
                  >
                    {s.name}
                  </Link>
                  <span className="ml-3 shrink-0 text-xs text-slate-500">
                    <span className="font-medium text-slate-900">{s.active}</span> active ·{" "}
                    <span className="font-medium text-slate-900">{s.done}</span> done
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Recent activity */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card title="Recent jobs" href="/jobs">
          {recentJobs.length === 0 ? (
            <p className="text-sm text-slate-500">No jobs yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {recentJobs.map((j) => (
                <li key={j.id} className="flex items-center justify-between py-1.5">
                  <Link
                    href={`/jobs/${j.id}`}
                    className="truncate text-slate-700 hover:text-slate-900"
                  >
                    {j.customer?.name ?? "—"}
                  </Link>
                  <span
                    className={`ml-3 shrink-0 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${JOB_STATUS_STYLES[j.status as JobStatus] ?? "bg-slate-100 text-slate-700"}`}
                  >
                    {j.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent invoices" href="/invoices">
          {recentInvoices.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {recentInvoices.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between py-1.5">
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="truncate font-medium text-slate-700 hover:text-slate-900"
                  >
                    {inv.number}
                  </Link>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {GBP.format(Number(inv.total ?? 0))}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLES[inv.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {inv.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent leads" href="/leads">
          {leads.length === 0 ? (
            <p className="text-sm text-slate-500">
              No leads yet. <Link href="/leads/new" className="text-slate-700 underline">Add one</Link>
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {leads.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-1.5">
                  <Link href={`/leads/${l.id}`} className="min-w-0 flex-1 hover:underline">
                    <div className="truncate text-slate-700">
                      {l.customer?.name ?? "—"}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {l.service ?? "—"}
                    </div>
                  </Link>
                  <span className="ml-3 shrink-0 text-xs font-medium text-slate-500">
                    {l.urgency ?? l.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Slice 6 — Insights (deterministic). Above the activity feed
          because warnings/trends are higher-value than the chronological
          log for daily owner-coffee viewing. */}
      <InsightsSection activity={activityInsights} leads={leadInsights} />

      {/* Activity feed — last section so it can grow with "Load more" */}
      <ActivityFeed initial={activity} initialHasMore={activityHasMore} />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
      {sub ? (
        <div className="mt-1 text-xs text-slate-500 truncate">{sub}</div>
      ) : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function Card({
  title,
  href,
  children,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {href ? (
          <Link
            href={href}
            className="text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            View all →
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function ProfitTable({
  title,
  rows,
  jobNameById,
}: {
  title: string;
  rows: JobProfitability[];
  jobNameById: Map<string, string>;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No jobs with revenue yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const name = jobNameById.get(r.job_id) ?? r.job_id.slice(0, 8);
            const band = marginBand(r.margin_pct);
            return (
              <li key={r.job_id} className="flex items-center gap-3 py-2">
                <Link
                  href={`/jobs/${r.job_id}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 hover:underline"
                >
                  {name}
                </Link>
                <div className="text-right text-xs text-slate-600">
                  <div className="text-sm font-semibold text-slate-900">
                    {GBP.format(r.gross_profit)}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    rev {GBP.format(r.revenue)} · cost {GBP.format(r.costs_total)}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${marginPillClass(band)}`}
                >
                  {r.margin_pct === null ? "—" : `${r.margin_pct}%`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FirstRun({ userEmail, orgName }: { userEmail: string; orgName: string }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          Welcome to CrewFlow, {orgName}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Signed in as {userEmail}. Let&apos;s get the basics in so you can
          start running jobs.
        </p>
      </header>

      <ol className="space-y-3">
        <FirstRunStep
          n={1}
          title="Add your first customer"
          href="/customers/new"
          cta="Add customer"
        >
          Name, email, phone — that&apos;s enough to start. You can add jobs
          and invoices to them once they exist.
        </FirstRunStep>
        <FirstRunStep
          n={2}
          title="Create your first job"
          href="/jobs/new"
          cta="Create job"
        >
          Pick the customer, assign a staff member, set a status and date.
          Field staff can attach photos later.
        </FirstRunStep>
        <FirstRunStep
          n={3}
          title="Log your first expense"
          href="/finances/new"
          cta="Add finance entry"
        >
          Receipts, materials, fuel, labour. VAT is computed automatically.
        </FirstRunStep>
        <FirstRunStep
          n={4}
          title="Generate your first invoice"
          href="/invoices/new"
          cta="Generate invoice"
        >
          Once you have a quote, generate a sequential HMRC-compliant invoice
          straight from it.
        </FirstRunStep>
      </ol>
    </div>
  );
}

function FirstRunStep({
  n,
  title,
  children,
  href,
  cta,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  href: string;
  cta: string;
}) {
  return (
    <li className="flex items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
        {n}
      </span>
      <div className="flex-1">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-xs text-slate-600">{children}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
      >
        {cta}
      </Link>
    </li>
  );
}
