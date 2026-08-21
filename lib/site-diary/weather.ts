import { msToMph, type WeatherSummary, type WindowCoverage } from "@/lib/weather/decision";

/**
 * Site Diary — the pure weather-suggestion formatter.
 *
 * PURE AND DETERMINISTIC. No I/O, no `process.env`, no `server-only`. It turns
 * the reduced extremes of a day's `weather_readings` window (the output of
 * `summariseWindow`) into ONE short human phrase a site manager can drop into
 * the diary's free-text "weather" field — or accept as-is. Unit-tested directly
 * (__tests__/site-diary/diary-weather-suggestion.test.ts).
 *
 * ── HONESTY IS THE WHOLE POINT ────────────────────────────────────────────────
 * This never invents weather. It describes ONLY the metrics the readings
 * actually carried:
 *   - a `null` extreme (no provider reported it) contributes NOTHING to the
 *     phrase — it is never rendered as zero;
 *   - a window with zero readings yields `null`, and the caller falls back to
 *     the hand-typed field. A dark build (no provider) has no readings, so the
 *     field stays exactly as it was before this seam existed.
 * The phrase is therefore a suggestion grounded in observed data, and the user
 * is always free to overwrite it.
 *
 * Units follow the diary's audience, not the decision layer: temperatures in °C
 * (the field's own examples use °C) and wind in mph (what a UK forecast quotes),
 * converted at this display edge via `msToMph` exactly like the workability
 * surfaces. The SI values behind the thresholds are untouched.
 */

/** Round to the nearest whole number, guarding against a non-finite input. */
function whole(n: number): number {
  return Math.round(n);
}

/** One decimal place, for millimetres of rain. */
function oneDp(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the temperature clause from the day's min/max air temperature.
 * A range when both extremes are present and differ; a single figure when they
 * coincide or only one was reported; nothing when neither was.
 */
function tempClause(summary: WeatherSummary): string | null {
  const lo = summary.minAirTempC;
  const hi = summary.maxAirTempC;
  const hasLo = typeof lo === "number" && Number.isFinite(lo);
  const hasHi = typeof hi === "number" && Number.isFinite(hi);
  if (hasLo && hasHi) {
    const a = whole(lo);
    const b = whole(hi);
    return a === b ? `${a}°C` : `${a}–${b}°C`;
  }
  if (hasLo) return `${whole(lo)}°C`;
  if (hasHi) return `${whole(hi)}°C`;
  return null;
}

/**
 * Build the wind clause. Prefer the gust extreme (what stops a lift) and label
 * it as such; fall back to the mean-speed extreme when no gust figure was
 * reported, labelled distinctly so the two are never conflated.
 */
function windClause(summary: WeatherSummary): string | null {
  const gust = summary.maxWindGustMs;
  if (typeof gust === "number" && Number.isFinite(gust)) {
    return `gusts to ${whole(msToMph(gust))} mph`;
  }
  const speed = summary.maxWindSpeedMs;
  if (typeof speed === "number" && Number.isFinite(speed)) {
    return `wind to ${whole(msToMph(speed))} mph`;
  }
  return null;
}

/**
 * Build the precipitation clause from the day's total rainfall.
 * A positive total reads as "N mm rain"; an explicit zero total reads as "dry"
 * (that is a real observation, not an absence); a `null` total — no provider
 * reported precipitation at all — contributes nothing.
 */
function precipClause(summary: WeatherSummary): string | null {
  const total = summary.totalPrecipMm;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  if (total <= 0) return "dry";
  return `${oneDp(total)} mm rain`;
}

/**
 * Turn a reduced window into a one-line diary weather suggestion, or `null` when
 * there is nothing honest to say.
 *
 * `null` is returned when the window contributed no readings OR when every
 * metric was absent — in both cases the caller keeps the manual field. A
 * non-null result is a plain descriptive phrase (no "Weather:" prefix — it goes
 * straight into the weather field), e.g. "4 to 11°C, gusts to 30 mph, 3.2 mm rain".
 */
export function suggestWeatherText(
  summary: WeatherSummary,
  coverage: WindowCoverage,
): string | null {
  // No readings ⇒ no suggestion. The honest fallback to the hand-typed field.
  if (coverage.readingCount === 0) return null;

  const clauses = [tempClause(summary), windClause(summary), precipClause(summary)].filter(
    (c): c is string => c !== null,
  );

  if (clauses.length === 0) return null;
  return clauses.join(", ");
}
