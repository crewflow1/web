/**
 * weather_readings CHECK + precision bounds (mig 20261074000000) — the PURE
 * validator every provider mapper runs each metric through, so no out-of-range
 * sample can reach the cache upsert.
 *
 * THE GAP THIS CLOSES. A provider mapper that only filters non-finite/NaN mirrors
 * NONE of weather_readings' range CHECKs or numeric precision ceilings. A single
 * out-of-range value (a glitch wind of -3 m/s, a humidity of 250 %, a precip that
 * overflows numeric(5,2)) makes the district×kind upsert violate a CHECK/22003 →
 * the WHOLE district writes zero rows → isFresh() stays false → the district is
 * re-fetched-and-re-failed every tick, permanently denying weather to EVERY org
 * watching it (the cache is global by district). Nulling the offending metric here
 * keeps the rest of the reading insertable; a reading left with no signal at all is
 * then dropped by the adapter's all-null-hour filter.
 *
 * Each bound is tied to its column definition; a NEW measurement column / CHECK
 * REQUIRES a matching bound here AND a matching assertion in the adapter's
 * constraint guard test — a new column without a bound is exactly the class this
 * module exists to catch.
 */

/** The measurement fields weather_readings carries a CHECK / precision ceiling on. */
export type WeatherMetricField =
  | "air_temp_c"
  | "wind_speed_ms"
  | "wind_gust_ms"
  | "precip_rate_mm_h"
  | "precip_total_mm"
  | "precip_prob_pct"
  | "humidity_pct"
  | "visibility_m";

export type WeatherMetricBound = {
  readonly min: number;
  readonly max: number;
  /** Integer column ⇒ round before the range check (the DB stores an int). */
  readonly integer?: boolean;
};

/**
 * The insertable range for each metric, derived directly from the column
 * definitions in 20261074000000. `max` for a decimal column is its precision
 * ceiling (the largest value that fits numeric(p,s) integer digits); for an
 * integer column it is int4's max where the CHECK sets no tighter upper bound.
 */
export const WEATHER_METRIC_BOUNDS: Readonly<Record<WeatherMetricField, WeatherMetricBound>> = {
  // numeric(4,1) — 3 integer digits + 1 decimal; no sign CHECK (temperatures negate).
  air_temp_c: { min: -999.9, max: 999.9 },
  // numeric(4,1) check (>= 0)
  wind_speed_ms: { min: 0, max: 999.9 },
  // numeric(4,1) check (>= 0)
  wind_gust_ms: { min: 0, max: 999.9 },
  // numeric(5,2) check (>= 0) — 3 integer digits + 2 decimal
  precip_rate_mm_h: { min: 0, max: 999.99 },
  // numeric(6,2) check (>= 0) — 4 integer digits + 2 decimal
  precip_total_mm: { min: 0, max: 9999.99 },
  // integer check (between 0 and 100)
  precip_prob_pct: { min: 0, max: 100, integer: true },
  // integer check (between 0 and 100)
  humidity_pct: { min: 0, max: 100, integer: true },
  // integer check (>= 0) — int4 upper bound (visibility in metres never approaches it)
  visibility_m: { min: 0, max: 2_147_483_647, integer: true },
};

/**
 * A finite metric within its column's CHECK + precision bound, else null. Pure.
 *
 * Integer-column values are rounded first (the DB casts to int on insert), THEN
 * range-checked, so a value that rounds outside the CHECK (e.g. 100.6 → 101 for a
 * 0–100 field) is correctly rejected rather than silently stored. A null/undefined
 * or non-finite input passes straight through as null (the vendor's "not reported").
 */
export function boundedMetric(
  value: number | null | undefined,
  field: WeatherMetricField,
): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const bound = WEATHER_METRIC_BOUNDS[field];
  const v = bound.integer ? Math.round(n) : n;
  if (v < bound.min || v > bound.max) return null;
  return v;
}
