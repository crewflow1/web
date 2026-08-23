import { Suspense } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { getRequestI18n } from "@/server/i18n/request";
import { computeReceivables } from "@/lib/invoices/receivables";
import { computeRetentionDueRollup } from "@/lib/retentions/rollup";
import { loadOrgHourlyPay } from "@/lib/profitability/labour-rates";
import { ActivityFeed } from "./_activity-feed";
import type { ActivityRow } from "@/lib/activity/render";
import { InsightsSection } from "./_insights";
import { SetupChecklist } from "./_setup-checklist";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import { buildRetentionSnapshot } from "@/server/services/retention-snapshot";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";
import { after } from "next/server";
import { ensureMilestoneNotifications } from "@/server/services/retention-milestones";
import { RetentionPanel } from "./_retention";
import { DailyBriefing } from "./_daily-briefing";
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
  type JobProfitability,
} from "@/lib/profitability/compute";
import {
  buildJobCostInput,
  windowHoursSource,
} from "@/lib/profitability/job-cost-input";
import {
  hoursInWindow,
  startOfWeekIso,
  addDaysIso,
  type TimeEntry,
} from "@/lib/time/compute";
import {
  computePayrollLine,
  employerCostsForStoredLine,
} from "@/lib/payroll/compute";
import { getPayrollTaxProfilesForOrg } from "@/server/services/payroll-tax-profile";
import { loadStockCogsCostRows, type StockClient } from "@/server/services/stock";
import {
  computeVatQuarter,
  endOfQuarterExclusiveIso,
  resolveFlatRateForPeriod,
} from "@/lib/tax/compute";
import { readOrgSettings } from "@/lib/org-config/service";

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
  // Resolve the request ONCE: org context + the negotiated active locale (from
  // organizations.locale, else en-GB). `t` renders the dashboard chrome —
  // byte-identical for en-GB, per-key fallback for other locales.
  const { user, ctx, t } = await getRequestI18n();
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

  // Fetch everything in parallel. RLS is the OUTER boundary, not the scope:
  // `current_org_ids()` returns EVERY org the viewer belongs to, so an
  // unpinned read makes EVERY tile on this page — job counts, revenue,
  // profitability, pipeline value, team, payroll cost — the SUM of both of a
  // dual-org owner's companies. Each read below is pinned to the ACTIVE org.
  const ACTIVITY_PAGE_SIZE = 25;
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Retention read types — declared up-front so the concurrent retention wave
  // below can reference them. The `jobs` retention columns + retention_releases
  // aren't in the generated Supabase types yet; the reads cast through these.
  type RetTermsRow = {
    id: string;
    retention_percent: number | string | null;
    practical_completion_date: string | null;
    defects_liability_months: number | string | null;
    retention_first_release_pct: number | string | null;
  };
  type RetRelRow = { job_id: string | null; amount: number | string | null };
  type Paged<T> = {
    eq: (k: string, v: unknown) => Paged<T>;
    order: (k: string, o: { ascending: boolean }) => {
      range: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
    };
  };

  // PERF (product UX finalisation): every read wave fires CONCURRENTLY.
  //
  // RLS is the OUTER boundary, not the scope: `current_org_ids()` returns EVERY
  // org the viewer belongs to, so each read below is pinned to the ACTIVE org
  // (else a dual-org owner's tiles would SUM both companies). These five waves
  // have NO data dependency on one another — each needs only ctx.org.id + a date
  // bound — so we START them all, then await them together. That collapses what
  // were FIVE sequential Supabase round-trip waves (the dashboard's dominant
  // real-world latency: 80+ queries × per-query RTT, cheap locally but seconds on
  // Vercel↔Supabase) into ONE overlapped wave. Every downstream figure — cash,
  // receivables, VAT inputs, retention — is computed from the SAME rows as
  // before, just fetched in parallel: no value changes, nothing cached, money/VAT
  // stay live. PAGED + LOUD (F-1) money reads still THROW on error (checked below).
  const coreWave = Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("jobs")
        .select(
          "id, status, scheduled_date, photos, assigned_to, created_at, customer:customers ( id, name )",
        )
        .eq("org_id", ctx.org.id)
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
        .eq("org_id", ctx.org.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("finances")
        .select("id, amount, vat_total, created_at, category, job_id")
        .eq("org_id", ctx.org.id)
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
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("memberships")
      .select("user_id, role, user:users ( id, full_name, email )")
      .eq("org_id", ctx.org.id),
    fetchAllRows((from, to) =>
      supabase
        .from("quotes")
        .select("id, status, total, accepted_at, created_at, approved_at")
        .eq("org_id", ctx.org.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("leads")
        .select("id, status, source, estimated_value, created_at")
        .eq("org_id", ctx.org.id)
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
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(0, ACTIVITY_PAGE_SIZE - 1),
  ]);

  // Payment + reconciliation rollups. The cash-in tile SUMS every payment this
  // month; the reconciliation tile COUNTS every suggested bank line; the
  // receivables tiles NET each invoice (total − Σ payments) so they need the
  // WHOLE payment ledger, not a monthly slice. All PAGED (fetchAllRows) + LOUD.
  const paymentsWave = Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("invoice_payments")
        .select("id, amount, paid_at, source")
        .eq("org_id", ctx.org.id)
        .gte("paid_at", monthStart.slice(0, 10))
        .order("paid_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("bank_statement_lines")
        .select("id, amount, posted_at")
        .eq("org_id", ctx.org.id)
        .eq("match_status", "suggested")
        .order("posted_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from("invoice_payments")
        .select("invoice_id, amount")
        .eq("org_id", ctx.org.id)
        .order("invoice_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // Time + payroll rollups (last 30 days of time entries covers the week/month tiles).
  const timeWave = Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("time_entries")
        .select("id, user_id, job_id, started_at, ended_at, breaks")
        .eq("org_id", ctx.org.id)
        .gte("started_at", thirtyDaysAgoIso)
        .order("started_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Per-user hourly pay for the payroll tiles — via the shared reader, now
    // sourced from staff_compensation (20261218, self-or-admin RLS). Owner/admin
    // dashboard context reads every member's rate → identical map as before.
    loadOrgHourlyPay(supabase, ctx.org.id),
  ]);

  // Contract retention "due back" (Programme C) — held retention + what's due for
  // release, PAGED + cast (retention columns not yet in the generated types).
  // Order by the UNIQUE primary key so fetchAllRows has a stable total order.
  const retentionWave = Promise.all([
    fetchAllRows<RetTermsRow>((from, to) =>
      (supabase.from("jobs" as never) as unknown as { select: (c: string) => Paged<RetTermsRow> })
        .select("id, retention_percent, practical_completion_date, defects_liability_months, retention_first_release_pct")
        .eq("org_id", ctx.org.id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<RetRelRow>((from, to) =>
      (supabase.from("retention_releases" as never) as unknown as { select: (c: string) => Paged<RetRelRow> })
        .select("job_id, amount")
        .eq("org_id", ctx.org.id)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // Deterministic insight payloads + the onboarding snapshot (built ONCE and
  // shared with the retention snapshot, de-duping an org-row fetch + 5 counts).
  // LLM prose lands later when a model key is added to Vercel.
  const onboardingSnapshotPromise = buildOnboardingSnapshot(ctx.org.id);
  const insightsWave = Promise.all([
    computeActivitySummary(ctx.org.id, 7),
    computeLeadInsights(ctx.org.id, 30),
    onboardingSnapshotPromise,
    buildRetentionSnapshot(ctx.org.id, { onboarding: onboardingSnapshotPromise }),
  ]);

  // ONE overlapped await — every wave is already in flight; Promise.all here just
  // collects them, so a rejection in any wave is still awaited (no orphan).
  const [
    [jobsRes, invoicesRes, financesRes, leadsRecentRes, membersRes, quotesRes, leadsAllRes, activityRes],
    [paymentsRes, unmatchedRes, allPaymentsRes],
    [{ data: timeEntriesRaw }, payHourlyByUser],
    [retentionJobsRes, retentionReleasesRes],
    [activityInsights, leadInsights, onboardingSnapshot, retentionSnapshot],
  ] = await Promise.all([coreWave, paymentsWave, timeWave, retentionWave, insightsWave]);

  // Money reads are LOUD: an errored payment/reconciliation read must never
  // render as a reassuring low number — throw rather than `?? []`.
  if (paymentsRes.error)
    throw readFailure("dashboard: invoice payments (cash-in)", paymentsRes.error);
  if (unmatchedRes.error)
    throw readFailure("dashboard: unmatched bank lines", unmatchedRes.error);
  if (allPaymentsRes.error)
    throw readFailure("dashboard: invoice payments (receivables netting)", allPaymentsRes.error);
  const paymentsThisMonth = paymentsRes.data;
  const unmatchedLines = unmatchedRes.data;
  // Per-invoice paid map for netting the receivables tiles.
  const paidByInvoice = new Map<string, number>();
  for (const p of allPaymentsRes.data ?? []) {
    const row = p as unknown as { invoice_id: string | null; amount: number | string | null };
    if (!row.invoice_id) continue;
    paidByInvoice.set(
      row.invoice_id,
      (paidByInvoice.get(row.invoice_id) ?? 0) + Number(row.amount ?? 0),
    );
  }

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

  // Retention rollup reuses the same per-job derivation as the job page so the
  // numbers agree; it needs `invoices` (above), hence it's computed here rather
  // than inside the wave.
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

  // Phase 2 — fire the milestone notification + audit-log side
  // effects for any newly-crossed milestones. Best-effort; idempotent
  // via onboarding_state.notified_milestones. Errors are swallowed
  // so a transient DB blip can't break the dashboard.
  // PERF (product UX rebuild): a best-effort, idempotent side-effect
  // (notifications + audit-log inserts) whose result the render never reads. Run
  // it via after() so it fires once the response has streamed, off the landing
  // page's critical path. Semantics unchanged — still every load, still
  // idempotent via onboarding_state.notified_milestones, still error-swallowing.
  after(() =>
    ensureMilestoneNotifications(ctx.org.id, retentionSnapshot, {
      id: user.id,
      email: user.email ?? null,
    }),
  );

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
  for (const inv of invoices) {
    // M1: this tile is an accrual ("invoiced") figure keyed off created_at, NOT
    // an inv.status === "paid" sum. A mis-marked or synthetic invoice (status
    // "paid" with no invoice_payments rows) used to inflate "Revenue this month"
    // to figures that money-in never backs. Cash actually collected is tracked
    // separately via cashInThisMonth (sum of invoice_payments).
    if (inv.created_at && inv.created_at >= monthStart) {
      invoicedThisMonth += Number(inv.total ?? 0);
    }
  }

  // Receivables — Outstanding / Overdue / Due-this-week / Expected-incoming — go
  // through the ONE shared authority (lib/invoices/receivables). It gates on the
  // canonical OUTSTANDING_STATUSES (sent · awaiting_payment · partially_paid ·
  // overdue) and NETS each invoice's balance against the payment ledger
  // (max(0, total − Σ payments)). The old inline gate admitted only
  // `sent`/`overdue` and summed GROSS `total`, so a £10k invoice with a £3k
  // deposit (trigger-stamped `partially_paid`) vanished from Outstanding yet was
  // counted overdue at its full £10k — three tiles that disagreed with each
  // other and with /cash. This authority makes Outstanding a true superset of
  // Overdue and reconciles with /cash Collectable-now and the customer portal.
  const receivables = computeReceivables(
    invoices.map((inv) => ({
      status: inv.status,
      total: inv.total,
      due_date: inv.due_date,
      paid: paidByInvoice.get(inv.id) ?? 0,
    })),
  );
  const {
    outstandingTotal,
    outstandingCount,
    overdueTotal,
    overdueCount,
    dueThisWeekTotal,
    dueThisWeekCount,
  } = receivables;

  // VAT this quarter — the SINGLE authority (lib/tax/compute.ts). Output VAT
  // (paid invoices) and input VAT (logged finance rows) are BOTH gated to the
  // current quarter [quarterStart, endOfQuarterExclusive). The 6-month finances
  // window loaded above contains the current quarter; computeVatQuarter applies
  // its own in-period gate, so the earlier quarters in that window are excluded
  // from the input leg (they previously understated net VAT owed).
  // Output VAT is CASH-basis from the invoice_payments LEDGER (partial payments
  // included on the day the cash landed) and domestic reverse-charge VAT is
  // self-accounted into boxes 1 AND 4 (net-neutral) — both from the ONE paged
  // read layer the /tax tile, the PDF and the frozen HMRC return share.
  const quarterEndExclusive = endOfQuarterExclusiveIso(quarterStart);
  // Scheme (cash/standard) + FRS come from org_settings so the dashboard tile
  // reconciles with /tax, the PDF and the frozen return. LOUD read: a config error
  // must not silently fall back to a divergent basis. Cash + disabled FRS ⇒ inert.
  const dashOrgSettings = await readOrgSettings(supabase, ctx.org.id);
  const vatInputs = await gatherVatQuarterInputs(
    supabase as unknown as VatInputsDb,
    ctx.org.id,
    quarterStart,
    quarterEndExclusive,
    dashOrgSettings.vat_scheme,
  );
  const vat = computeVatQuarter(
    vatInputs.invoicePayments,
    finances,
    quarterStart,
    quarterEndExclusive,
    vatInputs.reverseCharge.vat,
    {
      scheme: dashOrgSettings.vat_scheme,
      accrualInvoices: vatInputs.accrualInvoices,
      flatRate: resolveFlatRateForPeriod(dashOrgSettings.flat_rate_config, quarterStart),
      // CF-1: cash-scheme box 4 is payment-based (supplier-payment ledger); undefined
      // under standard ⇒ accrual.
      supplierPayments: vatInputs.supplierPayments,
      reverseChargeNet: vatInputs.reverseCharge.net,
    },
  );

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

  // Per-user hourly rate for the labour cost roll-up (from staff_compensation via
  // loadOrgHourlyPay — same Map<userId, rate> as the former memberships→users read).
  const hourlyByUser = payHourlyByUser;
  // Per-user annual salary sacrifice (£) — outside the employer NI + pension base, so
  // it lowers the TRUE cost of employment. Empty map ⇒ no sacrifice, figures unchanged.
  const taxProfiles = await getPayrollTaxProfilesForOrg(ctx.org.id);
  const sacrificeByUser = new Map<string, number>();
  for (const [uid, p] of taxProfiles) {
    const pounds = Number(p.salary_sacrifice_annual_pence ?? 0) / 100;
    if (pounds > 0) sacrificeByUser.set(uid, pounds);
  }

  // Hours per user per window. Employer NI is BANDED on the person's whole-period
  // earnings, so labour cost has to be summed per worker and not per time entry —
  // per-entry accumulation would hand each entry its own secondary threshold.
  const hoursByUserThisWeek = new Map<string, number>();
  const hoursByUserThisMonth = new Map<string, number>();
  for (const e of timeEntries) {
    const weekHrs = hoursInWindow([e], weekStartDate, weekEndDate);
    if (weekHrs > 0) {
      hoursByUserThisWeek.set(
        e.user_id,
        (hoursByUserThisWeek.get(e.user_id) ?? 0) + weekHrs,
      );
    }
    const monthHrs = hoursInWindow([e], monthStartDate, monthEndDate);
    if (monthHrs > 0) {
      hoursByUserThisMonth.set(
        e.user_id,
        (hoursByUserThisMonth.get(e.user_id) ?? 0) + monthHrs,
      );
    }
  }

  // Org-wide labour cost — the TRUE cost of employment (gross + employer NI +
  // employer pension), not gross alone. Gross-only understated what staff actually
  // cost and made every margin built on it look better than it is.
  let labourCostWeek = 0;
  let labourCostMonth = 0;
  for (const [uid, hours] of hoursByUserThisWeek) {
    const rate = hourlyByUser.get(uid) ?? 0;
    if (rate <= 0) continue;
    // Salary sacrifice (if any) reduces the employer NI + pension base — the cost of
    // employment is priced through the shared, sacrifice-aware helper.
    labourCostWeek += employerCostsForStoredLine(
      hours * rate,
      "weekly",
      weekStartIsoDate,
      sacrificeByUser.get(uid),
    ).employment_cost_estimate;
  }
  for (const [uid, hours] of hoursByUserThisMonth) {
    const rate = hourlyByUser.get(uid) ?? 0;
    if (rate <= 0) continue;
    labourCostMonth += employerCostsForStoredLine(
      hours * rate,
      "monthly",
      monthStart.slice(0, 10),
      sacrificeByUser.get(uid),
    ).employment_cost_estimate;
  }
  labourCostWeek = Math.round(labourCostWeek * 100) / 100;
  labourCostMonth = Math.round(labourCostMonth * 100) / 100;

  // Estimated payroll-due for the current week — NET pay only. This is what leaves
  // the bank TO THE WORKERS, so employer NI (payable to HMRC by the 22nd of the
  // following month) and employer pension (payable to the provider) are correctly
  // NOT in this figure. They are separate cash movements on separate dates.
  let payrollDueThisWeek = 0;
  for (const [uid, hours] of hoursByUserThisWeek) {
    const rate = hourlyByUser.get(uid) ?? 0;
    if (rate <= 0) continue;
    const c = computePayrollLine(hours, rate, "weekly", weekStartIsoDate);
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
  // Expected incoming = the netted outstanding pool (total − Σ payments over the
  // canonical OUTSTANDING statuses), straight from the receivables authority.
  const expectedIncoming = receivables.expectedIncoming;

  // ---- profitability ---------------------------------------------------
  // Per-job rollup. Invoices contribute revenue via job_id; finances
  // contribute costs via job_id. Jobs with neither don't appear.
  //
  // The cost input is the SHARED composition `[...finances, ...labour,
  // ...employerOnCosts]` (see `@/lib/profitability/job-cost-input`): time-tracked
  // labour (gross) PLUS employer NI + employer pension on those hours, each a
  // virtual `labour`-tagged finance row. Without them the labour bucket held GROSS
  // pay only, so gross profit and margin were overstated on every job with direct
  // labour. Employer NI is banded on the worker's whole-period earnings, so the
  // builder computes it per person and apportions across their jobs by hours.
  //
  // The dashboard's labour/margin tiles are a MONTH view, so it measures hours over
  // the month window. The per-job commercial surfaces use job-lifetime hours from
  // the SAME builder — the one composition, two scopes.
  // Stock COGS: the weighted-average cost of stock issued to each job, an
  // allocation stream disjoint from `finances` (stock issues post no `finances`
  // row), so the per-job leaderboard's cost includes stock drawn from the depot
  // exactly once — the same stream the per-job pages, reports and company-health
  // compose. SCOPE: job-lifetime (all issues to the job, net of corrections),
  // matching this leaderboard's all-time invoices/revenue basis. It is NOT added
  // to the `profitByMonth` / `totalProfitThisMonth` tiles, which read `finances`
  // directly as the company GL — COGS is a management overlay, never a GL posting.
  const dashboardStockCogs = await loadStockCogsCostRows(
    supabase as unknown as StockClient,
    ctx.org.id,
  );
  const dashboardCostInput = buildJobCostInput({
    finances,
    timeEntries,
    hourlyByUser,
    hoursForEntries: windowHoursSource(monthStartDate, monthEndDate),
    cycle: "monthly",
    periodStartIso: monthStart.slice(0, 10),
    sacrificeByUser,
    stockCogs: dashboardStockCogs,
  });
  const profitabilityRows: JobProfitability[] = computeAllJobsProfitability(
    jobs,
    invoices,
    dashboardCostInput,
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
          <h1 className="text-2xl font-bold text-slate-900">{t("dashboard.title")}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {t("dashboard.subtitle", { orgName: ctx.org.name })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            href="/leads/new"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("dashboard.action.add_lead")}
          </Link>
          <Link
            href="/jobs/new"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("dashboard.action.add_job")}
          </Link>
          <Link
            href="/staff"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("dashboard.action.add_staff")}
          </Link>
        </div>
      </header>

      {/* Daily Briefing — the first thing an owner sees: "what needs you today".
          Composes existing live signals (money · safety · operations · sales)
          into a ranked, deep-linked, per-user-dismissible attention feed.
          PERF (product UX finalisation): it fans out ~50 reads, so it now STREAMS
          behind Suspense — its cost no longer blocks the KPI grid's first paint.
          The skeleton reserves an approximate footprint; the real briefing height
          varies (calm all-clear ~120px, a full feed 300px+), so there is a small,
          bounded layout shift when it streams in — the accepted trade for painting
          the KPI grid without waiting on the briefing. */}
      <Suspense
        fallback={
          <div
            className="rounded-lg border border-slate-200 bg-white p-4"
            aria-hidden
          >
            <div className="mb-3 h-4 w-44 rounded bg-slate-100" />
            <div className="space-y-2">
              <div className="h-14 rounded-md bg-slate-50" />
              <div className="h-14 rounded-md bg-slate-50" />
              <div className="h-14 rounded-md bg-slate-50" />
            </div>
          </div>
        }
      >
        <DailyBriefing orgId={ctx.org.id} userId={user.id} />
      </Suspense>

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
          href="/invoices?status=outstanding"
          sub={`${outstandingCount} ${outstandingCount === 1 ? "invoice" : "invoices"}`}
        />
        <Kpi
          label="VAT this quarter"
          value={GBP.format(vat.net_payable)}
          href="/finances"
          sub={`output ${GBP.format(vat.output_vat)} − input ${GBP.format(vat.input_vat)}`}
        />
      </section>

      {/* Receivables row — outstanding / overdue / due-this-week */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Total outstanding"
          value={GBP.format(outstandingTotal)}
          href="/invoices?status=outstanding"
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
          href="/invoices?status=outstanding"
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
          href="/invoices?status=outstanding"
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
          sub={`${GBP.format(labourCostMonth)} this month · est. incl. employer NI + pension`}
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
          {t("dashboard.section.profitability")}
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
        <Card title={t("dashboard.card.jobs_by_status")} href="/jobs">
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

        <Card title={t("dashboard.card.photos_missing")} href="/jobs">
          <p className="text-3xl font-bold text-slate-900">{photosMissing}</p>
          <p className="mt-2 text-xs text-slate-500">
            In-progress or completed jobs with zero photos. Field staff should
            add before/during/after shots.
          </p>
        </Card>

        <Card title={t("dashboard.card.staff_workload")} href="/staff">
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
        <Card title={t("dashboard.card.recent_jobs")} href="/jobs">
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

        <Card title={t("dashboard.card.recent_invoices")} href="/invoices">
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

        <Card title={t("dashboard.card.recent_leads")} href="/leads">
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
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-xl sm:text-2xl font-bold text-slate-900 truncate tabular-nums">
        {value}
      </div>
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
          cta="Add cost"
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
