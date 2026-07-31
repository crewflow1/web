/**
 * Weather intelligence — the decision layer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE AND DETERMINISTIC. No I/O, no `process.env`, no `server-only`, no
 * network, NO CLOCK. Every instant comes from the input, so the same window and
 * work type always produce the same verdict — which is what makes this layer
 * fully testable against fixtures while no provider exists, and what makes a
 * verdict reproducible months later when somebody asks why work stopped.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE LOAD-BEARING INVARIANT — the one rule this file exists to enforce:
 *
 *     **`viable` requires EVERY threshold to have been evaluated against real
 *     data. Missing data can NEVER read as "safe".**
 *
 * This is the same doctrine as `outboundReady` in lib/comms/readiness.ts and
 * `available` in lib/ai/quote-writer-readiness.ts — a green light over a path
 * that cannot be verified is worse than no light, because it suppresses the
 * judgement that would have caught the problem. Here the stakes are physical
 * rather than commercial: an empty window means "the weather is unknown", and a
 * layer that answered "viable" to it would be telling a site manager to pour
 * concrete on the strength of no information at all. So an empty window — which
 * is EVERY window in this build, because no provider is bound — returns
 * `unknown`, never `viable`.
 *
 * ADVISORY, NOT AUTHORITATIVE. Nothing here discharges a legal duty. Three of
 * the duties behind these thresholds are statutory and all three require a
 * competent person to assess the actual site. See lib/weather/thresholds.ts.
 */

import {
  WORK_TYPE_THRESHOLDS,
  FULLY_UNSOURCED_WORK_TYPES,
  WORK_TYPE_LABELS,
  isSourced,
  type Threshold,
  type ThresholdSeverity,
  type ThresholdSourceKind,
  type WeatherMetric,
  type WorkType,
} from "./thresholds";
import type { WeatherWindow } from "./types";

// ---------------------------------------------------------------------------
// Reduction: a window of readings → the extremes a threshold compares against.
// ---------------------------------------------------------------------------

/**
 * The reduced metrics. EVERY field is `number | null`, and `null` means "no
 * provider reported this", never "zero". Conflating the two is how a decision
 * layer ends up reporting dead calm during a gale.
 */
export type WeatherSummary = Readonly<Record<WeatherMetric, number | null>>;

/** Count of readings that contributed, for the caveats. */
export type WindowCoverage = {
  readonly readingCount: number;
  /** Readings carrying a gust figure. Fewer than `readingCount` ⇒ a caveat. */
  readonly gustReadingCount: number;
  /** Readings from which a dew-point margin could be computed. */
  readonly dewPointReadingCount: number;
};

const min = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b < a ? b : a));
const max = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a));

/** Finite numbers only — a provider sending NaN or Infinity must not poison a min/max. */
function finite(values: ReadonlyArray<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Dew point from air temperature and relative humidity, °C.
 *
 * Magnus–Tetens approximation with the Sonntag (1990) coefficients
 * b = 17.62, c = 243.12 °C, which is the form WMO guidance uses and is accurate
 * to better than 0.1 °C over the range UK construction cares about.
 *
 *   γ  = ln(RH/100) + (b·T)/(c+T)
 *   Td = (c·γ) / (b−γ)
 *
 * Returns null for out-of-range humidity (0% is unphysical and would send the
 * logarithm to −∞).
 */
export function dewPointC(airTempC: number, humidityPct: number): number | null {
  if (!Number.isFinite(airTempC) || !Number.isFinite(humidityPct)) return null;
  if (humidityPct <= 0 || humidityPct > 100) return null;
  const b = 17.62;
  const c = 243.12;
  const gamma = Math.log(humidityPct / 100) + (b * airTempC) / (c + airTempC);
  const td = (c * gamma) / (b - gamma);
  return Number.isFinite(td) ? td : null;
}

/**
 * Reduce a window to its extremes.
 *
 * Extremes, not means, throughout: a pour is ruined by the coldest hour of the
 * night and a load is swung by the strongest gust, so an average would hide
 * exactly the conditions that matter.
 */
export function summariseWindow(window: WeatherWindow): {
  summary: WeatherSummary;
  coverage: WindowCoverage;
} {
  const r = window.readings;

  const temps = finite(r.map((x) => x.airTempC));
  const gusts = finite(r.map((x) => x.windGustMs));
  const speeds = finite(r.map((x) => x.windSpeedMs));
  const rates = finite(r.map((x) => x.precipRateMmH));
  const totals = finite(r.map((x) => x.precipTotalMm));
  const probs = finite(r.map((x) => x.precipProbPct));
  const humidity = finite(r.map((x) => x.humidityPct));
  const visibility = finite(r.map((x) => x.visibilityM));

  // Dew-point MARGIN is per-reading (it needs temperature and humidity from the
  // SAME instant) and then minimised. Computing it from the window's minimum
  // temperature and maximum humidity would invent a moment that never occurred.
  const margins: number[] = [];
  for (const reading of r) {
    const t = reading.airTempC;
    const h = reading.humidityPct;
    if (typeof t !== "number" || typeof h !== "number") continue;
    const td = dewPointC(t, h);
    if (td === null) continue;
    margins.push(t - td);
  }

  const antecedent =
    typeof window.antecedentPrecipMm === "number" && Number.isFinite(window.antecedentPrecipMm)
      ? window.antecedentPrecipMm
      : null;

  return {
    summary: {
      minAirTempC: min(temps),
      maxAirTempC: max(temps),
      maxWindSpeedMs: max(speeds),
      maxWindGustMs: max(gusts),
      maxPrecipRateMmH: max(rates),
      totalPrecipMm: totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0),
      maxPrecipProbPct: max(probs),
      minVisibilityM: min(visibility),
      maxHumidityPct: max(humidity),
      minDewPointMarginC: min(margins),
      antecedentPrecipMm: antecedent,
    },
    coverage: {
      readingCount: r.length,
      gustReadingCount: gusts.length,
      dewPointReadingCount: margins.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------

/**
 * `unknown` is a first-class answer and the DEFAULT one in this build. It is
 * ordered outside the viable→not_viable axis on purpose: it does not mean
 * "somewhere in between", it means "this layer will not guess".
 */
export const WORKABILITY_VERDICTS = ["viable", "caution", "not_viable", "unknown"] as const;
export type WorkabilityVerdict = (typeof WORKABILITY_VERDICTS)[number];

export type ReasonStatus = "breached" | "met" | "unknown";

/** One threshold's outcome, carrying enough to explain itself without the caller re-deriving anything. */
export type WorkabilityReason = {
  readonly thresholdId: string;
  readonly status: ReasonStatus;
  readonly severity: ThresholdSeverity;
  readonly metric: WeatherMetric;
  /** What the window actually showed. null ⇒ nothing reported it. */
  readonly observed: number | null;
  readonly threshold: number;
  readonly unit: string;
  readonly comparator: "below" | "above";
  readonly rule: string;
  readonly source: string;
  readonly sourceKind: ThresholdSourceKind;
  /**
   * True when the breach was established from MEAN wind speed because no gust
   * figure existed. A gust is always at least the mean, so mean-exceeds-limit is
   * a sound proof of gust-exceeds-limit — but the converse is not, which is why
   * this is recorded rather than silently substituted.
   */
  readonly inferredFromMeanWind?: boolean;
};

export type WorkabilityAssessment = {
  readonly workType: WorkType;
  readonly workTypeLabel: string;
  readonly verdict: WorkabilityVerdict;
  /** One line a site manager can act on. */
  readonly headline: string;
  /** Every threshold's outcome, in declaration order. */
  readonly reasons: ReadonlyArray<WorkabilityReason>;
  /** Just the breaches, blocking first. The list a UI leads with. */
  readonly breaches: ReadonlyArray<WorkabilityReason>;
  /** Thresholds that could not be evaluated. Non-empty ⇒ verdict is never `viable`. */
  readonly gaps: ReadonlyArray<WorkabilityReason>;
  /** Honest qualifications on the whole assessment. Always render these. */
  readonly caveats: ReadonlyArray<string>;
  readonly summary: WeatherSummary;
  readonly coverage: WindowCoverage;
};

/** Would `observed` breach `t`? */
function breaches(t: Threshold, observed: number): boolean {
  return t.comparator === "below" ? observed < t.value : observed > t.value;
}

function evaluate(t: Threshold, summary: WeatherSummary): WorkabilityReason {
  const observed = summary[t.metric];

  const base = {
    thresholdId: t.id,
    severity: t.severity,
    metric: t.metric,
    threshold: t.value,
    unit: t.unit,
    comparator: t.comparator,
    rule: t.rule,
    source: t.source,
    sourceKind: t.sourceKind,
  } as const;

  if (observed !== null) {
    return {
      ...base,
      observed,
      status: breaches(t, observed) ? "breached" : "met",
    };
  }

  // NO GUST DATA — the one substitution this layer permits, and only in the
  // direction that cannot under-state a hazard. Physically, gust ≥ mean wind
  // always. So if the MEAN already exceeds a gust limit, the gust certainly
  // does, and that is a sound definitive breach. If the mean is below the limit
  // nothing follows about the gust, so the threshold stays `unknown` rather
  // than being marked `met`.
  if (t.metric === "maxWindGustMs") {
    const mean = summary.maxWindSpeedMs;
    if (mean !== null && breaches(t, mean)) {
      return { ...base, observed: mean, status: "breached", inferredFromMeanWind: true };
    }
  }

  return { ...base, observed: null, status: "unknown" };
}

/**
 * The honest qualifications. These are not decoration — each one names a way
 * this assessment could be wrong, and a surface that hides them is
 * misrepresenting the layer's confidence.
 */
function buildCaveats(
  workType: WorkType,
  window: WeatherWindow,
  coverage: WindowCoverage,
  reasons: ReadonlyArray<WorkabilityReason>,
): string[] {
  const caveats: string[] = [];

  // The variable-resolution weakness of a postcode-district key, surfaced at
  // the point of use exactly as the migration header promises.
  if (typeof window.resolvedDistanceKm === "number" && Number.isFinite(window.resolvedDistanceKm)) {
    caveats.push(
      `Forecast is for postcode district ${window.district}, measured about ` +
        `${window.resolvedDistanceKm.toFixed(0)} km from the work.`,
    );
  } else {
    caveats.push(
      `Forecast is for the whole of postcode district ${window.district}. Districts ` +
        `vary from about 1 km² in a city centre to well over 1,000 km² in rural areas, ` +
        `so conditions on site may differ.`,
    );
  }

  if (coverage.readingCount === 0) {
    caveats.push("No weather data for this period, so no condition could be checked.");
  } else if (coverage.gustReadingCount === 0 && coverage.readingCount > 0) {
    caveats.push(
      "No gust data available. Mean wind speed understates gusts, and gusts are what " +
        "move a load or a sheet.",
    );
  } else if (coverage.gustReadingCount < coverage.readingCount) {
    caveats.push(
      `Gust data covers only ${coverage.gustReadingCount} of ${coverage.readingCount} readings.`,
    );
  }

  // Air temperature is a proxy for the thing that actually governs.
  if (workType === "concrete_pour" || workType === "external_masonry") {
    caveats.push(
      "Air temperature is a proxy. Concrete and mortar must never be placed against " +
        "frozen ground, formwork or reinforcement, and no forecast reports whether they are.",
    );
  }
  if (workType === "external_coatings") {
    caveats.push(
      "Dew-point margin is computed from AIR temperature. The standard governs the " +
        "SUBSTRATE, which on a cold morning can sit several degrees below the air.",
    );
  }

  if (reasons.some((r) => r.metric === "antecedentPrecipMm")) {
    const mm = window.antecedentPrecipMm;
    const hours = window.antecedentWindowHours;
    if (typeof mm !== "number" || !Number.isFinite(mm)) {
      caveats.push(
        "No antecedent rainfall supplied, so ground saturation could not be assessed.",
      );
    } else if (typeof hours === "number" && Number.isFinite(hours)) {
      caveats.push(
        `Ground saturation is inferred from ${mm.toFixed(1)} mm of rain over the ` +
          `previous ${hours} hours.`,
      );
    } else {
      // A figure with no stated window is nearly useless to a reader — 40 mm over
      // a day and 40 mm over a month mean opposite things — so say the window is
      // missing rather than quoting the number as though it were self-explanatory.
      caveats.push(
        `Ground saturation is inferred from ${mm.toFixed(1)} mm of antecedent rain, ` +
          `but the period it covers was not recorded.`,
      );
    }
  }

  // The provenance warning. Groundworks trips this today.
  if (FULLY_UNSOURCED_WORK_TYPES.includes(workType)) {
    caveats.push(
      "Every threshold for this activity is CrewFlow's own default — no published " +
        "standard states one. Treat them as a starting point for a competent person, " +
        "not as a limit.",
    );
  } else if (reasons.some((r) => r.status === "breached" && r.sourceKind === "configurable_default")) {
    caveats.push(
      "At least one condition flagged here rests on a CrewFlow default rather than a " +
        "published standard. Each reason states its own source.",
    );
  }

  caveats.push(
    "Advisory only. This does not discharge any duty under CDM 2015, the Work at " +
      "Height Regulations 2005 or LOLER 1998 — a competent person must assess the site.",
  );

  return caveats;
}

function headlineFor(
  verdict: WorkabilityVerdict,
  label: string,
  breachList: ReadonlyArray<WorkabilityReason>,
  coverage: WindowCoverage,
): string {
  if (verdict === "unknown") {
    return coverage.readingCount === 0
      ? `No weather data — ${label.toLowerCase()} cannot be assessed.`
      : `Not enough weather data to clear ${label.toLowerCase()}.`;
  }
  if (verdict === "not_viable") {
    const first = breachList.find((b) => b.severity === "blocking");
    return first
      ? `${label} should not go ahead. ${first.rule}`
      : `${label} should not go ahead.`;
  }
  if (verdict === "caution") {
    const first = breachList[0];
    return first ? `${label} is marginal. ${first.rule}` : `${label} is marginal.`;
  }
  return `Conditions are within limits for ${label.toLowerCase()}.`;
}

/**
 * THE function. Given a window of weather and a work type, is the work viable?
 *
 * The verdict order is deliberate and is the whole safety argument:
 *
 *   1. A BLOCKING breach ⇒ `not_viable`. Definitive; missing data elsewhere
 *      cannot rescue it, because you already know it is off.
 *   2. Otherwise, ANY unevaluated threshold ⇒ `unknown`. This is the invariant.
 *      A window missing the one metric that would have blocked the work must not
 *      come back `viable`, or `caution`, either — those both read as permission.
 *      Caution breaches are still reported in `reasons`; they just cannot lift
 *      the verdict out of `unknown`.
 *   3. Otherwise, any CAUTION breach ⇒ `caution`.
 *   4. Otherwise ⇒ `viable`, which now genuinely means "every threshold for this
 *      activity was checked against real data and none was breached".
 */
export function assessWorkability(
  window: WeatherWindow,
  workType: WorkType,
): WorkabilityAssessment {
  const { summary, coverage } = summariseWindow(window);
  const thresholds = WORK_TYPE_THRESHOLDS[workType];

  const reasons = thresholds.map((t) => evaluate(t, summary));

  const breachList = reasons
    .filter((r) => r.status === "breached")
    // Blocking first, then declaration order — the list a UI leads with.
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
  const gaps = reasons.filter((r) => r.status === "unknown");

  let verdict: WorkabilityVerdict;
  if (breachList.some((r) => r.severity === "blocking")) {
    verdict = "not_viable";
  } else if (gaps.length > 0) {
    verdict = "unknown";
  } else if (breachList.length > 0) {
    verdict = "caution";
  } else {
    verdict = "viable";
  }

  const label = WORK_TYPE_LABELS[workType];

  return {
    workType,
    workTypeLabel: label,
    verdict,
    headline: headlineFor(verdict, label, breachList, coverage),
    reasons,
    breaches: breachList,
    gaps,
    caveats: buildCaveats(workType, window, coverage, reasons),
    summary,
    coverage,
  };
}

/**
 * Assess several work types over one window — the shape a job screen needs,
 * because a single day's work on site is rarely one trade.
 */
export function assessAll(
  window: WeatherWindow,
  workTypes: ReadonlyArray<WorkType>,
): ReadonlyArray<WorkabilityAssessment> {
  return workTypes.map((w) => assessWorkability(window, w));
}

/** m/s → mph, for the display edge only. The thresholds stay in the units their sources quote. */
export function msToMph(ms: number): number {
  return ms * 2.2369362920544;
}

/**
 * How many of the thresholds behind an assessment rest on a published source.
 * Lets a surface state its own confidence honestly instead of implying that
 * every number carries equal weight.
 */
export function sourcedThresholdRatio(workType: WorkType): {
  sourced: number;
  total: number;
} {
  const ts = WORK_TYPE_THRESHOLDS[workType];
  return { sourced: ts.filter(isSourced).length, total: ts.length };
}
