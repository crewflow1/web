import { describe, it, expect, vi } from "vitest";

/**
 * EOT service — the ACTIVE path (weather bound), proven at runtime.
 *
 * When the governed accessor returns real observed readings for a weather
 * event's window, the service reduces them to evidence, sets
 * weatherEvidenceAvailable TRUE, and the provider-dark gap disappears. This is
 * the "the moment weather is activated, the value appears" guarantee — no
 * further engineering, just a live cache behind the accessor.
 */

const WEATHER_EVENT = {
  id: "ev-weather",
  job_id: "job-1",
  category: "weather",
  status: "recorded",
  started_on: "2026-07-01",
  ended_on: "2026-07-02",
  working_days_lost: 2,
  description: "Storm",
  diary_entry_id: null,
  variation_quote_id: null,
  weather_district: "LS1",
  recorded_at: "2026-07-02T18:00:00.000Z",
  recorded_by: "user-1",
  withdrawn_at: null,
  created_at: "2026-07-01T08:00:00.000Z",
};

const rowsByTable: Record<string, unknown[]> = {
  delay_events: [WEATHER_EVENT],
  quotes: [],
  site_diary_entries: [],
};

function stubClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "is", "order", "gte", "lt", "lte"]) {
        b[m] = () => b;
      }
      b.range = async () => ({ data: rowsByTable[table] ?? [], error: null });
      return b;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => stubClient() }));
vi.mock("@/server/services/job-progress", () => ({
  loadJobProgress: async () => ({ failed: false, summary: { points: [] } }),
}));

// Weather is "on": the accessor returns a live window of one observed reading.
vi.mock("@/lib/weather", async (orig) => ({
  ...(await orig<typeof import("@/lib/weather")>()),
  isWeatherAvailable: () => true,
}));

const OBSERVED = {
  district: "LS1",
  kind: "observation" as const,
  validAt: new Date("2026-07-01T12:00:00Z"),
  airTempC: 5,
  windSpeedMs: 12,
  windGustMs: 20,
  precipRateMmH: 4,
  precipTotalMm: 18,
  precipProbPct: null,
  humidityPct: 80,
  visibilityM: 3000,
};

const ATTRIBUTION =
  "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed under CC BY 4.0";

const buildWeatherSnapshot = vi.fn(async () => ({
  readiness: {} as never,
  statusLine: "active",
  attribution: ATTRIBUTION,
  district: "LS1",
  window: { district: "LS1", readings: [OBSERVED] },
  assessments: [],
  shortCircuited: false,
}));
vi.mock("@/server/services/weather", () => ({ buildWeatherSnapshot }));

const { loadEotEvidencePack } = await import("@/server/services/eot-pack");

describe("loadEotEvidencePack on the active path", () => {
  it("attaches observed evidence, flips weatherEvidenceAvailable, and drops the dark gap", async () => {
    const { pack } = await loadEotEvidencePack("00000000-0000-0000-0000-000000000001", "job-1");
    expect(buildWeatherSnapshot).toHaveBeenCalledTimes(1);

    const ev = pack.categories.flatMap((c) => c.events)[0]!;
    expect(ev.weatherEvidence).not.toBeNull();
    expect(ev.weatherEvidence!.district).toBe("LS1");
    expect(ev.weatherEvidence!.readingCount).toBe(1);
    expect(ev.weatherEvidence!.maxWindGustMs).toBe(20);
    expect(ev.weatherEvidence!.minAirTempC).toBe(5);

    expect(pack.gaps.some((g) => g.kind === "weather_evidence_dark")).toBe(false);

    // CC-BY: the provider's attribution rides on the pack alongside the evidence,
    // so the client-facing PDF can print the licence line with the data.
    expect(pack.weatherAttribution).toBe(ATTRIBUTION);
  });
});
