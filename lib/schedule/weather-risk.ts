import type { WeatherSnapshot } from "@/server/services/weather";
import type { WorkabilityReason } from "@/lib/weather";

/**
 * Schedule Integrity — weather risk (PURE, no I/O).
 *
 * The schedule-integrity read layer detects PEOPLE and ASSET clashes. This
 * module adds a strictly ADDITIVE, orthogonal axis: does the forecast for a
 * scheduled job's day threaten the work? It is pure — it consumes weather
 * snapshots the service already resolved through the governed accessor
 * (server/services/weather.ts → buildWeatherSnapshot) and decides nothing about
 * whether weather is available; the accessor's readiness short-circuit owns
 * that.
 *
 * ── THE ONE RULE THIS MODULE EXISTS TO ENFORCE ─────────────────────────────
 * A job is flagged as at-risk ONLY from REAL readings. When the cache holds no
 * reading for a job's day (the state of every environment today, because the
 * provider is dark) that job is counted as INSUFFICIENT — honestly "we could
 * not check" — and NEVER as "no weather risk". A green all-clear is emitted only
 * for a job we actually assessed against observed data. This is the schedule-
 * side mirror of the decision layer's invariant that an empty window is
 * `unknown`, never `viable`: missing data must never read as safe.
 *
 * ── WHY IT ASSESSES AGAINST ALL WEATHER-SENSITIVE ACTIVITIES ────────────────
 * A `jobs` row carries no trade, so this module cannot know whether a given day
 * is a concrete pour or a crane lift. Rather than GUESS a work type (which would
 * be a fabrication), it uses the verdicts the accessor already computed across
 * every weather-sensitive activity and flags a job when the forecast would
 * BLOCK at least one of them (`not_viable`) or make it marginal (`caution`).
 * The breached conditions it lists are OBJECTIVE forecast facts (a gust over a
 * limit, a temperature below one) that hold regardless of trade — so the signal
 * says the true and useful thing ("conditions this day would stop weather-
 * sensitive work") without inventing what the crew is doing.
 *
 * Deterministic: jobs sort by (day, jobId); conditions are deduped by threshold
 * id and ordered blocking-first then by id. No clock, no randomness.
 */

/** One scheduled job, resolved to its location and the weather the accessor found. */
export interface ScheduledJobWeatherInput {
  readonly jobId: string;
  /** Human label for the surface — customer name, else a short job reference. */
  readonly label: string;
  /** The scheduled UK day, `YYYY-MM-DD`. */
  readonly day: string;
  /** The job's postcode district, or null when its address carries no postcode. */
  readonly district: string | null;
  /**
   * The snapshot the accessor returned for this job's district and day, or null
   * when no district could be derived (so nothing was fetched). A snapshot whose
   * window has no readings means the cache had nothing for the day — insufficient,
   * never an all-clear.
   */
  readonly snapshot: WeatherSnapshot | null;
}

/** A job the forecast flags, with the objective conditions behind the flag. */
export interface WeatherJobRisk {
  readonly jobId: string;
  readonly label: string;
  readonly day: string;
  readonly district: string;
  /** `not_viable` (a blocking breach exists) outranks `caution` (marginal only). */
  readonly verdict: "not_viable" | "caution";
  /** Distinct breached rules, blocking-first, ready to render. */
  readonly conditions: readonly string[];
}

/**
 * The schedule weather signal. `available` reflects whether weather intelligence
 * is active at all; the counts are ALWAYS honest about what could and could not
 * be assessed, so no consumer can mistake "not checked" for "nothing wrong".
 */
export interface WeatherScheduleSignal {
  /** Weather intelligence is active (a provider is bound and the cache is live). */
  readonly available: boolean;
  /** The one honest sentence a surface shows — sourced from readiness. */
  readonly statusLine: string;
  /** Jobs assessed against REAL readings covering their day. */
  readonly assessedJobs: number;
  /** Jobs with a known district but NO readings for their day — "could not check". */
  readonly insufficientJobs: number;
  /** Jobs whose address carries no postcode, so no location could be derived. */
  readonly unlocatedJobs: number;
  /** The at-risk jobs, deterministic order. Empty while dark — never a false all-clear. */
  readonly risks: readonly WeatherJobRisk[];
}

/** The dark / unavailable signal: honest, and explicitly NOT a green all-clear. */
export function unavailableWeatherSignal(statusLine: string): WeatherScheduleSignal {
  return {
    available: false,
    statusLine,
    assessedJobs: 0,
    insufficientJobs: 0,
    unlocatedJobs: 0,
    risks: [],
  };
}

const severityRank = (r: WorkabilityReason): number => (r.severity === "blocking" ? 0 : 1);

/**
 * Reduce a job's per-activity assessments to the distinct breached conditions,
 * blocking-first then by threshold id, deduped so one gust breach is not listed
 * once per trade.
 */
function conditionsFor(snapshot: WeatherSnapshot): {
  verdict: "not_viable" | "caution" | null;
  conditions: string[];
} {
  const breaches = snapshot.assessments.flatMap((a) => a.breaches);
  if (breaches.length === 0) return { verdict: null, conditions: [] };

  const hasBlocking = breaches.some((b) => b.severity === "blocking");
  const seen = new Set<string>();
  const ordered = [...breaches].sort((a, b) =>
    severityRank(a) !== severityRank(b)
      ? severityRank(a) - severityRank(b)
      : a.thresholdId < b.thresholdId
        ? -1
        : a.thresholdId > b.thresholdId
          ? 1
          : 0,
  );
  const conditions: string[] = [];
  for (const b of ordered) {
    if (seen.has(b.thresholdId)) continue;
    seen.add(b.thresholdId);
    conditions.push(b.rule);
  }
  return { verdict: hasBlocking ? "not_viable" : "caution", conditions };
}

/**
 * Assess the scheduled jobs against the weather the accessor resolved.
 *
 * `readiness` carries the same availability + status line the accessor derived,
 * so the signal's `available`/`statusLine` never disagree with the reads that
 * fed it. When unavailable, returns the honest dark signal regardless of input.
 */
export function assessScheduleWeather(
  jobs: readonly ScheduledJobWeatherInput[],
  readiness: { readonly available: boolean; readonly statusLine: string },
): WeatherScheduleSignal {
  if (!readiness.available) return unavailableWeatherSignal(readiness.statusLine);

  let assessedJobs = 0;
  let insufficientJobs = 0;
  let unlocatedJobs = 0;
  const risks: WeatherJobRisk[] = [];

  for (const job of jobs) {
    if (job.district === null || job.snapshot === null) {
      unlocatedJobs += 1;
      continue;
    }
    const readings = job.snapshot.window?.readings ?? [];
    if (readings.length === 0) {
      // A known place with no reading for the day: could not check. NOT clear.
      insufficientJobs += 1;
      continue;
    }
    assessedJobs += 1;
    const { verdict, conditions } = conditionsFor(job.snapshot);
    if (verdict !== null) {
      risks.push({
        jobId: job.jobId,
        label: job.label,
        day: job.day,
        district: job.district,
        verdict,
        conditions,
      });
    }
  }

  risks.sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0,
  );

  return {
    available: true,
    statusLine: readiness.statusLine,
    assessedJobs,
    insufficientJobs,
    unlocatedJobs,
    risks,
  };
}
