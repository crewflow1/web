import "server-only";

/**
 * Weather intelligence — the read service.
 *
 * The composition layer between the cache (SQL), the decision layer (pure) and
 * the surfaces. It owns NO rules: thresholds live in lib/weather/thresholds.ts,
 * verdicts in lib/weather/decision.ts, the key in lib/weather/postcode.ts, and
 * activation state in lib/weather/readiness.ts. If a number here disagreed with
 * its own domain module that would be a bug in one shared function, not two
 * opinions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DARK SHORT-CIRCUIT COMES FIRST — before any database read
 * ═══════════════════════════════════════════════════════════════════════════
 * `buildWeatherSnapshot` checks readiness BEFORE it touches Postgres, exactly as
 * `invokeWithGovernor` short-circuits before it takes a budget reservation. The
 * reasoning is the same and it is not merely an optimisation:
 *
 *   With no provider bound, `weather_readings` is PROVABLY empty — the table has
 *   no INSERT policy, so only service_role can write it, and no code in this
 *   build writes it at all. A query would therefore return zero rows on every
 *   call, on every page load, for every user, forever. Skipping it means wiring
 *   this feature into a screen costs literally nothing measurable.
 *
 * The consequence a test pins: on a dark build this module issues NO query and
 * makes NO network call, and the snapshot it returns says "not configured"
 * rather than rendering an empty state that looks like fair weather.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO NETWORK. This file contains no `fetch`, no vendor SDK and no URL — it
 * reads the CACHE, never a vendor. Fetching lives behind the seam: the
 * open-meteo adapter (lib/weather/providers) called by the fetch pipeline
 * (server/services/weather-fetch.ts), both dark until a credential exists.
 * The security suite scans this file to keep the read side wire-free.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createClient } from "@/lib/supabase/server";
import { reportReadFailure } from "@/lib/supabase/read-failure";
import {
  assessAll,
  getWeatherReadiness,
  isPostcodeDistrict,
  weatherStatusLine,
  type PostcodeDistrict,
  type WeatherReading,
  type WeatherReadiness,
  type WeatherWindow,
  type WorkabilityAssessment,
  type WorkType,
} from "@/lib/weather";

/** A row of `public.weather_watches`, hand-typed. */
export type WeatherWatchRow = {
  readonly id: string;
  readonly postcode_district: string;
  readonly job_id: string | null;
  readonly site_id: string | null;
  readonly label: string | null;
  readonly active: boolean;
};

/**
 * A row of `public.weather_readings`, hand-typed.
 *
 * NOT regenerated into lib/supabase/types.ts, matching every table added since
 * `sites` (20261061) — `ai_quote_drafts`, `stock_items` and the rest are all
 * absent from it too. Regenerating that file is a separate, deliberate act with
 * its own review; a release train once failed its security gate on exactly that
 * diff. So untyped access uses the established `as never` / `as unknown as T`
 * idiom (server/services/ai-employees.ts documents it).
 */
type WeatherReadingRow = {
  readonly postcode_district: string;
  readonly kind: string;
  readonly valid_at: string;
  readonly air_temp_c: number | string | null;
  readonly wind_speed_ms: number | string | null;
  readonly wind_gust_ms: number | string | null;
  readonly precip_rate_mm_h: number | string | null;
  readonly precip_total_mm: number | string | null;
  readonly precip_prob_pct: number | null;
  readonly humidity_pct: number | null;
  readonly visibility_m: number | null;
};

/**
 * Postgres `numeric` arrives over PostgREST as a STRING, so a bare
 * `row.air_temp_c` would be `"3.0"` and every numeric comparison in the decision
 * layer would silently compare a string. Coerced here, at the boundary, once.
 */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toReading(row: WeatherReadingRow): WeatherReading | null {
  const district = row.postcode_district;
  if (!isPostcodeDistrict(district)) return null;
  if (row.kind !== "forecast" && row.kind !== "observation") return null;
  const validAt = new Date(row.valid_at);
  if (Number.isNaN(validAt.getTime())) return null;

  return {
    district,
    kind: row.kind,
    validAt,
    airTempC: num(row.air_temp_c),
    windSpeedMs: num(row.wind_speed_ms),
    windGustMs: num(row.wind_gust_ms),
    precipRateMmH: num(row.precip_rate_mm_h),
    precipTotalMm: num(row.precip_total_mm),
    precipProbPct: row.precip_prob_pct,
    humidityPct: row.humidity_pct,
    visibilityM: row.visibility_m,
  };
}

export type WeatherSnapshot = {
  /** The honest activation state. Always present, even on the dark path. */
  readonly readiness: WeatherReadiness;
  /** The one sentence a surface shows when `readiness.available` is false. */
  readonly statusLine: string;
  /** The district assessed, when one could be derived. */
  readonly district: PostcodeDistrict | null;
  /** The window the assessments were made over. Empty on a dark build. */
  readonly window: WeatherWindow | null;
  /** One assessment per requested work type. Every verdict is `unknown` on a dark build. */
  readonly assessments: ReadonlyArray<WorkabilityAssessment>;
  /**
   * True when this snapshot skipped the database entirely because no provider is
   * configured. Exported so the dark UI can say so and a test can prove it.
   */
  readonly shortCircuited: boolean;
};

/**
 * Build a weather snapshot for one district and a set of work types.
 *
 * `district` is the caller's business: for a job it comes from
 * `districtForAddress(resolveJobAddress(job, customer))`, which already encodes
 * the site-override-else-customer inheritance rule. Passing null (a job with no
 * postcode) is legitimate and yields a snapshot that says the location is
 * unknown rather than guessing.
 *
 * `now` is INJECTED rather than read from the clock, so the whole path stays
 * deterministic and a test can pin a window without mocking time.
 */
export async function buildWeatherSnapshot(input: {
  readonly orgId: string;
  readonly district: PostcodeDistrict | null;
  readonly workTypes: ReadonlyArray<WorkType>;
  readonly from: Date;
  readonly to: Date;
  /** Antecedent rainfall for the saturation rules, when known. */
  readonly antecedentPrecipMm?: number | null;
  readonly antecedentWindowHours?: number | null;
}): Promise<WeatherSnapshot> {
  const readiness = getWeatherReadiness();
  const statusLine = weatherStatusLine(readiness);

  // The empty window. Note it is still handed to the decision layer rather than
  // skipping assessment: the layer's answer to an empty window is `unknown` with
  // a caveat naming why, which is exactly what the surface should say. Returning
  // no assessments at all would let a screen render nothing and read as "fine".
  const emptyWindow = (district: PostcodeDistrict): WeatherWindow => ({
    district,
    readings: [],
    antecedentPrecipMm: input.antecedentPrecipMm ?? null,
    antecedentWindowHours: input.antecedentWindowHours ?? null,
  });

  // ── THE DARK SHORT-CIRCUIT. Before any query. ────────────────────────────
  if (!readiness.available) {
    return {
      readiness,
      statusLine,
      district: input.district,
      window: input.district === null ? null : emptyWindow(input.district),
      assessments:
        input.district === null ? [] : assessAll(emptyWindow(input.district), input.workTypes),
      shortCircuited: true,
    };
  }

  if (input.district === null) {
    return {
      readiness,
      statusLine,
      district: null,
      window: null,
      assessments: [],
      shortCircuited: false,
    };
  }

  const district = input.district;
  const supabase = await createClient();

  // Tenant client, not service_role: the cache's SELECT policy requires that one
  // of the caller's orgs watches this district, and reading through the tenant
  // client is what makes that boundary real rather than decorative. A service
  // client here would quietly bypass it.
  const { data, error } = await supabase
    .from("weather_readings" as never)
    .select(
      "postcode_district, kind, valid_at, air_temp_c, wind_speed_ms, wind_gust_ms, " +
        "precip_rate_mm_h, precip_total_mm, precip_prob_pct, humidity_pct, visibility_m",
    )
    .eq("postcode_district", district)
    .gte("valid_at", input.from.toISOString())
    .lt("valid_at", input.to.toISOString())
    .order("valid_at", { ascending: true });

  if (error) {
    // A failed read must NEVER render as an empty forecast — that is the exact
    // silent-empty-state class lib/supabase/read-failure.ts exists to stop, and
    // it is far worse here than on a holdings page: an empty window would show a
    // site manager "no weather warnings" when the truth is "we could not look".
    // Reported, then surfaced as `unknown` with the readiness line intact.
    reportReadFailure("weather readings", error);
    return {
      readiness,
      statusLine,
      district,
      window: emptyWindow(district),
      assessments: assessAll(emptyWindow(district), input.workTypes),
      shortCircuited: false,
    };
  }

  const readings = ((data ?? []) as unknown as WeatherReadingRow[])
    .map(toReading)
    .filter((r): r is WeatherReading => r !== null);

  const window: WeatherWindow = {
    district,
    readings,
    antecedentPrecipMm: input.antecedentPrecipMm ?? null,
    antecedentWindowHours: input.antecedentWindowHours ?? null,
  };

  return {
    readiness,
    statusLine,
    district,
    window,
    assessments: assessAll(window, input.workTypes),
    shortCircuited: false,
  };
}

/**
 * The org's own watch list.
 *
 * Deliberately NOT behind the readiness short-circuit: a watch is the ORG'S
 * configuration and exists independently of whether a provider is bound, so an
 * operator surface can honestly show "you are watching 3 districts; no provider
 * is connected yet" instead of pretending the list is empty.
 *
 * Org-pinned with an explicit `.eq("org_id", ...)` ON TOP of RLS. RLS uses
 * `current_org_ids()`, which for a dual-org user spans BOTH estates and would
 * blend two companies' watch lists onto one screen — the active-org defect class
 * that six read-side slices were spent closing.
 */
export async function readWeatherWatches(orgId: string): Promise<ReadonlyArray<WeatherWatchRow>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("weather_watches" as never)
    .select("id, postcode_district, job_id, site_id, label, active")
    .eq("org_id", orgId)
    .order("postcode_district", { ascending: true });

  if (error) {
    reportReadFailure("weather watches", error);
    return [];
  }

  return (data ?? []) as unknown as WeatherWatchRow[];
}
