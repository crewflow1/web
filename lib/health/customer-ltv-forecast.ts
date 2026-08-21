import { round2, toPounds } from "@/lib/money";
import { daysBetween, ukDayKeyOf } from "@/lib/schedule/window";
import { ISSUED_INVOICE_STATUSES } from "@/lib/invoices/schema";
import { labelled, type LabelledMetric } from "@/lib/intelligence/provenance";

/**
 * CUSTOMER LTV — FORWARD PROJECTION + CHURN SIGNAL. Deterministic. PURE.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM THE FACTS ──────────────────────────────
 * lib/health/customer-ltv.ts reports only what the ledger already knows —
 * realised (paid) and committed (issued-unpaid) value, two certainties kept
 * apart, NO projection and NO churn probability, on purpose. That module is a
 * statement of fact and must stay one. This module is the OTHER thing the
 * Intelligence layer wants: a forward ESTIMATE. It is deliberately kept out of
 * the facts file so a projection can never be mistaken for money the ledger has
 * seen. Every figure here is labelled `heuristic` (a rule of thumb applied to
 * derived figures), never `fact` or `derived`.
 *
 * ── WHAT IT PROJECTS, AND HOW (NO BLACK BOX) ────────────────────────────────
 * The projection is the transparent textbook one — average order value × how
 * often the customer orders × the horizon — with every factor carried on the
 * row so the reader can check the arithmetic:
 *
 *   avgOrderValue      = mean ex-VAT amount of the customer's ISSUED invoices.
 *   medianCadenceDays  = median gap between consecutive DISTINCT order days.
 *   ordersPerYear      = 365.25 / medianCadenceDays.
 *   projectedValue     = avgOrderValue × ordersPerYear × (horizonMonths / 12).
 *
 * There is deliberately NO single opaque score, NO invented retention curve and
 * NO model. The reader sees the three inputs and the horizon, and can redo the
 * multiplication by hand. (lib/suppliers/performance.ts header points 1 to 2: a
 * weight is an opinion wearing a number's clothes — none is added here.)
 *
 * ── THE CHURN / AT-RISK SIGNAL ──────────────────────────────────────────────
 * Recency is judged AGAINST the customer's own rhythm, not an absolute calendar.
 * `daysSinceLastActivity` (the later of their last issued invoice and their last
 * job) is divided by their `medianCadenceDays`:
 *
 *   active   ratio ≤ AT_RISK_CADENCE_MULTIPLE
 *   at_risk  AT_RISK_CADENCE_MULTIPLE < ratio ≤ LAPSED_CADENCE_MULTIPLE,
 *            AND at least MIN_AT_RISK_DAYS have actually passed
 *   lapsed   ratio > LAPSED_CADENCE_MULTIPLE
 *
 * The absolute floor stops a short-cadence customer (weekly trade account) being
 * branded at-risk the moment it is a few days late. A LAPSED customer's forward
 * projection is WITHHELD (null), not printed: straight-lining a year of orders
 * for a customer who has stopped ordering is exactly the fiction this layer
 * refuses to sell. Their row still lists their history and their band.
 *
 * ── INSUFFICIENT DATA IS AN ANSWER, NOT A ZERO ──────────────────────────────
 * A repeat rate needs a repeat. A customer with fewer than two DISTINCT order
 * days has no observable cadence, so BOTH the projection and the churn band are
 * withheld and the row is marked `insufficient` — never a fabricated £0 forecast
 * or a false "active". The org-level view is `sufficient` only once at least one
 * customer can actually be projected. (lib/profitability/compute.ts marginBand's
 * explicit no-data state; lib/suppliers/performance.ts sample-floor discipline.)
 *
 * ── ATTRIBUTION ─────────────────────────────────────────────────────────────
 * `invoices.customer_id` is the anchor; a pre-backfill row's null falls back to
 * the invoice's JOB customer — the exact rule the facts module and
 * lib/intelligence/concentration.ts apply. An invoice whose customer still
 * cannot be resolved is EXCLUDED from projection (you cannot forecast the repeat
 * behaviour of an unknown customer), never folded into a named customer.
 *
 * ── EX-VAT ──────────────────────────────────────────────────────────────────
 * `invoices.amount` (ex-VAT), like the facts module and every other revenue
 * figure. VAT is collected on HMRC's behalf, not earned.
 *
 * PURE: no I/O. `todayKey` is passed in so the clock lives at the edge; the read
 * layer scopes every invoice and job to the active org.
 */

// ---------------------------------------------------------------------------
// Thresholds — ratified config, printed verbatim in the basis
// ---------------------------------------------------------------------------

/** Distinct order days a customer needs before any cadence can be observed. */
export const MIN_ORDERS_FOR_FORECAST = 2;

/** Default projection window. A year is the horizon a repeat-rate can honestly reach. */
export const DEFAULT_FORECAST_HORIZON_MONTHS = 12;

/** ratio ≤ this → active. */
export const AT_RISK_CADENCE_MULTIPLE = 1.5;
/** ratio > this → lapsed (projection withheld). */
export const LAPSED_CADENCE_MULTIPLE = 3;
/** No customer is branded at-risk before this many days have actually passed. */
export const MIN_AT_RISK_DAYS = 45;

/** Days per year used to turn a cadence into a frequency. */
const DAYS_PER_YEAR = 365.25;

export const CUSTOMER_LTV_FORECAST_TOP_N = 8;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type LtvForecastInvoice = {
  status: string;
  /** EX-VAT revenue (`invoices.amount`). */
  amount: number | string | null;
  /** Denormalised anchor; null on pre-backfill rows. */
  customer_id: string | null;
  job_id: string | null;
  /** When the invoice was issued — `sent_at` ?? `created_at`. Null skips the row. */
  issuedAt: string | null;
};

/** A dated non-invoice touch (a job), used for recency only. */
export type LtvForecastActivity = {
  customerId: string | null;
  /** An activity instant (e.g. `jobs.created_at`). Null skips the row. */
  at: string | null;
};

export type LtvForecastNaming = {
  customerName: Map<string, string>;
  /** job id → customer id, the pre-backfill fallback. */
  jobCustomer: Map<string, string | null>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ChurnBand = "active" | "at_risk" | "lapsed" | "insufficient";

export const CHURN_BAND_LABEL: Record<ChurnBand, string> = {
  active: "Active",
  at_risk: "At risk",
  lapsed: "Lapsed",
  insufficient: "Not enough history",
};

export type CustomerLtvForecastRow = {
  customerId: string;
  name: string;
  href: string;
  /** Issued invoices counted for this customer. */
  orderCount: number;
  /** Distinct calendar days the customer placed an order on. */
  distinctOrderDays: number;
  /** Mean ex-VAT amount per issued invoice. */
  avgOrderValue: number;
  /** Median gap (days) between consecutive distinct order days; null if unobservable. */
  medianCadenceDays: number | null;
  /** 365.25 / medianCadenceDays; null if unobservable. */
  ordersPerYear: number | null;
  /** Days since the later of last invoice and last job. */
  daysSinceLastActivity: number;
  /** The day that recency is measured from (YYYY-MM-DD). */
  lastActivityDay: string;
  /** daysSinceLastActivity / medianCadenceDays; null if unobservable. */
  recencyRatio: number | null;
  churn: ChurnBand;
  /**
   * avgOrderValue × ordersPerYear × horizon. Null when history is insufficient
   * OR the customer is lapsed (a projection for someone who has stopped ordering
   * is withheld, never printed as a number).
   */
  projectedHorizonValue: number | null;
  /** True when a projection could be made (sufficient history AND not lapsed). */
  projectable: boolean;
};

export type CustomerLtvForecast = {
  /** Every named customer with ≥1 issued invoice, worst-projection last. */
  customers: CustomerLtvForecastRow[];
  /** Rows that carry a projection (sufficient history, not lapsed), biggest first. */
  top: CustomerLtvForecastRow[];
  /** At-risk or lapsed customers, most-overdue first — the retention worklist. */
  atRisk: CustomerLtvForecastRow[];
  /** Σ of the shown projections (lapsed/insufficient contribute nothing). */
  projectedTotal: number;
  horizonMonths: number;
  /** Named customers with ≥1 issued invoice. */
  customersConsidered: number;
  /** Customers a projection could be made for. */
  customersProjected: number;
  atRiskCount: number;
  lapsedCount: number;
  /** Issued invoices attributable to a named customer. */
  invoiceCount: number;
  /** True once at least one customer can actually be projected. */
  sufficient: boolean;
};

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Median of a non-empty numeric list (mean of the two middles on even length). */
function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bandFor(recencyRatio: number, daysSince: number): ChurnBand {
  if (recencyRatio > LAPSED_CADENCE_MULTIPLE) return "lapsed";
  if (recencyRatio > AT_RISK_CADENCE_MULTIPLE && daysSince >= MIN_AT_RISK_DAYS) return "at_risk";
  return "active";
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export function computeCustomerLtvForecast(input: {
  invoices: LtvForecastInvoice[];
  activity: LtvForecastActivity[];
  naming: LtvForecastNaming;
  todayKey: string;
  horizonMonths?: number;
}): CustomerLtvForecast {
  const horizonMonths = input.horizonMonths ?? DEFAULT_FORECAST_HORIZON_MONTHS;
  const ISSUED = new Set<string>(ISSUED_INVOICE_STATUSES);

  type Acc = { amounts: number[]; orderDays: Set<string>; lastActivityDay: string | null };
  const byCustomer = new Map<string, Acc>();
  let invoiceCount = 0;

  const acc = (key: string): Acc => {
    let a = byCustomer.get(key);
    if (!a) {
      a = { amounts: [], orderDays: new Set(), lastActivityDay: null };
      byCustomer.set(key, a);
    }
    return a;
  };
  const noteActivity = (a: Acc, day: string) => {
    if (a.lastActivityDay == null || day > a.lastActivityDay) a.lastActivityDay = day;
  };

  for (const inv of input.invoices) {
    if (!ISSUED.has(inv.status)) continue; // draft (or unknown) — never issued value.
    if (!inv.issuedAt) continue; // undated issued invoice can't inform cadence/recency.
    const customerId =
      inv.customer_id ??
      (inv.job_id ? input.naming.jobCustomer.get(inv.job_id) ?? null : null);
    if (!customerId) continue; // unattributable — cannot forecast an unknown customer.
    const day = ukDayKeyOf(inv.issuedAt);
    const a = acc(customerId);
    a.amounts.push(toPounds(inv.amount));
    a.orderDays.add(day);
    noteActivity(a, day);
    invoiceCount += 1;
  }

  // Jobs count for recency only — an engaged customer with a recent job but no
  // recent invoice is not churning. They never touch AOV or cadence (those are
  // value events). A job for a customer with no issued invoice cannot be
  // projected, so it does not create a row.
  for (const act of input.activity) {
    if (!act.customerId || !act.at) continue;
    const existing = byCustomer.get(act.customerId);
    if (!existing) continue;
    noteActivity(existing, ukDayKeyOf(act.at));
  }

  const horizonFraction = horizonMonths / 12;

  const customers: CustomerLtvForecastRow[] = [...byCustomer.entries()].map(([customerId, a]) => {
    const orderCount = a.amounts.length;
    const avgOrderValue = round2(a.amounts.reduce((s, v) => s + v, 0) / orderCount);
    const days = [...a.orderDays].sort();
    const distinctOrderDays = days.length;

    // Recency is measured from the later of last invoice / last job.
    const lastActivityDay = a.lastActivityDay ?? days[days.length - 1]!;
    const daysSinceLastActivity = Math.max(0, daysBetween(lastActivityDay, input.todayKey));

    // Cadence needs at least two distinct order days (one observed interval).
    let medianCadenceDays: number | null = null;
    let ordersPerYear: number | null = null;
    let recencyRatio: number | null = null;
    let churn: ChurnBand = "insufficient";

    if (distinctOrderDays >= MIN_ORDERS_FOR_FORECAST) {
      const intervals: number[] = [];
      for (let i = 1; i < days.length; i++) intervals.push(daysBetween(days[i - 1]!, days[i]!));
      intervals.sort((x, y) => x - y);
      const cadence = median(intervals);
      if (cadence > 0) {
        medianCadenceDays = round2(cadence);
        ordersPerYear = round2(DAYS_PER_YEAR / cadence);
        recencyRatio = round2(daysSinceLastActivity / cadence);
        churn = bandFor(recencyRatio, daysSinceLastActivity);
      }
    }

    const projectable = ordersPerYear != null && churn !== "lapsed";
    const projectedHorizonValue = projectable
      ? round2(avgOrderValue * ordersPerYear! * horizonFraction)
      : null;

    return {
      customerId,
      name: input.naming.customerName.get(customerId) || "Unnamed customer",
      href: `/customers/${customerId}`,
      orderCount,
      distinctOrderDays,
      avgOrderValue,
      medianCadenceDays,
      ordersPerYear,
      daysSinceLastActivity,
      lastActivityDay,
      recencyRatio,
      churn,
      projectedHorizonValue,
      projectable,
    };
  });

  // Deterministic total order: biggest projection first, then name/id. Rows with
  // no projection (null) sort to the bottom.
  customers.sort(
    (x, y) =>
      (y.projectedHorizonValue ?? -1) - (x.projectedHorizonValue ?? -1) ||
      x.name.localeCompare(y.name) ||
      x.customerId.localeCompare(y.customerId),
  );

  const top = customers.filter((c) => c.projectedHorizonValue != null).slice(0, CUSTOMER_LTV_FORECAST_TOP_N);

  // Retention worklist: most-overdue relative to their own rhythm first.
  const atRisk = customers
    .filter((c) => c.churn === "at_risk" || c.churn === "lapsed")
    .sort(
      (x, y) =>
        (y.recencyRatio ?? 0) - (x.recencyRatio ?? 0) ||
        x.name.localeCompare(y.name) ||
        x.customerId.localeCompare(y.customerId),
    );

  const customersProjected = customers.filter((c) => c.projectable).length;

  return {
    customers,
    top,
    atRisk,
    projectedTotal: round2(
      customers.reduce((s, c) => s + (c.projectedHorizonValue ?? 0), 0),
    ),
    horizonMonths,
    customersConsidered: customers.length,
    customersProjected,
    atRiskCount: customers.filter((c) => c.churn === "at_risk").length,
    lapsedCount: customers.filter((c) => c.churn === "lapsed").length,
    invoiceCount,
    sufficient: customersProjected > 0,
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

/**
 * HEURISTIC — a stated projection rule applied to the ledger's own figures. The
 * basis carries the exact arithmetic and thresholds so no surface can print the
 * estimate without printing how it was made.
 */
export function customerLtvForecastMetric(
  f: CustomerLtvForecast,
): LabelledMetric<CustomerLtvForecast> {
  return labelled(f, {
    kind: "heuristic",
    basis:
      "An ESTIMATE, not a fact. Each customer's projected value over the next " +
      `${f.horizonMonths} months = their average order value (mean ex-VAT of their issued ` +
      "invoices) × how often they order (365.25 ÷ the median gap between their order days) × the " +
      "horizon. The churn signal compares days since their last invoice or job against that same " +
      `median cadence: active when ≤ ${AT_RISK_CADENCE_MULTIPLE}× it, at-risk between that and ` +
      `${LAPSED_CADENCE_MULTIPLE}× (once at least ${MIN_AT_RISK_DAYS} days have passed), lapsed ` +
      "beyond it. A lapsed customer's projection is withheld, and a customer with fewer than " +
      `${MIN_ORDERS_FOR_FORECAST} distinct order days shows 'Not enough history' rather than a ` +
      "fabricated number. There is no blended score and no model — every factor is shown so you " +
      "can redo the maths.",
    computedFrom: [
      { label: "Invoices", href: "/invoices" },
      { label: "Customers", href: "/customers" },
      { label: "Jobs", href: "/jobs" },
    ],
  });
}
