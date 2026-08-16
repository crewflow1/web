import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { reportReadFailure, readFailure } from "@/lib/supabase/read-failure";
import { formatDayKeyUK } from "@/lib/time/format";
import { isCollectableStatus } from "@/lib/invoices/overdue";
import { addDays, ukDayStartMs } from "@/lib/schedule/window";
import { round2, toPounds } from "@/lib/money";
import { endOfQuarterExclusiveIso } from "@/lib/tax/compute";
import { computeRetentionPosition } from "@/lib/retentions/compute";
import { computeRetentionSchedule, addMonths } from "@/lib/retentions/schedule";
import {
  buildOrgCashOut,
  cashOutVisibleToRole,
} from "@/server/services/org-cash-out";
import {
  computeCashTimeline,
  type CashEvent,
  type CashTimeline,
} from "@/lib/intelligence/cash-timeline";
import {
  computeLabourForecast,
  type LabourForecast,
  type LabourMember,
  type LabourShift,
} from "@/lib/intelligence/labour-forecast";
import {
  computeDelayRiskBoard,
  type DelayRiskBoard,
} from "@/lib/intelligence/delay-risk";
import {
  computeCommercialRiskBoard,
  type CommercialRiskBoard,
} from "@/lib/intelligence/commercial-risk";
import {
  computeCustomerLtvForecast,
  type CustomerLtvForecast,
  type LtvForecastInvoice,
  type LtvForecastActivity,
} from "@/lib/health/customer-ltv-forecast";
import type { CompanySignalsView } from "@/server/services/intelligence";

/**
 * FORECASTING — the read layer for the deterministic FORWARD intelligence.
 * FETCHES AND COMPOSES; decides nothing. Every threshold, clamp and label lives
 * in lib/intelligence/** (pure, unit-tested); every settled money figure comes
 * from the authority that owns it (the cash-out summary, the retention position/
 * schedule, the invoice payment ledger). ZERO new tables, ZERO migrations.
 *
 * READ-ONLY BY CONSTRUCTION. No `.insert/.update/.upsert/.delete/.rpc` appears
 * here and none may be added — a forecast surface that could write would be a
 * second, unaudited path into the ledgers it observes (the intelligence
 * doctrine). Pinned by __tests__/security/forecasting-source.test.ts.
 *
 * ACTIVE-ORG PINNED. Every table read carries `.eq("org_id", orgId)` on top of
 * RLS: `current_org_ids()` admits EVERY org the viewer belongs to, so an
 * unpinned read BLENDS a dual-org member's two companies. The ONE exception is
 * `users` (global profile table, no org_id column), reached ONLY through
 * `.in("id", memberIds)` from this org's `memberships` read.
 *
 * LOUD READS, PER GROUP. Each group computes WHOLE or fails WHOLE: a partial
 * invoice/payment ledger is a wrong cash timeline. Gathers throw `readFailure`
 * and `loadForecasts` catches PER GROUP — the failed card renders an explicit
 * error block, the rest stand. A failed read never renders as an empty figure.
 *
 * FORWARD, NOT POINT-IN-TIME. This composes the existing cash/utilisation
 * authorities but answers a different question — WHEN money and labour land over
 * the coming weeks, and where the recorded signals say the risk is. The point-in-
 * time position stays in /cash and /insights company signals.
 *
 * MANAGEMENT-GATED. VAT, CIS and supplier payables are admin-only at RLS, so the
 * cash timeline's OUTFLOWS are only complete for a manager. `loadForecasts` takes
 * the viewer's role and refuses to draw a cash timeline for a role that cannot
 * see the outflow side — a half-a-ledger forecast would understate the shortfall,
 * the one thing this surface must never do silently. The caller gates rendering
 * with `cashOutVisibleToRole`.
 */

// ---------------------------------------------------------------------------
// Loose client shim (several tables post-date the generated types)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  in: (k: string, v: readonly unknown[]) => Builder;
  is: (k: string, v: unknown) => Builder;
  gte: (k: string, v: unknown) => Builder;
  lte: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

export type ForecastingClient = { from: (t: string) => Builder };

const sv = (v: unknown) => (v == null ? null : String(v));

/** Throwing wrapper over fetchAllRows: full set or a loud failure. */
async function allRows(
  context: string,
  build: (from: number, to: number) => PromiseLike<PageResult<Row>>,
): Promise<Row[]> {
  const { data, error } = await fetchAllRows<Row>(build);
  if (error) {
    throw readFailure(context, error as { message?: string | null; code?: string | null });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many weeks the cash timeline and labour forecast project (one quarter). */
export const FORECAST_HORIZON_WEEKS = 13;

/** Calendar weeks per period, for spreading a recurring budget evenly. */
const WEEKS_PER_PERIOD: Record<string, number> = {
  monthly: 4.345,
  quarterly: 13.036,
  annual: 52.143,
};

// ---------------------------------------------------------------------------
// Group: cash timeline
// ---------------------------------------------------------------------------

/**
 * The VAT payment deadline for the quarter starting `quarterStartIso`: HMRC's
 * "one calendar month plus 7 days after the period END" (electronic). Derived
 * from the SAME quarter boundary the tax authority uses, so the placed outflow
 * lands on the date the tax page shows.
 */
export function vatPaymentDeadline(quarterStartIso: string): string {
  const exclusiveEnd = endOfQuarterExclusiveIso(quarterStartIso); // first day of next quarter
  const endInclusive = addDays(exclusiveEnd.slice(0, 10), -1);
  return addDays(addMonths(endInclusive, 1), 7);
}

export async function gatherCashTimeline(
  db: ForecastingClient,
  orgId: string,
  now: Date,
  todayKey: string,
): Promise<CashTimeline> {
  const events: CashEvent[] = [];

  // --- Inflows: outstanding invoices, dated by due_date, remaining after payments ---
  const invoices = await allRows("forecasting: invoices", (from, to) =>
    db
      .from("invoices")
      .select("id, number, status, amount, total, due_date, job_id")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const invoiceIds = invoices.map((i) => String(i.id));
  const payments =
    invoiceIds.length === 0
      ? []
      : await allRows("forecasting: invoice payments", (from, to) =>
          db
            .from("invoice_payments")
            .select("invoice_id, amount")
            .eq("org_id", orgId)
            .order("invoice_id", { ascending: true })
            .range(from, to),
        );
  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    const key = sv(p.invoice_id);
    if (!key) continue;
    paidByInvoice.set(key, round2((paidByInvoice.get(key) ?? 0) + toPounds(p.amount as number)));
  }

  for (const inv of invoices) {
    if (!isCollectableStatus(sv(inv.status))) continue;
    const total = round2(toPounds(inv.total as number));
    const paid = paidByInvoice.get(String(inv.id)) ?? 0;
    const remaining = round2(Math.max(0, total - paid));
    if (remaining <= 0) continue;
    events.push({
      dateKey: sv(inv.due_date),
      direction: "in",
      amount: remaining,
      category: "Invoice due",
      certainty: "invoiced",
      label: sv(inv.number) ?? "Invoice",
      href: `/invoices/${String(inv.id)}`,
    });
  }

  // --- Inflows: retention release schedule, per job, dated by moiety due date ---
  const jobs = await allRows("forecasting: jobs", (from, to) =>
    db
      .from("jobs")
      .select(
        "id, retention_percent, practical_completion_date, defects_liability_months, " +
          "retention_first_release_pct, site_address_line1, site_city, site_postcode",
      )
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const releases = await allRows("forecasting: retention releases", (from, to) =>
    db
      .from("retention_releases")
      .select("job_id, amount")
      .eq("org_id", orgId)
      .order("job_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  // Invoice net amounts and releases grouped by job for the retention position.
  const invByJob = new Map<string, Array<{ status: string; amount: number | string | null }>>();
  for (const inv of invoices) {
    const jobId = sv(inv.job_id);
    if (!jobId) continue;
    const list = invByJob.get(jobId) ?? [];
    list.push({ status: String(inv.status ?? ""), amount: inv.amount as number | string | null });
    invByJob.set(jobId, list);
  }
  const relByJob = new Map<string, Array<{ amount: number | string | null }>>();
  for (const r of releases) {
    const jobId = sv(r.job_id);
    if (!jobId) continue;
    const list = relByJob.get(jobId) ?? [];
    list.push({ amount: r.amount as number | string | null });
    relByJob.set(jobId, list);
  }

  for (const job of jobs) {
    const jobId = String(job.id);
    const position = computeRetentionPosition({
      ratePercent: job.retention_percent as number | string | null,
      invoices: invByJob.get(jobId) ?? [],
      releases: relByJob.get(jobId) ?? [],
    });
    if (!position.isActive || position.held <= 0) continue;
    const schedule = computeRetentionSchedule({
      position,
      practicalCompletionDate: sv(job.practical_completion_date),
      defectsLiabilityMonths: Number(job.defects_liability_months ?? 12),
      firstReleasePct: Number(job.retention_first_release_pct ?? 50),
      now,
    });
    const label = siteLabel(job);
    for (const m of schedule.moieties) {
      if (m.remaining <= 0 || m.status === "released") continue;
      events.push({
        dateKey: m.dueDate, // null when no PC date → carried in the undated pool
        direction: "in",
        amount: m.remaining,
        category: "Retention release",
        certainty: "scheduled",
        label: `${m.label}${label ? ` · ${label}` : ""}`,
        href: `/jobs/${jobId}`,
      });
    }
  }

  // --- Outflows: VAT + CIS (from the money-out authority) + recurring budgets ---
  const cashOut = await buildOrgCashOut(orgId, { now });
  if (cashOut.loadError) {
    // A cash timeline missing its outflows understates the shortfall — fail whole.
    throw readFailure("forecasting: cash outflows", { message: "cash-out read failed" });
  }
  const s = cashOut.summary;

  if (s.vatDue > 0 && s.vatQuarterStart) {
    events.push({
      dateKey: vatPaymentDeadline(s.vatQuarterStart),
      direction: "out",
      amount: s.vatDue,
      category: "VAT",
      certainty: "estimated",
      label: "VAT return (estimate)",
      href: "/tax",
    });
  }
  if (s.cisDueNow > 0) {
    events.push({
      dateKey: s.cisDueOn, // null → undated pool
      direction: "out",
      amount: s.cisDueNow,
      category: "CIS",
      certainty: "estimated",
      label: s.cisDueMonths.length > 0 ? `CIS to HMRC (${s.cisDueMonths.join(", ")})` : "CIS to HMRC",
      href: "/tax",
    });
  }
  if (s.unpaidBills > 0) {
    // Supplier bills carry no due date in the schema — carried as undated, never
    // guessed onto a week (documented gap, not a fabricated date).
    events.push({
      dateKey: null,
      direction: "out",
      amount: s.unpaidBills,
      category: "Supplier bills",
      certainty: "invoiced",
      label: `${s.unpaidBillCount} unpaid bill${s.unpaidBillCount === 1 ? "" : "s"} (no due date recorded)`,
      href: "/cash",
    });
  }

  // Recurring expense budgets — a PLAN, spread evenly across the horizon.
  const budgets = await allRows("forecasting: expense budgets", (from, to) =>
    db
      .from("expense_budgets")
      .select("id, category, amount_pence, period_type")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  let weeklyRecurring = 0;
  for (const b of budgets) {
    const pounds = Number(b.amount_pence ?? 0) / 100;
    const perPeriod = WEEKS_PER_PERIOD[String(b.period_type ?? "monthly")] ?? WEEKS_PER_PERIOD.monthly!;
    if (pounds > 0 && perPeriod > 0) weeklyRecurring += pounds / perPeriod;
  }
  weeklyRecurring = round2(weeklyRecurring);
  if (weeklyRecurring > 0) {
    for (let i = 0; i < FORECAST_HORIZON_WEEKS; i++) {
      events.push({
        dateKey: addDays(todayKey, i * 7),
        direction: "out",
        amount: weeklyRecurring,
        category: "Recurring costs",
        certainty: "planned",
        label: "Budgeted operating spend",
        href: "/finances",
      });
    }
  }

  return computeCashTimeline({ events, todayKey, horizonWeeks: FORECAST_HORIZON_WEEKS });
}

function siteLabel(job: Row): string | null {
  const parts = [sv(job.site_address_line1), sv(job.site_city), sv(job.site_postcode)]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
}

// ---------------------------------------------------------------------------
// Group: labour forecast
// ---------------------------------------------------------------------------

async function gatherLabourForecast(
  db: ForecastingClient,
  orgId: string,
  todayKey: string,
): Promise<LabourForecast> {
  const memberships = await allRows("forecasting: memberships", (from, to) =>
    db
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .order("user_id", { ascending: true })
      .range(from, to),
  );
  const memberIds = [...new Set(memberships.map((m) => String(m.user_id)))];

  const users =
    memberIds.length === 0
      ? []
      : await allRows("forecasting: users", (from, to) =>
          db
            .from("users")
            // GLOBAL table (no org_id): scoped by this org's membership ids.
            .select("id, full_name")
            .in("id", memberIds)
            .order("id", { ascending: true })
            .range(from, to),
        );
  const nameById = new Map(users.map((u) => [String(u.id), sv(u.full_name)]));
  const members: LabourMember[] = memberIds.map((id) => ({
    userId: id,
    name: nameById.get(id) ?? null,
  }));

  // Future rostered shifts across the horizon window [today start, horizon end).
  const startMs = ukDayStartMs(todayKey);
  const endMs = ukDayStartMs(addDays(todayKey, FORECAST_HORIZON_WEEKS * 7));
  const fromInstant = new Date(startMs).toISOString();
  const toInstant = new Date(endMs).toISOString();

  const rota = await allRows("forecasting: rota entries", (from, to) =>
    db
      .from("rota_entries")
      .select("user_id, starts_at, ends_at")
      .eq("org_id", orgId)
      .gte("starts_at", fromInstant)
      .lte("starts_at", toInstant)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  const shifts: LabourShift[] = [];
  for (const r of rota) {
    const userId = sv(r.user_id);
    const startsAt = sv(r.starts_at);
    const endsAt = sv(r.ends_at);
    if (!userId || !startsAt || !endsAt) continue;
    shifts.push({
      userId,
      startMs: new Date(startsAt).getTime(),
      endMs: new Date(endsAt).getTime(),
    });
  }

  return computeLabourForecast({
    members,
    shifts,
    todayKey,
    horizonWeeks: FORECAST_HORIZON_WEEKS,
  });
}

// ---------------------------------------------------------------------------
// Group: customer LTV forecast (forward projection + churn signal)
// ---------------------------------------------------------------------------

/**
 * Forward customer value + churn signal. Reads the SAME dated invoice history the
 * facts LTV uses PLUS the customer's jobs (recency only), and hands them to the
 * pure projection lib. A deliberate ESTIMATE — the pure module labels itself so,
 * withholds a projection where history is too thin, and never blends a score.
 * `sent_at`/`created_at` are what turn each issued invoice into a dated order.
 */
export async function gatherCustomerLtvForecast(
  db: ForecastingClient,
  orgId: string,
  todayKey: string,
): Promise<CustomerLtvForecast> {
  const [invoices, customers, jobs] = await Promise.all([
    allRows("forecasting: LTV forecast invoices", (from, to) =>
      db
        .from("invoices")
        .select("id, status, amount, customer_id, job_id, sent_at, created_at")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("forecasting: LTV forecast customers", (from, to) =>
      db
        .from("customers")
        .select("id, name")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    allRows("forecasting: LTV forecast jobs", (from, to) =>
      db
        .from("jobs")
        .select("id, customer_id, created_at")
        .eq("org_id", orgId)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  return computeCustomerLtvForecast({
    // An issued invoice is dated by when it was sent; a legacy row with no
    // sent_at falls back to created_at (never guessed onto today).
    invoices: invoices.map((i) => ({
      status: String(i.status ?? ""),
      amount: i.amount as number | string | null,
      customer_id: sv(i.customer_id),
      job_id: sv(i.job_id),
      issuedAt: sv(i.sent_at) ?? sv(i.created_at),
    })) as LtvForecastInvoice[],
    activity: jobs.map((j) => ({
      customerId: sv(j.customer_id),
      at: sv(j.created_at),
    })) as LtvForecastActivity[],
    naming: {
      customerName: new Map(customers.map((c) => [String(c.id), String(c.name ?? "")])),
      jobCustomer: new Map(jobs.map((j) => [String(j.id), sv(j.customer_id)])),
    },
    todayKey,
  });
}

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

export type ForecastGroup<T> = { data: T; failed: false } | { data: null; failed: true };

export interface ForecastsView {
  orgId?: string;
  todayKey: string;
  horizonWeeks: number;
  /** True when the viewer's role can see the cash outflow side (VAT/CIS/bills). */
  cashVisible: boolean;
  cashTimeline: ForecastGroup<CashTimeline>;
  labour: ForecastGroup<LabourForecast>;
  /** Forward customer value + churn signal — a labelled ESTIMATE, its own loud group. */
  customerForecast: ForecastGroup<CustomerLtvForecast>;
  delayRisk: ForecastGroup<DelayRiskBoard>;
  /** Pure over already-loaded signals; bands each factor `insufficient` when its
   *  input is absent, so it is always present rather than a read group. */
  commercialRisk: CommercialRiskBoard;
}

async function group<T>(context: string, run: () => Promise<T>): Promise<ForecastGroup<T>> {
  try {
    return { data: await run(), failed: false };
  } catch (err) {
    reportReadFailure(context, {
      message: err instanceof Error ? err.message : String(err),
    });
    return { data: null, failed: true };
  }
}

/**
 * Load the forward forecasts for one org. `signals` is the already-loaded
 * company-signals view (the /insights page loads it once); the risk boards
 * compose it rather than re-reading. `role` gates the cash timeline's outflow
 * side. `now` is injectable so tests and the page pin one instant.
 */
export async function loadForecasts(
  orgId: string,
  role: string,
  signals: CompanySignalsView,
  now: Date = new Date(),
): Promise<ForecastsView> {
  const supabase = await createClient();
  const db = supabase as unknown as ForecastingClient;
  const todayKey = formatDayKeyUK(now);
  const cashVisible = cashOutVisibleToRole(role);

  const [cashTimeline, labour, customerForecast] = await Promise.all([
    // The cash timeline needs the outflow side to be honest; a role that can't
    // see VAT/CIS/payables gets no timeline rather than an understated one.
    cashVisible
      ? group("forecasting: cash timeline", () => gatherCashTimeline(db, orgId, now, todayKey))
      : Promise.resolve({ data: null, failed: true } as ForecastGroup<CashTimeline>),
    group("forecasting: labour", () => gatherLabourForecast(db, orgId, todayKey)),
    group("forecasting: customer LTV forecast", () =>
      gatherCustomerLtvForecast(db, orgId, todayKey),
    ),
  ]);

  // Delay risk composes the programme + progress rollups from the signals view.
  // If either failed, the board can't be assessed — fail the group.
  const delayRisk: ForecastGroup<DelayRiskBoard> =
    signals.programmeVariance.failed || signals.progress.failed
      ? { data: null, failed: true }
      : {
          data: computeDelayRiskBoard({
            programme: signals.programmeVariance.data.rollup,
            progress: signals.progress.data.rollup,
          }),
          failed: false,
        };

  // Commercial risk is pure over already-loaded inputs; each missing input bands
  // that factor `insufficient`, so it always renders (never a failed group).
  const commercialRisk = computeCommercialRiskBoard({
    agedDebt: signals.exposure.failed ? null : signals.exposure.data.agedDebt,
    concentration: signals.concentration.failed ? null : signals.concentration.data,
    retention: signals.exposure.failed ? null : signals.exposure.data.retention,
    cash: cashTimeline.failed ? null : cashTimeline.data,
  });

  return {
    orgId,
    todayKey,
    horizonWeeks: FORECAST_HORIZON_WEEKS,
    cashVisible,
    cashTimeline,
    labour,
    customerForecast,
    delayRisk,
    commercialRisk,
  };
}
