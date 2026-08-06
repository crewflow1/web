import "server-only";

/**
 * Weather intelligence — the fetch/cache writer (the pipeline).
 *
 * The counterpart to server/services/weather.ts: that file READS the cache
 * through the tenant client so the watch-gated RLS boundary applies; this one
 * WRITES it, and must therefore run as SERVICE ROLE — `weather_readings` has
 * no INSERT policy by design (a tenant who could write a reading could forge
 * the weather a work-viability verdict is derived from), so service_role is
 * the only principal that can fill the cache. That makes this file one of the
 * legitimate elevated-privilege call sites lib/supabase/admin.ts enumerates:
 * an internal cron writing a GLOBAL (no org_id) table on behalf of every
 * tenant at once.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DARK SHORT-CIRCUIT COMES FIRST — zero DB reads, zero client construction
 * ═══════════════════════════════════════════════════════════════════════════
 * Readiness is checked before ANYTHING: on a dark build (`available` false —
 * the state of every environment today) this returns `{ ran: false }` without
 * constructing a Supabase client, resolving a provider, or reading a row.
 * Identical posture to buildWeatherSnapshot's short-circuit and the AI
 * governor's pre-reservation gate, and pinned the same way by the security
 * suite: source order says the readiness guard precedes createAdminClient.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONE RUN DOES (when live)
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. DISTRICTS — read the distinct postcode districts with an ACTIVE watch
 *      (any org: the cache is global, two builders in Leeds share one call —
 *      the economic argument of the district key, executable). This is the
 *      deliberate exception to the org-pinning house rule: org pinning
 *      protects TENANT-FACING reads from blending estates; this is a
 *      platform-wide pipeline whose entire point is the cross-tenant collapse,
 *      and nothing it reads ever reaches a screen.
 *   2. FRESHNESS — skip district×kind pairs whose cache was fetched recently:
 *        forecast:     fresh for 6 h  (4 refreshes/day — the cadence the
 *                      call-volume arithmetic in docs/weather/provider-options.md
 *                      is priced at)
 *        observation:  fresh for 24 h (the past does not change; once a day
 *                      collects yesterday as the archive publishes it)
 *   3. RESOLVE — district → WGS84 centroid via resolveDistrictCoordinates.
 *      Null ⇒ a recorded `unresolvable_district` outcome and NO fetch. Never
 *      guess: a forecast for the wrong place is worse than none.
 *   4. FETCH — one provider call per district×kind, windows:
 *        forecast:     [now floored to the hour, +48 h) — covers "can we pour
 *                      tomorrow" and the working week's front edge
 *        observation:  [-72 h, now) — the antecedent-rainfall window the
 *                      ground-saturation rules read
 *      Retry with bounded, jittered exponential backoff (below); a bounded
 *      consecutive-failure breaker stops the run burning call budget against
 *      a vendor that is down.
 *   5. UPSERT — onto the identity (provider, postcode_district, kind,
 *      valid_at), so a refreshed forecast REPLACES its predecessor; every row
 *      carries resolved_lat/resolved_lon (the provenance columns — what was
 *      ASKED is what is RECORDED) and per-kind expires_at exactly as the
 *      CHECKs demand: forecast NOT NULL (now + the 6 h freshness horizon),
 *      observation NULL (a record of fact does not expire).
 *
 * EMPTY ≠ FAILED, at every layer: a provider returning zero readings (the
 * archive's publication lag) is an `empty` outcome, recorded and moved past;
 * only a THROW is a failure, counted by the breaker.
 *
 * RETRY / BREAKER POLICY (here, not in the adapter — one policy for every
 * vendor, and no adapter gets to serialise hidden sleeps into the cron's
 * wall-clock budget):
 *   - up to 3 attempts per call, retrying ONLY failures the adapter classified
 *     retryable (429/5xx/network); deterministic refusals are never retried —
 *     that would spend budget to get the same answer;
 *   - delay = min(5 s, 500 ms × 2^(attempt−1)) × (0.5 + random()) — bounded,
 *     jittered, injectable for tests (no real sleeps in CI);
 *   - breaker: 3 CONSECUTIVE failed district×kind tasks trip it; every
 *     remaining task is recorded `breaker_open` and skipped. Per-run state
 *     only — the next scheduled tick starts closed, which is the retry.
 *
 * NOTHING SCHEDULES THIS TODAY. The cron seam exists
 * (app/api/cron/weather-fetch/route.ts) but is deliberately absent from
 * vercel.json; scheduling it is an activation step, not an engineering one.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  getWeatherProvider,
  getWeatherReadiness,
  isPostcodeDistrict,
  resolveDistrictCoordinates,
  WeatherProviderError,
  type DistrictCoordinates,
  type PostcodeDistrict,
  type WeatherProvider,
  type WeatherReading,
  type WeatherReadingKind,
} from "@/lib/weather";

// ---------------------------------------------------------------------------
// Policy constants — every number documented in the header above.
// ---------------------------------------------------------------------------

/** Forecast staleness horizon: refetch after 6 h (4 refreshes/day). */
const FORECAST_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Observation staleness horizon: refetch after 24 h. */
const OBSERVATION_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Forecast window: 48 h ahead. */
const FORECAST_HORIZON_MS = 48 * 60 * 60 * 1000;
/** Observation window: 72 h back — the antecedent-rainfall lookback. */
const OBSERVATION_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** A forecast row's expires_at = fetched_at + this (the refresh horizon). */
const FORECAST_TTL_MS = FORECAST_STALE_AFTER_MS;

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;
const BREAKER_TRIP_AFTER = 3;

/** Upper bound on districts per run — one runaway watch list cannot eat the budget. */
const MAX_DISTRICTS_PER_RUN = 200;

/**
 * How many district ids to send per `weather_readings` `.in()` batch. Mirrors
 * weather-watch-sync's CUSTOMER_IN_CHUNK: a wide `.in()` serialises every id
 * into the GET query string and overflows the request-line limit (→ 414/400),
 * so chunk at ≤200 and union — and each chunk is still PAGED so a chunk that
 * returns >1000 rows is never clamped either.
 */
const DISTRICT_IN_CHUNK = 200;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type WeatherFetchOutcomeKind =
  | "written" // provider answered, rows upserted
  | "empty" // provider answered with zero usable readings — NOT a failure
  | "fresh" // cache recent enough; no call made
  | "unresolvable_district" // no centroid for this district; no call made, no guessing
  | "provider_failed" // all attempts exhausted (or a non-retryable refusal)
  | "breaker_open" // skipped: the consecutive-failure breaker had tripped
  | "write_failed"; // provider answered but the upsert failed

export type WeatherFetchOutcome = {
  readonly district: PostcodeDistrict;
  /** null only for district-level skips (unresolvable_district). */
  readonly kind: WeatherReadingKind | null;
  readonly outcome: WeatherFetchOutcomeKind;
  readonly readingsWritten: number;
  readonly detail: string | null;
};

export type WeatherFetchSummary = {
  /** False when anything failed loudly (a read, a write, a provider). */
  readonly ok: boolean;
  /** False when the dark short-circuit returned before any work. */
  readonly ran: boolean;
  readonly provider: string | null;
  readonly districtCount: number;
  /** Total readings upserted across all outcomes. */
  readonly written: number;
  readonly breakerTripped: boolean;
  readonly outcomes: ReadonlyArray<WeatherFetchOutcome>;
  readonly note: string | null;
};

// Untyped-table access uses the established Loose idiom (see
// server/services/cis-deduction.ts and the WeatherReadingRow note in
// ./weather.ts): weather tables are deliberately not in lib/supabase/types.ts.
type LooseRes<T> = { data: T | null; error: { message: string; code?: string } | null };
type WatchRow = { postcode_district: string };
type FreshRow = { postcode_district: string; kind: string; fetched_at: string };
type ReadingsFilter<T> = PromiseLike<LooseRes<T[]>> & {
  eq: (k: string, v: unknown) => ReadingsFilter<T>;
  in: (k: string, v: readonly unknown[]) => ReadingsFilter<T>;
  gte: (k: string, v: unknown) => ReadingsFilter<T>;
  order: (k: string, o: { ascending: boolean }) => ReadingsFilter<T>;
  range: (from: number, to: number) => PromiseLike<PageResult<T>>;
};
type LooseTable = {
  select: <T>(cols: string) => ReadingsFilter<T>;
  upsert: (
    rows: ReadonlyArray<Record<string, unknown>>,
    opts?: { onConflict?: string },
  ) => PromiseLike<LooseRes<null>>;
};
type LooseAdmin = { from: (t: string) => unknown };
const table = (c: LooseAdmin, name: string): LooseTable => c.from(name) as LooseTable;

export type WeatherFetchOptions = {
  /** Injected clock, matching buildWeatherSnapshot — deterministic tests. */
  readonly now?: Date;
  /** Test seam: a mocked provider. Production resolves via the factory. */
  readonly provider?: WeatherProvider;
  /** Test seam: recorded instead of slept. Defaults to a real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam for the jitter. Defaults to Math.random. */
  readonly random?: () => number;
  readonly maxDistricts?: number;
};

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Floor to the start of the hour, so a window's readings align to the vendor's hourly grid. */
function floorToHour(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCMinutes(0, 0, 0);
  return t;
}

function failureDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run one bounded pass of the weather fetch pipeline. Never throws: every
 * failure is an outcome in the summary, because a cron that throws reports
 * less than a cron that returns what happened.
 */
export async function runWeatherFetch(
  options: WeatherFetchOptions = {},
): Promise<WeatherFetchSummary> {
  const readiness = getWeatherReadiness();

  // ── THE DARK SHORT-CIRCUIT. Before any client, any read, any provider. ────
  if (!readiness.available) {
    return {
      ok: true,
      ran: false,
      provider: null,
      districtCount: 0,
      written: 0,
      breakerTripped: false,
      outcomes: [],
      note: "weather is not available in this environment — nothing fetched, nothing read",
    };
  }

  const provider = options.provider ?? getWeatherProvider();
  if (provider === null) {
    // Readiness said available but the factory refused — configuration drift
    // between the two derivations. Loud, because silence here would look like
    // fair weather forever.
    console.error("[weather-fetch] readiness reports available but no provider resolved");
    return {
      ok: false,
      ran: false,
      provider: null,
      districtCount: 0,
      written: 0,
      breakerTripped: false,
      outcomes: [],
      note: "readiness/factory drift: available=true but getWeatherProvider()=null",
    };
  }

  const now = options.now ?? new Date();
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const maxDistricts = Math.min(options.maxDistricts ?? MAX_DISTRICTS_PER_RUN, MAX_DISTRICTS_PER_RUN);

  const admin = createAdminClient() as unknown as LooseAdmin;

  // ── 1. The districts under active watch, distinct, validated, bounded. ────
  // F-1: a national watch list crosses PostgREST's max_rows=1000 clamp, and a
  // bare `.select()` with no ORDER BY would nondeterministically DROP every
  // district past row 1000 — those tenants would silently get no weather at
  // all. Page the COMPLETE set on a UNIQUE total order (postcode_district,
  // job_id, id), THEN dedupe + cap, so MAX_DISTRICTS_PER_RUN is applied to the
  // whole district set rather than an arbitrary 1000-row prefix.
  const watchesRes = await fetchAllRows<WatchRow>((from, to) =>
    table(admin, "weather_watches")
      .select<WatchRow>("postcode_district")
      .eq("active", true)
      .order("postcode_district", { ascending: true })
      .order("job_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (watchesRes.error) {
    // LOUD READS: a failed read must never be mistaken for "nobody watches
    // anything" — that would silently stop all weather refresh forever.
    const err = watchesRes.error as SupabaseReadError;
    reportReadFailure("weather watches (fetch pipeline)", err);
    return {
      ok: false,
      ran: true,
      provider: provider.info.provider,
      districtCount: 0,
      written: 0,
      breakerTripped: false,
      outcomes: [],
      note: `watch read failed: ${err.message ?? "unknown"}`,
    };
  }

  const districts = [
    ...new Set(
      watchesRes.data
        .map((w) => w.postcode_district)
        .filter((d): d is PostcodeDistrict => isPostcodeDistrict(d)),
    ),
  ]
    .sort()
    .slice(0, maxDistricts);

  if (districts.length === 0) {
    return {
      ok: true,
      ran: true,
      provider: provider.info.provider,
      districtCount: 0,
      written: 0,
      breakerTripped: false,
      outcomes: [],
      note: "no active watches — nothing to fetch",
    };
  }

  // ── 2. Freshness: one read covering both kinds' horizons. ─────────────────
  const oldestCutoff = new Date(
    now.getTime() - Math.max(FORECAST_STALE_AFTER_MS, OBSERVATION_STALE_AFTER_MS),
  );
  // F-1: chunk the district `.in()` at ≤200 ids (a wide list would 414 the GET
  // request line) AND page each chunk. A national freshness read easily crosses
  // max_rows=1000, and a truncated freshness set makes fetched districts look
  // stale — isFresh() returns false, so the pipeline re-fetches them and burns
  // the vendor call budget redundantly. Page on the UNIQUE identity order
  // (postcode_district, kind, valid_at) with provider fixed by the .eq above.
  const recentRows: FreshRow[] = [];
  for (let i = 0; i < districts.length; i += DISTRICT_IN_CHUNK) {
    const batch = districts.slice(i, i + DISTRICT_IN_CHUNK);
    const chunk = await fetchAllRows<FreshRow>((from, to) =>
      table(admin, "weather_readings")
        .select<FreshRow>("postcode_district, kind, fetched_at")
        .eq("provider", provider.info.provider)
        .in("postcode_district", batch)
        .gte("fetched_at", oldestCutoff.toISOString())
        .order("postcode_district", { ascending: true })
        .order("kind", { ascending: true })
        .order("valid_at", { ascending: true })
        .range(from, to),
    );
    if (chunk.error) {
      // Failing closed on a freshness-read failure refuses to refetch the whole
      // watch list blind — the loud-read rule protecting the call budget too.
      const err = chunk.error as SupabaseReadError;
      reportReadFailure("weather readings freshness (fetch pipeline)", err);
      return {
        ok: false,
        ran: true,
        provider: provider.info.provider,
        districtCount: districts.length,
        written: 0,
        breakerTripped: false,
        outcomes: [],
        note: `freshness read failed: ${err.message ?? "unknown"}`,
      };
    }
    recentRows.push(...chunk.data);
  }

  const latestFetch = new Map<string, number>();
  for (const row of recentRows) {
    const at = Date.parse(row.fetched_at);
    if (Number.isNaN(at)) continue;
    const key = `${row.postcode_district}:${row.kind}`;
    const prev = latestFetch.get(key);
    if (prev === undefined || at > prev) latestFetch.set(key, at);
  }
  const isFresh = (district: PostcodeDistrict, kind: WeatherReadingKind): boolean => {
    const at = latestFetch.get(`${district}:${kind}`);
    if (at === undefined) return false;
    const horizon = kind === "forecast" ? FORECAST_STALE_AFTER_MS : OBSERVATION_STALE_AFTER_MS;
    return now.getTime() - at < horizon;
  };

  // ── The per-kind windows. ──────────────────────────────────────────────────
  const hourNow = floorToHour(now);
  const windows: Record<WeatherReadingKind, { from: Date; to: Date }> = {
    forecast: { from: hourNow, to: new Date(hourNow.getTime() + FORECAST_HORIZON_MS) },
    observation: { from: new Date(hourNow.getTime() - OBSERVATION_LOOKBACK_MS), to: hourNow },
  };

  // Function declarations hoist past the null guard above, so hand the
  // narrowed provider to the closure under its own binding.
  const boundProvider: WeatherProvider = provider;

  // ── Retry with bounded, jittered backoff. Policy documented in the header. ─
  async function callWithRetry(input: {
    readonly district: PostcodeDistrict;
    readonly coordinates: DistrictCoordinates;
    readonly kind: WeatherReadingKind;
  }): Promise<ReadonlyArray<WeatherReading>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await boundProvider.fetchWindow({
          district: input.district,
          coordinates: input.coordinates,
          kind: input.kind,
          fromInclusive: windows[input.kind].from,
          toExclusive: windows[input.kind].to,
        });
      } catch (e) {
        const retryable = e instanceof WeatherProviderError && e.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
        const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        await sleep(Math.round(base * (0.5 + random())));
      }
    }
  }

  // ── 3–5. The loop: resolve, fetch, upsert. ────────────────────────────────
  const outcomes: WeatherFetchOutcome[] = [];
  let written = 0;
  let ok = true;
  let consecutiveFailures = 0;
  let breakerTripped = false;

  const record = (o: WeatherFetchOutcome): void => {
    outcomes.push(o);
  };

  for (const district of districts) {
    const coordinates = resolveDistrictCoordinates(district);
    if (coordinates === null) {
      // NO GUESSING: no centroid ⇒ no call. GY/JE/IM and retired districts
      // land here; the outcome makes the gap visible instead of silent.
      record({
        district,
        kind: null,
        outcome: "unresolvable_district",
        readingsWritten: 0,
        detail: "no centroid in the ONSPD dataset — skipped, not guessed",
      });
      continue;
    }

    for (const kind of ["forecast", "observation"] as const) {
      if (breakerTripped) {
        record({
          district,
          kind,
          outcome: "breaker_open",
          readingsWritten: 0,
          detail: `skipped after ${BREAKER_TRIP_AFTER} consecutive provider failures`,
        });
        continue;
      }
      if (isFresh(district, kind)) {
        record({ district, kind, outcome: "fresh", readingsWritten: 0, detail: null });
        continue;
      }

      let readings: ReadonlyArray<WeatherReading>;
      try {
        readings = await callWithRetry({ district, coordinates, kind });
      } catch (e) {
        consecutiveFailures += 1;
        ok = false;
        if (consecutiveFailures >= BREAKER_TRIP_AFTER) breakerTripped = true;
        record({
          district,
          kind,
          outcome: "provider_failed",
          readingsWritten: 0,
          detail: failureDetail(e),
        });
        continue;
      }
      consecutiveFailures = 0;

      if (readings.length === 0) {
        // EMPTY ≠ FAILED: the vendor answered and has nothing (the archive
        // lag case). Recorded, not retried, not counted by the breaker.
        record({ district, kind, outcome: "empty", readingsWritten: 0, detail: null });
        continue;
      }

      // Dedupe on the identity's variable component within the batch — a
      // single upsert statement cannot touch the same row twice.
      const byValidAt = new Map<string, WeatherReading>();
      for (const r of readings) byValidAt.set(r.validAt.toISOString(), r);

      const rows = [...byValidAt.entries()].map(([validAtIso, r]) => ({
        provider: provider.info.provider,
        postcode_district: district,
        kind,
        valid_at: validAtIso,
        fetched_at: now.toISOString(),
        // Per-kind expiry, exactly as the CHECK demands: a forecast carries
        // its refresh horizon; an observation is a record of fact and has none.
        expires_at:
          kind === "forecast" ? new Date(now.getTime() + FORECAST_TTL_MS).toISOString() : null,
        // PROVENANCE: the coordinate the provider was ACTUALLY asked about —
        // from the resolver and nowhere else, so ask and record cannot drift.
        resolved_lat: coordinates.lat,
        resolved_lon: coordinates.lon,
        air_temp_c: r.airTempC ?? null,
        wind_speed_ms: r.windSpeedMs ?? null,
        wind_gust_ms: r.windGustMs ?? null,
        precip_rate_mm_h: r.precipRateMmH ?? null,
        precip_total_mm: r.precipTotalMm ?? null,
        precip_prob_pct: r.precipProbPct ?? null,
        humidity_pct: r.humidityPct ?? null,
        visibility_m: r.visibilityM ?? null,
      }));

      const wrote = await table(admin, "weather_readings").upsert(rows, {
        onConflict: "provider,postcode_district,kind,valid_at",
      });
      if (wrote.error) {
        ok = false;
        console.error("[weather-fetch] upsert failed", {
          district,
          kind,
          error: wrote.error.message,
        });
        record({
          district,
          kind,
          outcome: "write_failed",
          readingsWritten: 0,
          detail: wrote.error.message,
        });
        continue;
      }

      written += rows.length;
      record({ district, kind, outcome: "written", readingsWritten: rows.length, detail: null });
    }
  }

  return {
    ok,
    ran: true,
    provider: provider.info.provider,
    districtCount: districts.length,
    written,
    breakerTripped,
    outcomes,
    note: null,
  };
}
