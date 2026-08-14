import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostcodeDistrict, WeatherProvider, WeatherReading } from "@/lib/weather/types";
import { resolveDistrictCoordinates, isPostcodeDistrict } from "@/lib/weather";

/**
 * WEATHER FETCH — cron FAIRNESS regression (C71, the C39/C70-D class).
 *
 * The bug: the district list was `[...new Set(...)].sort().slice(0, 200)` — a
 * tick-stable LEXICOGRAPHIC order. Over a watch list larger than the cap, the same
 * lexicographically-first 200 districts were fetched every tick and every district
 * after them was NEVER a candidate — permanently empty. There was also no wall-
 * clock budget, so a large list could be killed mid-pass by maxDuration=60.
 *
 * The fix, proven here with a STATEFUL fake admin (upserts feed back into the
 * recency read, exactly like the real table) + an injected clock, no network:
 *
 *   1. PASS BUDGET — with more districts than the budget allows, the pass stops
 *      EARLY.
 *   2. NO PERMANENT TAIL — the district list is ordered by each district's most-
 *      recent fetched_at ASC (never-fetched first). A fetched district sinks; the
 *      un-fetched tail leads the next tick, so across consecutive passes EVERY
 *      district is eventually fetched. A lexicographic order + a cap would starve
 *      everything past the cap forever.
 */

type Row = Record<string, unknown>;

/** A stateful fake: upserted readings feed back into subsequent recency reads. */
function makeStatefulAdmin(watches: Row[]) {
  const readings: Row[] = [];

  function selectBuilder(rows: Row[]) {
    const preds: Array<(r: Row) => boolean> = [];
    const compute = (): Row[] => rows.filter((r) => preds.every((p) => p(r)));
    const b: Record<string, unknown> = {};
    b["select"] = () => b;
    b["eq"] = (c: string, v: unknown) => (preds.push((r) => r[c] === v), b);
    b["gte"] = (c: string, v: unknown) => (preds.push((r) => String(r[c]) >= String(v)), b);
    b["in"] = (c: string, v: readonly unknown[]) => (preds.push((r) => v.includes(r[c])), b);
    b["order"] = () => b;
    b["range"] = (from: number, to: number) =>
      Promise.resolve({ data: compute().slice(from, to + 1), error: null });
    b["then"] = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: compute(), error: null }).then(res);
    return b;
  }

  const client = {
    from(table: string) {
      if (table === "weather_watches") return { select: () => selectBuilder(watches) };
      if (table === "weather_readings") {
        return {
          select: () => selectBuilder(readings),
          upsert: (rows: Row[]) => {
            readings.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, readings };
}

const adminHolder = vi.hoisted(() => ({
  create: (): unknown => {
    throw new Error("createAdminClient called before the test configured a fake");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminHolder.create() }));

const { runWeatherFetch } = await import("@/server/services/weather-fetch");

const LIVE_ENV = () => {
  vi.stubEnv("WEATHER_PROVIDER", "open-meteo");
  vi.stubEnv("OPEN_METEO_API_KEY", "test-key");
};

function makeProvider() {
  const fetched: string[] = [];
  const fetchWindow = vi.fn(async (input: Parameters<WeatherProvider["fetchWindow"]>[0]) => {
    fetched.push(input.district);
    const r: WeatherReading = {
      district: input.district,
      kind: input.kind,
      validAt: input.fromInclusive,
      airTempC: 5,
    };
    return [r];
  });
  const provider: WeatherProvider = {
    info: { provider: "open-meteo", attribution: "test" },
    fetchWindow,
  };
  return { provider, fetchWindow, fetched };
}

/** A clock that advances by `step` ms on every call — deterministic budget. */
function steppingClock(step: number): () => number {
  let calls = 0;
  return () => step * calls++;
}

/** Five KNOWN-RESOLVABLE UK districts (guarded so an unresolvable one never skews counts). */
const DISTRICTS = ["LS1", "LS2", "M1", "B1", "E1"].filter(
  (d): d is PostcodeDistrict => isPostcodeDistrict(d) && resolveDistrictCoordinates(d) !== null,
);

// PER_DISTRICT_BUDGET_MS is 8_000 in the service; a budget just above it plus a
// 20ms/step clock lets exactly 2 districts run before the guard trips.
const PASS_BUDGET = 8_050;
const STEP = 20;

beforeEach(() => {
  adminHolder.create = () => {
    throw new Error("createAdminClient called before the test configured a fake");
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("weather pass budget stops the pass early", () => {
  it("fetches only what the budget allows, leaving the rest for the next tick", async () => {
    expect(DISTRICTS.length).toBe(5); // guard: all five resolvable
    LIVE_ENV();
    const watches = DISTRICTS.map((d, i) => ({
      id: `w-${i}`,
      job_id: `j-${i}`,
      postcode_district: d,
      active: true,
    }));
    const { client } = makeStatefulAdmin(watches);
    adminHolder.create = () => client;
    const { provider, fetched } = makeProvider();

    const summary = await runWeatherFetch({
      now: new Date("2026-11-12T09:30:00Z"),
      provider,
      sleep: async () => {},
      clock: steppingClock(STEP),
      passBudgetMs: PASS_BUDGET,
    });

    expect(summary.ran).toBe(true);
    // 5 districts under watch, only 2 fetched before the budget stopped the pass.
    const distinctFetched = new Set(fetched);
    expect(distinctFetched.size).toBe(2);
  });
});

describe("no permanent tail — every district is eventually fetched", () => {
  it("rotates the un-fetched tail in across consecutive fairly-ordered passes", async () => {
    LIVE_ENV();
    const watches = DISTRICTS.map((d, i) => ({
      id: `w-${i}`,
      job_id: `j-${i}`,
      postcode_district: d,
      active: true,
    }));
    const { client } = makeStatefulAdmin(watches);
    adminHolder.create = () => client;

    const everFetched = new Set<string>();
    // Advance wall-time by 25h each pass so a previously-fetched district is STALE
    // again (past both horizons) — isolating the recency ROTATION from the freshness
    // skip, which is proven separately in weather-fetch-service.
    const base = new Date("2026-11-12T00:00:00Z").getTime();
    for (let pass = 0; pass < 3; pass++) {
      const { provider, fetched } = makeProvider();
      await runWeatherFetch({
        now: new Date(base + pass * 25 * 60 * 60 * 1000),
        provider,
        sleep: async () => {},
        clock: steppingClock(STEP),
        passBudgetMs: PASS_BUDGET,
      });
      for (const d of fetched) everFetched.add(d);
      // Budget always bites: at most 2 distinct districts fetched per pass.
      expect(new Set(fetched).size).toBeLessThanOrEqual(2);
    }

    // Across passes the whole set was reached — the lexicographic tail is not starved.
    expect([...everFetched].sort()).toEqual([...DISTRICTS].sort());
  });
});
