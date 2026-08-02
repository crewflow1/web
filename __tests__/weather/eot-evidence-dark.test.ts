import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EOT service — the weather seam is DARK-SAFE at runtime, not just in source.
 *
 * With no provider bound (every environment today) `isWeatherAvailable()` is
 * false, so the service must resolve NO weather at all: the governed accessor is
 * never called, `weatherEvidenceAvailable` is false, and every weather event
 * keeps its honest "provider dark" gap. This is the runtime counterpart to the
 * source pins in __tests__/security/eot-delay-events.test.ts.
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

const createClient = vi.fn(async () => stubClient());
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/server/services/job-progress", () => ({
  loadJobProgress: async () => ({ failed: false, summary: { points: [] } }),
}));

const buildWeatherSnapshot = vi.fn(async () => {
  throw new Error("buildWeatherSnapshot called on the DARK path — the readiness gate must skip it");
});
vi.mock("@/server/services/weather", () => ({ buildWeatherSnapshot }));

const { loadEotEvidencePack } = await import("@/server/services/eot-pack");

beforeEach(() => {
  buildWeatherSnapshot.mockClear();
});

describe("loadEotEvidencePack on the dark path", () => {
  it("never calls the weather accessor", async () => {
    await loadEotEvidencePack("00000000-0000-0000-0000-000000000001", "job-1");
    expect(buildWeatherSnapshot).not.toHaveBeenCalled();
  });

  it("resolves weatherEvidenceAvailable to FALSE and keeps the provider-dark gap", async () => {
    const { pack } = await loadEotEvidencePack("00000000-0000-0000-0000-000000000001", "job-1");
    expect(pack.categories.flatMap((c) => c.events)).toHaveLength(1);
    const ev = pack.categories.flatMap((c) => c.events)[0]!;
    expect(ev.weatherEvidence).toBeNull();
    const dark = pack.gaps.filter((g) => g.kind === "weather_evidence_dark");
    expect(dark).toHaveLength(1);
  });
});
