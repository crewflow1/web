import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PostcodeDistrict, WeatherProvider, WeatherReading } from "@/lib/weather/types";
import { WeatherProviderError } from "@/lib/weather/types";

/**
 * The fetch/cache pipeline — behaviour proofs with a MOCKED provider and a
 * MOCKED admin client. Nothing here touches a network or a database; what is
 * proven is the pipeline's own discipline:
 *
 *   - the dark short-circuit constructs NO client (runtime twin of the
 *     security suite's source-order pin);
 *   - upsert lands on the migration's identity with per-kind expires_at and
 *     the resolver's provenance coordinates;
 *   - fresh cache ⇒ no provider call (the freshness economics);
 *   - unresolvable district ⇒ recorded outcome, no call, NO GUESSING;
 *   - retry only on retryable failures, with bounded jittered backoff
 *     (injected sleep — no real timers);
 *   - the consecutive-failure breaker trips and the run stops spending.
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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UpsertCall = { table: string; rows: Array<Record<string, unknown>>; onConflict?: string };
type FreshRow = { postcode_district: string; kind: string; fetched_at: string };

function makeAdmin(config: {
  watches?: Array<{ postcode_district: string }> | { error: string };
  fresh?: FreshRow[] | { error: string };
  upsertError?: string;
}) {
  const upserts: UpsertCall[] = [];
  const result = (data: unknown, err?: string) =>
    err ? { data: null, error: { message: err } } : { data, error: null };

  const thenable = (r: { data: unknown; error: unknown }) => {
    const obj: Record<string, unknown> = {};
    obj["eq"] = () => obj;
    obj["in"] = () => obj;
    obj["gte"] = () => obj;
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(r).then(res);
    return obj;
  };

  const client = {
    from(table: string) {
      if (table === "weather_watches") {
        const w = config.watches ?? [];
        return {
          select: () => thenable(Array.isArray(w) ? result(w) : result(null, w.error)),
        };
      }
      if (table === "weather_readings") {
        const f = config.fresh ?? [];
        return {
          select: () => thenable(Array.isArray(f) ? result(f) : result(null, f.error)),
          upsert: (rows: Array<Record<string, unknown>>, opts?: { onConflict?: string }) => {
            upserts.push({ table, rows, onConflict: opts?.onConflict });
            return Promise.resolve(result(null, config.upsertError));
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, upserts };
}

const NOW = new Date("2026-11-12T09:30:00Z");
const HOUR = new Date("2026-11-12T09:00:00Z");

function reading(district: string, kind: "forecast" | "observation", at: string): WeatherReading {
  return {
    district: district as PostcodeDistrict,
    kind,
    validAt: new Date(at),
    airTempC: 4.2,
    windGustMs: 11.5,
    precipTotalMm: 0.4,
    precipRateMmH: 0.4,
  };
}

function makeProvider(
  impl?: (input: Parameters<WeatherProvider["fetchWindow"]>[0]) => Promise<ReadonlyArray<WeatherReading>>,
) {
  const fetchWindow = vi.fn(
    impl ??
      (async (input) => [
        reading(input.district, input.kind, input.fromInclusive.toISOString()),
      ]),
  );
  const provider: WeatherProvider = {
    info: { provider: "open-meteo", attribution: "test attribution" },
    fetchWindow,
  };
  return { provider, fetchWindow };
}

/** Recorded sleeps — the pipeline must never actually wait in a test. */
function makeSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
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

// ---------------------------------------------------------------------------

describe("the dark short-circuit", () => {
  it("with no configuration: ran=false, and NO admin client is ever constructed", async () => {
    const create = vi.fn(() => {
      throw new Error("dark path constructed a client");
    });
    adminHolder.create = create;
    const summary = await runWeatherFetch();
    expect(summary.ran).toBe(false);
    expect(summary.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("readiness/factory drift (available but no provider) is LOUD, not a silent no-op", async () => {
    // Env says live, but the cached lib/env has no key so the factory returns
    // null and nothing is injected — the drift branch must say so.
    LIVE_ENV();
    const summary = await runWeatherFetch({ now: NOW });
    expect(summary.ok).toBe(false);
    expect(summary.ran).toBe(false);
    expect(summary.note).toMatch(/drift/);
  });
});

describe("the write path", () => {
  it("upserts onto the identity with per-kind expires_at and the resolver's provenance", async () => {
    LIVE_ENV();
    const { client, upserts } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });

    expect(summary.ran).toBe(true);
    expect(summary.ok).toBe(true);
    expect(fetchWindow).toHaveBeenCalledTimes(2); // forecast + observation
    expect(upserts).toHaveLength(2);

    for (const call of upserts) {
      expect(call.onConflict).toBe("provider,postcode_district,kind,valid_at");
    }
    const forecastRow = upserts
      .flatMap((u) => u.rows)
      .find((r) => r["kind"] === "forecast")!;
    const observationRow = upserts
      .flatMap((u) => u.rows)
      .find((r) => r["kind"] === "observation")!;

    // Per-kind expiry, exactly as the CHECK demands.
    expect(forecastRow["expires_at"]).toBe(
      new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString(),
    );
    expect(observationRow["expires_at"]).toBeNull();

    // Provenance: the coordinate ACTUALLY asked about (LS1's ONSPD centroid),
    // recorded on every row — never null once a fetch has happened.
    expect(typeof forecastRow["resolved_lat"]).toBe("number");
    expect(typeof forecastRow["resolved_lon"]).toBe("number");
    expect(forecastRow["resolved_lat"]).toBeGreaterThan(53);
    expect(forecastRow["resolved_lat"]).toBeLessThan(54.5);
    expect(forecastRow["provider"]).toBe("open-meteo");
    expect(forecastRow["postcode_district"]).toBe("LS1");
    expect(forecastRow["fetched_at"]).toBe(NOW.toISOString());
    expect(forecastRow["air_temp_c"]).toBe(4.2);
    expect(summary.written).toBe(2);
  });

  it("asks the provider for the documented windows — 48 h ahead, 72 h antecedent lookback", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    await runWeatherFetch({ now: NOW, provider });

    const forecast = fetchWindow.mock.calls.find((c) => c[0].kind === "forecast")![0];
    const observation = fetchWindow.mock.calls.find((c) => c[0].kind === "observation")![0];
    expect(forecast.fromInclusive.toISOString()).toBe(HOUR.toISOString());
    expect(forecast.toExclusive.getTime() - forecast.fromInclusive.getTime()).toBe(
      48 * 60 * 60 * 1000,
    );
    expect(observation.toExclusive.toISOString()).toBe(HOUR.toISOString());
    expect(observation.toExclusive.getTime() - observation.fromInclusive.getTime()).toBe(
      72 * 60 * 60 * 1000,
    );
    // Coordinates come from the resolver, not from anywhere else.
    expect(forecast.coordinates.quality).toBe("centroid");
    expect(forecast.coordinates.source).toBe("ons_onspd");
  });

  it("dedupes duplicate valid_at instants within one batch — one upsert cannot touch a row twice", async () => {
    LIVE_ENV();
    const { client, upserts } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { provider } = makeProvider(async (input) => [
      reading(input.district, input.kind, "2026-11-12T10:00:00Z"),
      reading(input.district, input.kind, "2026-11-12T10:00:00Z"),
      reading(input.district, input.kind, "2026-11-12T11:00:00Z"),
    ]);

    const summary = await runWeatherFetch({ now: NOW, provider });
    for (const call of upserts) {
      expect(call.rows).toHaveLength(2);
    }
    expect(summary.written).toBe(4);
  });

  it("a failed upsert is a write_failed outcome and ok:false — never silent", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      upsertError: "column violates check constraint",
    });
    adminHolder.create = () => client;
    const { provider } = makeProvider();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runWeatherFetch({ now: NOW, provider });
      expect(summary.ok).toBe(false);
      expect(summary.outcomes.filter((o) => o.outcome === "write_failed")).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("skipping honestly", () => {
  it("collapses watches to distinct districts and drops invalid district shapes", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({
      watches: [
        { postcode_district: "LS1" },
        { postcode_district: "LS1" },
        { postcode_district: "not a district" },
      ],
    });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });
    expect(summary.districtCount).toBe(1);
    expect(fetchWindow).toHaveBeenCalledTimes(2);
  });

  it("skips a kind whose cache is FRESH, and refetches one gone stale", async () => {
    LIVE_ENV();
    const oneHourAgo = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const sevenHoursAgo = new Date(NOW.getTime() - 7 * 60 * 60 * 1000).toISOString();
    const { client } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      fresh: [
        // forecast fetched 1 h ago: fresh (6 h horizon). observation fetched
        // 7 h ago: still fresh (24 h horizon).
        { postcode_district: "LS1", kind: "forecast", fetched_at: oneHourAgo },
        { postcode_district: "LS1", kind: "observation", fetched_at: sevenHoursAgo },
      ],
    });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });
    expect(fetchWindow).not.toHaveBeenCalled();
    expect(summary.outcomes.filter((o) => o.outcome === "fresh")).toHaveLength(2);

    // Now age the forecast past its horizon: it alone is refetched.
    const { client: staleClient } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      fresh: [
        { postcode_district: "LS1", kind: "forecast", fetched_at: sevenHoursAgo },
        { postcode_district: "LS1", kind: "observation", fetched_at: sevenHoursAgo },
      ],
    });
    adminHolder.create = () => staleClient;
    const second = makeProvider();
    await runWeatherFetch({ now: NOW, provider: second.provider });
    expect(second.fetchWindow).toHaveBeenCalledTimes(1);
    expect(second.fetchWindow.mock.calls[0]![0].kind).toBe("forecast");
  });

  it("an unresolvable district is a RECORDED outcome with NO provider call — no guessing", async () => {
    LIVE_ENV();
    // ZZ9 is a syntactically valid outward code the ONSPD carries no centroid for.
    const { client, upserts } = makeAdmin({ watches: [{ postcode_district: "ZZ9" }] });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();

    const summary = await runWeatherFetch({ now: NOW, provider });
    expect(fetchWindow).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]!.outcome).toBe("unresolvable_district");
    // Skipping a gap is not a pipeline failure.
    expect(summary.ok).toBe(true);
  });

  it("EMPTY is not FAILED: zero readings is an `empty` outcome that never trips the breaker", async () => {
    LIVE_ENV();
    const { client, upserts } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { provider } = makeProvider(async () => []);

    const summary = await runWeatherFetch({ now: NOW, provider });
    expect(upserts).toHaveLength(0);
    expect(summary.ok).toBe(true);
    expect(summary.breakerTripped).toBe(false);
    expect(summary.outcomes.filter((o) => o.outcome === "empty")).toHaveLength(2);
  });
});

describe("retry, backoff and the breaker", () => {
  it("retries retryable failures with bounded, jittered, RECORDED delays — then succeeds", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { sleep, delays } = makeSleep();

    let calls = 0;
    const { provider, fetchWindow } = makeProvider(async (input) => {
      calls += 1;
      if (calls <= 2) {
        throw new WeatherProviderError({
          provider: "open-meteo",
          message: "HTTP 503",
          retryable: true,
          status: 503,
        });
      }
      return [reading(input.district, input.kind, input.fromInclusive.toISOString())];
    });

    const summary = await runWeatherFetch({
      now: NOW,
      provider,
      sleep,
      random: () => 0.5, // jitter factor (0.5 + 0.5) = 1 ⇒ delays are the base schedule
    });

    // First task (forecast) needed 3 attempts; observation succeeded first go.
    expect(fetchWindow).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000]);
    expect(summary.ok).toBe(true);
    expect(summary.outcomes.filter((o) => o.outcome === "written")).toHaveLength(2);
  });

  it("NEVER retries a deterministic refusal — that would spend budget for the same answer", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({ watches: [{ postcode_district: "LS1" }] });
    adminHolder.create = () => client;
    const { sleep, delays } = makeSleep();
    const { provider, fetchWindow } = makeProvider(async () => {
      throw new WeatherProviderError({
        provider: "open-meteo",
        message: "HTTP 400: bad parameter",
        retryable: false,
        status: 400,
      });
    });

    const summary = await runWeatherFetch({ now: NOW, provider, sleep });
    // One attempt per task, no sleeps at all.
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.outcomes.filter((o) => o.outcome === "provider_failed")).toHaveLength(2);
  });

  it("trips the breaker after 3 consecutive failed tasks and skips the rest of the run", async () => {
    LIVE_ENV();
    const { client, upserts } = makeAdmin({
      watches: [
        { postcode_district: "LS1" },
        { postcode_district: "LS2" },
        { postcode_district: "M1" },
      ],
    });
    adminHolder.create = () => client;
    const { sleep } = makeSleep();
    const { provider, fetchWindow } = makeProvider(async () => {
      throw new WeatherProviderError({
        provider: "open-meteo",
        message: "HTTP 503",
        retryable: true,
        status: 503,
      });
    });

    const summary = await runWeatherFetch({ now: NOW, provider, sleep, random: () => 0.5 });

    // 3 tasks exhausted (3 attempts each = 9 calls), then the breaker opens
    // and the remaining 3 tasks are skipped without a single further call.
    expect(fetchWindow).toHaveBeenCalledTimes(9);
    expect(summary.breakerTripped).toBe(true);
    expect(summary.outcomes.filter((o) => o.outcome === "provider_failed")).toHaveLength(3);
    expect(summary.outcomes.filter((o) => o.outcome === "breaker_open")).toHaveLength(3);
    expect(summary.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });
});

describe("loud reads", () => {
  it("a failed watch read aborts the run as ok:false — never 'nobody watches anything'", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({ watches: { error: "permission denied" } });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runWeatherFetch({ now: NOW, provider });
      expect(summary.ok).toBe(false);
      expect(summary.ran).toBe(true);
      expect(fetchWindow).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a failed freshness read aborts rather than refetching the whole watch list blind", async () => {
    LIVE_ENV();
    const { client } = makeAdmin({
      watches: [{ postcode_district: "LS1" }],
      fresh: { error: "timeout" },
    });
    adminHolder.create = () => client;
    const { provider, fetchWindow } = makeProvider();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await runWeatherFetch({ now: NOW, provider });
      expect(summary.ok).toBe(false);
      expect(fetchWindow).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
