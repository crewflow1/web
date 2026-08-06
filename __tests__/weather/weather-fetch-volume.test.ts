import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostcodeDistrict, WeatherProvider, WeatherReading } from "@/lib/weather/types";

/**
 * WEATHER FETCH PIPELINE — volume / F-1 truncation proof (C35-C).
 *
 * The confirmed launch blocker: `runWeatherFetch` read `weather_watches` and
 * `weather_readings` with BARE, unordered `.select()`s (routed through a local
 * `table()` `.from` wrapper, which is how they evaded the F-1 guards). PostgREST
 * clamps every response at max_rows=1000, so:
 *
 *   · WATCHES — a national watch list crosses 1000 rows and, with many jobs per
 *     district, the first 1000 rows cover only a HANDFUL of distinct districts.
 *     Every district past that boundary was silently dropped → those tenants got
 *     no weather at all. The 200-district cap must be applied to the COMPLETE
 *     district set, so paging MUST happen BEFORE dedupe/slice.
 *   · FRESHNESS — a truncated freshness read makes cached-and-fresh districts
 *     look stale, so isFresh() returns false and the pipeline re-fetches them,
 *     burning the vendor call budget it exists to conserve.
 *
 * Both reads are now paged via fetchAllRows (watches on a unique total order;
 * readings chunked ≤200 then paged). This suite MODELS the max_rows=1000 clamp
 * on every read and seeds well past it. The pre-fix bare reads fail every
 * assertion here.
 *
 * Hermetic: a cap-emulating fake admin client — no Supabase, no realtime client,
 * no network, Node-20.
 */

const CLAMP = 1000; // PostgREST default max_rows — the truncation boundary.
type Row = Record<string, unknown>;
type State = { weather_watches: Row[]; weather_readings: Row[] };

function makeAdmin(state: State) {
  const upserts: Row[] = [];
  const readingInBatchSizes: number[] = [];

  function selectBuilder(rows: Row[], onIn?: (n: number) => void) {
    const preds: Array<(r: Row) => boolean> = [];
    const orderSpecs: Array<[string, boolean]> = [];
    const compute = (): Row[] => {
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (orderSpecs.length) {
        out = [...out].sort((a, b) => {
          for (const [c, asc] of orderSpecs) {
            const av = a[c] as string;
            const bv = b[c] as string;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
          }
          return 0;
        });
      }
      return out;
    };
    const builder: Record<string, unknown> = {};
    builder["select"] = () => builder;
    builder["eq"] = (c: string, v: unknown) => (preds.push((r) => r[c] === v), builder);
    builder["gte"] = (c: string, v: unknown) =>
      (preds.push((r) => String(r[c]) >= String(v)), builder);
    builder["in"] = (c: string, v: readonly unknown[]) => {
      if (onIn) onIn(v.length);
      preds.push((r) => v.includes(r[c]));
      return builder;
    };
    builder["order"] = (c: string, o: { ascending: boolean }) =>
      (orderSpecs.push([c, o.ascending !== false]), builder);
    // The clamp: a page window never exceeds CLAMP rows.
    builder["range"] = (from: number, to: number) =>
      Promise.resolve({
        data: compute().slice(from, from + Math.min(to - from + 1, CLAMP)),
        error: null,
      });
    // A bare (unpaged) await would be clamped at CLAMP — exactly like PostgREST,
    // so if the pipeline ever regressed to a bare read this suite would catch it.
    builder["then"] = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: compute().slice(0, CLAMP), error: null }).then(res);
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "weather_watches") {
        return { select: () => selectBuilder(state.weather_watches) };
      }
      if (table === "weather_readings") {
        return {
          select: () => selectBuilder(state.weather_readings, (n) => readingInBatchSizes.push(n)),
          upsert: (rows: Row[]) => {
            upserts.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts, readingInBatchSizes };
}

const adminHolder = vi.hoisted(() => ({
  create: (): unknown => {
    throw new Error("createAdminClient called before the test configured a fake");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminHolder.create() }));

const { runWeatherFetch } = await import("@/server/services/weather-fetch");

const NOW = new Date("2026-11-12T09:30:00Z");

const LIVE_ENV = () => {
  vi.stubEnv("WEATHER_PROVIDER", "open-meteo");
  vi.stubEnv("OPEN_METEO_API_KEY", "test-key");
};

/** A provider that RECORDS every window it is asked for — the budget spend. */
function makeProvider() {
  const fetchWindow = vi.fn(async (input: Parameters<WeatherProvider["fetchWindow"]>[0]) => {
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
  return { provider, fetchWindow };
}

/** Generate `n` DISTINCT, syntactically valid outward codes (^[A-Z]{1,2}[0-9][A-Z0-9]?$). */
function makeDistricts(n: number): string[] {
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const out: string[] = [];
  for (const l2 of letters) {
    for (let d1 = 1; d1 <= 9; d1++) {
      for (let d2 = 0; d2 <= 9; d2++) {
        out.push(`A${l2}${d1}${d2}`);
        if (out.length >= n) return out;
      }
    }
  }
  return out;
}

beforeEach(() => {
  adminHolder.create = () => {
    throw new Error("createAdminClient called before the test configured a fake");
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runWeatherFetch — the watch set is PAGED IN FULL before dedupe/slice", () => {
  it("gathers districts from beyond row 1000 (a clamped read would see far fewer)", async () => {
    LIVE_ENV();
    // 250 distinct districts × 20 job-watches each = 5000 watch rows. Ordered by
    // postcode_district, the first 1000 rows cover only 50 distinct districts —
    // so a bare (clamped) read could surface AT MOST 50, and every district past
    // the boundary would silently get no weather.
    const districts = makeDistricts(250);
    expect(districts.length).toBe(250);
    const watches: Row[] = [];
    let seq = 0;
    for (const d of districts) {
      for (let k = 0; k < 20; k++) {
        const tag = String(seq++).padStart(6, "0");
        watches.push({ id: `w-${tag}`, job_id: `j-${tag}`, postcode_district: d, active: true });
      }
    }
    expect(watches.length).toBe(5000);

    const { client } = makeAdmin({ weather_watches: watches, weather_readings: [] });
    adminHolder.create = () => client;
    const { provider } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });

    // The crux: the FULL 5000-row set was paged, deduped to 250 distinct
    // districts, THEN capped at MAX_DISTRICTS_PER_RUN=200 — impossible under a
    // 1000-row clamp, which would yield at most 50 distinct districts.
    expect(summary.ran).toBe(true);
    expect(summary.districtCount).toBe(200);

    // The 200th sorted district lives ~row 3980 in the raw read — it can only be
    // present because paging reached far past row 1000.
    const sorted = [...new Set(districts)].sort();
    const beyondClamp = sorted[199]!;
    const seenDistricts = new Set(summary.outcomes.map((o) => o.district));
    expect(seenDistricts.has(beyondClamp as PostcodeDistrict)).toBe(true);
    expect(seenDistricts.size).toBe(200);
  });
});

describe("runWeatherFetch — the freshness read is COMPLETE (no redundant vendor calls)", () => {
  it("sees every fresh cache row past the clamp, so a fresh district is never refetched", async () => {
    LIVE_ENV();
    // Two resolvable districts. LS1 alone carries >1000 recent readings, so a
    // clamped freshness read is entirely consumed by LS1's forecast rows — LS1's
    // observations and ALL of LS2 would look stale and be re-fetched. Paged, the
    // whole set is seen and everything reads fresh.
    const watches: Row[] = [
      { id: "w-1", job_id: "j-1", postcode_district: "LS1", active: true },
      { id: "w-2", job_id: "j-2", postcode_district: "LS2", active: true },
    ];
    const recentFetchedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1 h ago: fresh
    const readings: Row[] = [];
    const push = (district: string, kind: string, count: number) => {
      for (let i = 0; i < count; i++) {
        readings.push({
          provider: "open-meteo",
          postcode_district: district,
          kind,
          valid_at: new Date(NOW.getTime() + i * 3600_000).toISOString(),
          fetched_at: recentFetchedAt,
        });
      }
    };
    push("LS1", "forecast", 1100); // alone exceeds the 1000-row clamp
    push("LS1", "observation", 1100);
    push("LS2", "forecast", 1);
    push("LS2", "observation", 1);
    expect(readings.length).toBe(2202);

    const { client, readingInBatchSizes } = makeAdmin({
      weather_watches: watches,
      weather_readings: readings,
    });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });

    expect(summary.ran).toBe(true);
    expect(summary.districtCount).toBe(2);
    // Every district×kind pair read fresh from the COMPLETE freshness set, so the
    // provider was never called. A clamped read would have re-fetched LS1's
    // observations and both of LS2's windows (3 wasted vendor calls).
    expect(fetchWindow).not.toHaveBeenCalled();
    expect(summary.outcomes.filter((o) => o.outcome === "fresh")).toHaveLength(4);
    // The district `.in()` was chunked at ≤200 (here a single 2-id batch).
    expect(Math.max(...readingInBatchSizes)).toBeLessThanOrEqual(200);
  });
});
