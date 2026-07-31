/**
 * Weather intelligence — the provider seam (types).
 *
 * The pure data contract. NO `server-only`, NO I/O, NO vendor SDK, NO
 * `process.env` — so the decision layer, the readiness surface, the service and
 * the tests share ONE vocabulary and depend on the INTERFACE, never on a vendor.
 * This mirrors the role `lib/comms/types.ts` plays for the messaging transports
 * and `lib/ai/text/types.ts` plays for model access: the seam that makes "every
 * provider replaceable" true in code rather than in convention.
 *
 * TWO RULES carry the plug-in doctrine, identical to the comms seam:
 *
 *   - `getWeatherProvider()` (in ./index) returns `null` when nothing is
 *     configured. Nothing is configured anywhere — prod, CI or dev — so that
 *     null is the ONLY path this build exercises. Callers then report "not
 *     configured" and fetch NOTHING. That is the whole graceful-degradation
 *     contract and it is what makes this feature dark by construction rather
 *     than by a flag someone could flip by accident.
 *
 *   - `provider.fetchWindow()` THROWS on a provider failure (network, auth,
 *     rate-limit) rather than returning empty. An empty window and a failed
 *     fetch mean opposite things to a work-viability verdict: empty says "the
 *     weather is unknown", failed says "ask again". Collapsing them would let a
 *     rate-limited provider read as fine weather.
 */

// ---------------------------------------------------------------------------
// The key. See supabase/migrations/20261074000000_weather_intelligence.sql for
// the full argument; the short version is that a postcode district is the
// FINEST key that is simultaneously derivable from data this schema already
// holds, meaningful at the resolution UK forecast models actually run at, and
// free of customer-identifying detail.
// ---------------------------------------------------------------------------

/**
 * A UK postcode district — the outward code, uppercase, no whitespace ("LS1").
 * A branded alias rather than a bare `string`, so a full postcode cannot be
 * passed where a district is required without going through
 * {@link toPostcodeDistrict} in ./postcode, which is the one place that
 * normalises and validates.
 */
export type PostcodeDistrict = string & { readonly __brand: "PostcodeDistrict" };

/** Forecast (a prediction, expires) vs observation (a record of the past). */
export const WEATHER_READING_KINDS = ["forecast", "observation"] as const;
export type WeatherReadingKind = (typeof WEATHER_READING_KINDS)[number];

/**
 * One weather reading for one instant at one district.
 *
 * SI units throughout — m/s for wind, °C, mm — because the lifting and
 * concreting standards are written in those units, and comparing a threshold
 * against a number in a different unit is the classic way to get a safety
 * decision silently wrong. Conversion to mph happens at the display edge only.
 *
 * EVERY MEASUREMENT IS OPTIONAL, and that is load-bearing rather than lazy: no
 * provider supplies all of them, and the decision layer must distinguish "the
 * wind is calm" from "this provider does not report gusts". A missing metric can
 * never satisfy a threshold — see {@link assessWorkability} in ./decision.
 */
export type WeatherReading = {
  readonly district: PostcodeDistrict;
  readonly kind: WeatherReadingKind;
  /** The instant this reading describes. */
  readonly validAt: Date;
  /** Air temperature, °C. */
  readonly airTempC?: number | null;
  /** Mean wind speed, m/s. */
  readonly windSpeedMs?: number | null;
  /** Gust speed, m/s. The number that matters for a suspended load. */
  readonly windGustMs?: number | null;
  /** Precipitation intensity, mm/h. */
  readonly precipRateMmH?: number | null;
  /** Precipitation accumulated over this reading's interval, mm. */
  readonly precipTotalMm?: number | null;
  /** Probability of precipitation, 0–100. */
  readonly precipProbPct?: number | null;
  /** Relative humidity, 0–100. */
  readonly humidityPct?: number | null;
  /** Horizontal visibility, m. */
  readonly visibilityM?: number | null;
};

/**
 * The window a decision is made over, plus the context the readings alone
 * cannot carry.
 */
export type WeatherWindow = {
  readonly district: PostcodeDistrict;
  /** The readings covering the work period. May be empty — that means "unknown". */
  readonly readings: ReadonlyArray<WeatherReading>;
  /**
   * Rainfall in the days BEFORE the work, mm. Ground saturation is a function
   * of antecedent rainfall, not of the forecast for the day, so it cannot be
   * derived from `readings` and is supplied separately. Absent ⇒ saturation is
   * reported as unknown rather than assumed dry.
   */
  readonly antecedentPrecipMm?: number | null;
  /** The period `antecedentPrecipMm` covers, hours. Reported in the reasoning. */
  readonly antecedentWindowHours?: number | null;
  /**
   * How far the provider's answer was from the work, km, when known — the
   * auditable half of a variable-size district key (see the migration header).
   * Absent ⇒ the caveat says the distance is unknown.
   */
  readonly resolvedDistanceKm?: number | null;
};

// ---------------------------------------------------------------------------
// The provider seam.
// ---------------------------------------------------------------------------

/** The stable identity of a weather provider. Recorded on every cached row. */
export type WeatherProviderInfo = {
  /** Vendor id, lowercase — e.g. "metoffice", "open-meteo". */
  readonly provider: string;
  /**
   * The attribution string this vendor's licence REQUIRES on any surface that
   * displays its data. Part of the interface, not a UI detail: Open-Meteo's
   * data is CC-BY 4.0 and the Met Office's terms carry their own conditions, so
   * a provider that could be bound without declaring its attribution would be a
   * licence breach waiting for a deploy.
   */
  readonly attribution: string;
};

/**
 * The one interface weather intelligence knows.
 *
 * Implementations live behind the config-driven factory in ./index. There are
 * NO implementations in this build — that is the point. Adding one is a sibling
 * file plus a branch in the factory, and never a change to the decision layer.
 */
export interface WeatherProvider {
  readonly info: WeatherProviderInfo;
  /**
   * Fetch readings for one district covering `fromInclusive`–`toExclusive`.
   *
   * Resolves with the readings the provider returned (possibly empty, if the
   * provider genuinely has no data for the window), or THROWS on any provider
   * failure so the caller can distinguish "no weather" from "no answer".
   */
  fetchWindow(input: {
    readonly district: PostcodeDistrict;
    readonly kind: WeatherReadingKind;
    readonly fromInclusive: Date;
    readonly toExclusive: Date;
  }): Promise<ReadonlyArray<WeatherReading>>;
}
