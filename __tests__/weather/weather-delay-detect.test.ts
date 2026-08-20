import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeDelayDescription,
  detectStoppage,
  detectionTargetDate,
  planWeatherDelayDetections,
  runWeatherDelayDetection,
  weatherAutoDelayKey,
  type JobDetectionInput,
} from "@/server/services/weather-delay-detect";
import type { PostcodeDistrict, WeatherReading, WeatherWindow } from "@/lib/weather";

/**
 * Automatic weather → stoppage → delay-event detection.
 *
 * The load-bearing invariants, proven against real runs of the pure planner and
 * the orchestrator (an injected in-memory DB), never a source scan:
 *
 *   • STOPPAGE FROM READINGS — a definitive `not_viable` verdict raises a draft.
 *   • DARK-DEGRADATION — an empty window (every window while the cache is dark)
 *     raises NOTHING, both via the readiness gate (no DB touched) and via the
 *     decision layer's own `unknown`-for-empty invariant.
 *   • IDEMPOTENT — a second pass over the same day raises nothing new.
 *   • MANUAL-SAFE — a job with an existing (manual) weather delay is skipped and
 *     never overwritten; a WITHDRAWN one suppresses a re-raise too.
 */

const DISTRICT = "LS1" as PostcodeDistrict;

/** A reading fixture. Defaults are all-null; pass the metrics a case needs. */
function reading(validAt: string, m: Partial<WeatherReading> = {}): WeatherReading {
  return {
    district: DISTRICT,
    kind: "observation",
    validAt: new Date(validAt),
    airTempC: null,
    windSpeedMs: null,
    windGustMs: null,
    precipRateMmH: null,
    precipTotalMm: null,
    precipProbPct: null,
    humidityPct: null,
    visibilityM: null,
    ...m,
  };
}

/** A hard-frost day: air −2 °C, no rain — masonry & concrete are BLOCKING (below
 * the 3 °C / 0 °C limits), with no unevaluated threshold, so the verdict is a
 * definitive `not_viable` rather than `unknown`. */
function frostWindow(): WeatherWindow {
  return {
    district: DISTRICT,
    readings: [reading("2026-01-20T09:00:00Z", { airTempC: -2, precipRateMmH: 0 })],
    antecedentPrecipMm: null,
    antecedentWindowHours: null,
  };
}

// ── PURE: stoppage detection from readings ───────────────────────────────────

describe("detectStoppage", () => {
  it("flags a hard-frost day as a stoppage (definitive not_viable)", () => {
    const { blocked } = detectStoppage(frostWindow());
    expect(blocked.length).toBeGreaterThan(0);
    const types = blocked.map((b) => b.workType);
    expect(types).toContain("external_masonry");
    // Every reported block is a real blocking breach, never a data gap.
    for (const a of blocked) {
      expect(a.verdict).toBe("not_viable");
      expect(a.breaches.some((b) => b.severity === "blocking")).toBe(true);
    }
  });

  it("DARK-DEGRADATION: an empty window (no readings) blocks NOTHING", () => {
    const empty: WeatherWindow = {
      district: DISTRICT,
      readings: [],
      antecedentPrecipMm: null,
      antecedentWindowHours: null,
    };
    const { assessments, blocked } = detectStoppage(empty);
    expect(blocked).toHaveLength(0);
    // The invariant behind it: every verdict is `unknown`, never `not_viable`.
    expect(assessments.every((a) => a.verdict === "unknown")).toBe(true);
  });

  it("a benign day (mild, dry, calm) blocks nothing", () => {
    const benign: WeatherWindow = {
      district: DISTRICT,
      readings: [
        reading("2026-06-20T09:00:00Z", {
          airTempC: 18,
          windSpeedMs: 2,
          windGustMs: 3,
          precipRateMmH: 0,
          humidityPct: 50,
          visibilityM: 20000,
        }),
      ],
      antecedentPrecipMm: 0,
      antecedentWindowHours: 48,
    };
    expect(detectStoppage(benign).blocked).toHaveLength(0);
  });
});

// ── PURE: description is honest + machine-provenanced ─────────────────────────

describe("composeDelayDescription", () => {
  it("names the district, the day, the blocked activity, and says it is a draft for review", () => {
    const { blocked } = detectStoppage(frostWindow());
    const text = composeDelayDescription({ district: DISTRICT, date: "2026-01-20", blocked });
    expect(text).toContain("LS1");
    expect(text).toContain("2026-01-20");
    expect(text.toLowerCase()).toContain("draft");
    expect(text.toLowerCase()).toContain("review");
    expect(text).toMatch(/masonry/i);
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});

// ── PURE: deterministic idempotency key ──────────────────────────────────────

describe("weatherAutoDelayKey", () => {
  it("is a stable, valid UUID for a (job, day)", () => {
    const a = weatherAutoDelayKey("job-1", "2026-01-20");
    const b = weatherAutoDelayKey("job-1", "2026-01-20");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("differs by job and by day", () => {
    expect(weatherAutoDelayKey("job-1", "2026-01-20")).not.toBe(weatherAutoDelayKey("job-2", "2026-01-20"));
    expect(weatherAutoDelayKey("job-1", "2026-01-20")).not.toBe(weatherAutoDelayKey("job-1", "2026-01-21"));
  });
});

// ── PURE: the planner honours idempotency / manual / withdrawal ──────────────

describe("planWeatherDelayDetections", () => {
  const jobs: JobDetectionInput[] = [
    { id: "job-a", org_id: "org-1", district: DISTRICT },
    { id: "job-b", org_id: "org-1", district: null }, // no location — never assessed
  ];
  const windowByDistrict = new Map<string, WeatherWindow>([[DISTRICT, frostWindow()]]);

  it("raises exactly one detection for the located, stopped job", () => {
    const out = planWeatherDelayDetections({
      date: "2026-01-20",
      jobs,
      windowByDistrict,
      jobsWithExistingWeatherDelay: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.jobId).toBe("job-a");
    expect(out[0]!.district).toBe(DISTRICT);
    expect(out[0]!.blockedWorkTypes).toContain("external_masonry");
  });

  it("NO-DUP: a job that already has a weather delay for the day is skipped", () => {
    const out = planWeatherDelayDetections({
      date: "2026-01-20",
      jobs,
      windowByDistrict,
      jobsWithExistingWeatherDelay: new Set(["job-a"]), // manual/prior/withdrawn — any status
    });
    expect(out).toHaveLength(0);
  });

  it("a job with no district is never assessed even under stoppage conditions", () => {
    const out = planWeatherDelayDetections({
      date: "2026-01-20",
      jobs: [{ id: "job-b", org_id: "org-1", district: null }],
      windowByDistrict,
      jobsWithExistingWeatherDelay: new Set(),
    });
    expect(out).toHaveLength(0);
  });
});

describe("detectionTargetDate", () => {
  it("is the UK calendar day that just ended", () => {
    // 05:00Z on 2026-07-19 is still 2026-07-19 in BST ⇒ target is 2026-07-18.
    expect(detectionTargetDate(new Date("2026-07-19T05:00:00Z"))).toBe("2026-07-18");
  });
});

// ── ORCHESTRATOR: end-to-end against an injected in-memory DB ─────────────────

type Row = Record<string, unknown>;
type Filter = ["eq" | "gte" | "lt", string, unknown] | ["in", string, readonly unknown[]];

function match(row: Row, filters: Filter[]): boolean {
  for (const fl of filters) {
    const [op, key] = fl;
    const cell = row[key];
    if (op === "eq") {
      if (cell !== fl[2]) return false;
    } else if (op === "in") {
      if (!fl[2].includes(cell as never)) return false;
    } else if (op === "gte") {
      if (cell == null || String(cell) < String(fl[2])) return false;
    } else if (op === "lt") {
      if (cell == null || String(cell) >= String(fl[2])) return false;
    }
  }
  return true;
}

function makeDb(store: Record<string, Row[]>) {
  const reads: string[] = [];
  const from = (tableName: string) => {
    reads.push(tableName);
    const filters: Filter[] = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => (filters.push(["eq", k, v]), builder),
      gte: (k: string, v: unknown) => (filters.push(["gte", k, v]), builder),
      lt: (k: string, v: unknown) => (filters.push(["lt", k, v]), builder),
      in: (k: string, v: readonly unknown[]) => (filters.push(["in", k, v]), builder),
      order: () => builder,
      range: () =>
        Promise.resolve({ data: (store[tableName] ?? []).filter((r) => match(r, filters)), error: null }),
      insert: (row: Row) => {
        (store[tableName] ??= []).push({ id: `ins-${(store[tableName]?.length ?? 0) + 1}`, ...row });
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  };
  return { db: { from } as never, reads };
}

const FROST_NOW = new Date("2026-01-21T05:00:00Z"); // UK day 2026-01-21 (GMT) ⇒ target 2026-01-20
const TARGET = "2026-01-20";
const IN_DAY = "2026-01-20T09:00:00Z";

function seedStore(): Record<string, Row[]> {
  return {
    jobs: [
      {
        id: "job-a",
        org_id: "org-1",
        status: "in-progress",
        customer_id: null,
        site_address_line1: "1 Site St",
        site_postcode: "LS1 4AP",
      },
      {
        id: "job-done",
        org_id: "org-1",
        status: "completed",
        customer_id: null,
        site_postcode: "LS1 4AP",
      },
    ],
    customers: [],
    weather_readings: [
      {
        postcode_district: "LS1",
        kind: "observation",
        valid_at: IN_DAY,
        air_temp_c: -2,
        wind_speed_ms: null,
        wind_gust_ms: null,
        precip_rate_mm_h: 0,
        precip_total_mm: 0,
        precip_prob_pct: null,
        humidity_pct: null,
        visibility_m: null,
      },
    ],
    delay_events: [],
  };
}

describe("runWeatherDelayDetection (orchestrator)", () => {
  const saved = {
    provider: process.env.WEATHER_PROVIDER,
    key: process.env.OPEN_METEO_API_KEY,
  };

  function activate() {
    process.env.WEATHER_PROVIDER = "open-meteo";
    process.env.OPEN_METEO_API_KEY = "test-key-for-detection-suite";
  }

  afterEach(() => {
    if (saved.provider === undefined) delete process.env.WEATHER_PROVIDER;
    else process.env.WEATHER_PROVIDER = saved.provider;
    if (saved.key === undefined) delete process.env.OPEN_METEO_API_KEY;
    else process.env.OPEN_METEO_API_KEY = saved.key;
  });

  it("DARK GATE: with no provider bound it reads/writes NOTHING", async () => {
    delete process.env.WEATHER_PROVIDER;
    delete process.env.OPEN_METEO_API_KEY;
    const store = seedStore();
    const { db, reads } = makeDb(store);
    const summary = await runWeatherDelayDetection({ now: FROST_NOW, db });
    expect(summary.ran).toBe(false);
    expect(summary.ok).toBe(true);
    expect(reads).toHaveLength(0); // zero DB access on the dark path
    expect(store.delay_events).toHaveLength(0);
  });

  it("raises a DRAFT weather delay for a live job under stoppage conditions", async () => {
    activate();
    const store = seedStore();
    const { db } = makeDb(store);
    const summary = await runWeatherDelayDetection({ now: FROST_NOW, db });
    expect(summary.ran).toBe(true);
    expect(summary.ok).toBe(true);
    expect(summary.date).toBe(TARGET);
    expect(summary.detected).toBe(1);
    expect(summary.created).toBe(1);

    expect(store.delay_events).toHaveLength(1);
    const row = store.delay_events![0]!;
    expect(row.category).toBe("weather");
    expect(row.job_id).toBe("job-a"); // the completed job is never assessed
    expect(row.org_id).toBe("org-1");
    expect(row.started_on).toBe(TARGET);
    expect(row.ended_on).toBe(TARGET);
    expect(row.weather_district).toBe("LS1"); // the EOT evidence seam
    expect(row.working_days_lost).toBeNull(); // never computed
    expect(row.created_by).toBeNull(); // no human authored it
    expect(row.status ?? "draft").toBe("draft"); // born a draft (DB default)
    expect(typeof row.client_write_key).toBe("string");
    expect(row.client_write_key).toBe(weatherAutoDelayKey("job-a", TARGET));
  });

  it("IDEMPOTENT: a second pass raises nothing new (existing weather delay found)", async () => {
    activate();
    const store = seedStore();
    const { db } = makeDb(store);
    await runWeatherDelayDetection({ now: FROST_NOW, db });
    const second = await runWeatherDelayDetection({ now: FROST_NOW, db });
    expect(second.created).toBe(0);
    expect(second.detected).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(store.delay_events).toHaveLength(1); // still exactly one
  });

  it("MANUAL-SAFE: a pre-existing manual weather delay is never overwritten or duplicated", async () => {
    activate();
    const store = seedStore();
    store.delay_events!.push({
      id: "manual-1",
      org_id: "org-1",
      job_id: "job-a",
      category: "weather",
      started_on: TARGET,
      status: "recorded",
      description: "Human account of the frost stoppage.",
      created_by: "user-1",
      recorded_by: "user-1",
    });
    const { db } = makeDb(store);
    const summary = await runWeatherDelayDetection({ now: FROST_NOW, db });
    expect(summary.created).toBe(0);
    expect(summary.skippedExisting).toBe(1);
    expect(store.delay_events).toHaveLength(1);
    // The human's row is untouched.
    expect(store.delay_events![0]!.id).toBe("manual-1");
    expect(store.delay_events![0]!.description).toBe("Human account of the frost stoppage.");
  });

  it("DARK-DEGRADATION even when 'available': no cached readings ⇒ no delay", async () => {
    activate();
    const store = seedStore();
    store.weather_readings = []; // provider notionally bound, but cache empty
    const { db } = makeDb(store);
    const summary = await runWeatherDelayDetection({ now: FROST_NOW, db });
    expect(summary.ran).toBe(true);
    expect(summary.detected).toBe(0);
    expect(summary.created).toBe(0);
    expect(store.delay_events).toHaveLength(0);
  });
});
