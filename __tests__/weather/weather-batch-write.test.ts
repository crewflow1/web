import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PostcodeDistrict, WeatherProvider, WeatherReading } from "@/lib/weather/types";

/**
 * WEATHER FETCH WRITE PATH — batch-poisoning containment (the unswept C61 sibling).
 *
 * The district×kind upsert was ONE statement with no chunk and no per-row fallback:
 * a single out-of-range reading (a CHECK/precision the mapper didn't mirror) aborted
 * the district's WHOLE write → 0 rows → isFresh() stayed false (it needs a row) → the
 * district was re-fetched-and-re-failed every tick, permanently denying weather to
 * EVERY org watching it (the cache is global by district). These prove the fix:
 *
 *   1. a 23514 chunk falls back per-row — the good readings LAND (so the district is
 *      fresh next tick), the offending one is dropped, and the run is loud (ok:false);
 *   2. a large batch is chunked (<=500 per statement);
 * mirroring the telematics chunked-write posture.
 */

const adminHolder = vi.hoisted(() => ({
  create: (): unknown => {
    throw new Error("createAdminClient called before the test configured a fake");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.create(),
}));

const { runWeatherFetch } = await import("@/server/services/weather-fetch");

type UpsertCall = { rows: Array<Record<string, unknown>> };

/** Admin fake whose weather_readings upsert behaviour is scripted per chunk/row. */
function makeAdmin(config: {
  watches: Array<{ postcode_district: string }>;
  upsert: (rows: Array<Record<string, unknown>>) => { error: { message: string; code?: string } | null };
}) {
  const upserts: UpsertCall[] = [];
  const thenable = (data: unknown) => {
    const obj: Record<string, unknown> = {};
    obj["eq"] = () => obj;
    obj["in"] = () => obj;
    obj["gte"] = () => obj;
    obj["order"] = () => obj;
    obj["range"] = () => Promise.resolve({ data, error: null });
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
    return obj;
  };
  const client = {
    from(table: string) {
      if (table === "weather_watches") {
        return { select: () => thenable(config.watches) };
      }
      if (table === "weather_readings") {
        return {
          select: () => thenable([]), // nothing fresh ⇒ everything is fetched
          upsert: (rows: Array<Record<string, unknown>>) => {
            upserts.push({ rows });
            return Promise.resolve(config.upsert(rows));
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts };
}

const NOW = new Date("2026-11-12T09:30:00Z");

function reading(district: string, kind: "forecast" | "observation", atIso: string): WeatherReading {
  return {
    district: district as PostcodeDistrict,
    kind,
    validAt: new Date(atIso),
    airTempC: 4.2,
    windGustMs: 11.5,
    precipTotalMm: 0.4,
    precipRateMmH: 0.4,
  };
}

function makeProvider(readings: string[]) {
  const fetchWindow = vi.fn(async (input: Parameters<WeatherProvider["fetchWindow"]>[0]) =>
    readings.map((iso) => reading(input.district, input.kind, iso)),
  );
  const provider: WeatherProvider = {
    info: { provider: "open-meteo", attribution: "test attribution" },
    fetchWindow,
  };
  return { provider, fetchWindow };
}

const LIVE_ENV = () => {
  vi.stubEnv("WEATHER_PROVIDER", "open-meteo");
  vi.stubEnv("OPEN_METEO_API_KEY", "test-key");
};

beforeEach(() => {
  adminHolder.create = () => {
    throw new Error("createAdminClient called before the test configured a fake");
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const R10 = "2026-11-12T10:00:00.000Z";
const R11 = "2026-11-12T11:00:00.000Z"; // the poison instant
const R12 = "2026-11-12T12:00:00.000Z";

describe("runWeatherFetch — per-row fallback contains a poison reading", () => {
  it("lands the good readings and drops only the CHECK-violating one — district is NOT stranded at zero", async () => {
    LIVE_ENV();
    // A multi-row chunk 23514s; per-row, only the R11 instant is uninsertable.
    const { client, upserts } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      upsert: (rows) => {
        if (rows.length > 1) return { error: { message: "check_violation", code: "23514" } };
        const poison = rows[0]?.["valid_at"] === R11;
        return poison ? { error: { message: "check_violation", code: "23514" } } : { error: null };
      },
    });
    adminHolder.create = () => client;
    const { provider } = makeProvider([R10, R11, R12]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const summary = await runWeatherFetch({ now: NOW, provider });

      // Loud: a dropped constraint row makes the run not-ok...
      expect(summary.ok).toBe(false);
      // ...but the good rows LANDED (2 per kind × forecast+observation = 4), so the
      // district becomes fresh and is not re-fetched-and-re-failed forever.
      expect(summary.written).toBe(4);
      const written = summary.outcomes.filter((o) => o.outcome === "written");
      expect(written).toHaveLength(2);
      for (const o of written) {
        expect(o.readingsWritten).toBe(2);
        expect(o.detail).toMatch(/partial/);
      }
      // The write path per kind: 1 chunk (3 rows) + 3 per-row upserts.
      expect(upserts.some((c) => c.rows.length === 3)).toBe(true);
      expect(upserts.filter((c) => c.rows.length === 1).length).toBe(6); // 3 per-row × 2 kinds
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("runWeatherFetch — chunks a large batch", () => {
  it("splits a >500-reading batch into <=500-per-statement upserts", async () => {
    LIVE_ENV();
    const { client, upserts } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      upsert: () => ({ error: null }),
    });
    adminHolder.create = () => client;
    // 650 distinct instants (unique valid_at so none dedupe away).
    const instants = Array.from({ length: 650 }, (_, i) =>
      new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(),
    );
    const { provider } = makeProvider(instants);

    const summary = await runWeatherFetch({ now: NOW, provider });

    expect(summary.ok).toBe(true);
    // Each kind: 650 rows ⇒ chunks of [500, 150]. No statement exceeds 500.
    for (const c of upserts) expect(c.rows.length).toBeLessThanOrEqual(500);
    expect(upserts.some((c) => c.rows.length === 500)).toBe(true);
    expect(upserts.some((c) => c.rows.length === 150)).toBe(true);
    // forecast + observation, 650 each.
    expect(summary.written).toBe(1300);
  });
});
