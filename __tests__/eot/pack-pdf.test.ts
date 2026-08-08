import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import {
  EotPackPdf,
  weatherAttributionLine,
  weatherDarkLine,
  weatherEvidenceLine,
  type EotPackPdfInput,
} from "@/lib/pdf/eot-pack-pdf";
import { assembleEotPack, type DelayEventRow, type EotWeatherEvidence } from "@/lib/eot/pack";

/**
 * EOT evidence-pack PDF — render path.
 *
 * The launch-blocking defect this guards: the template computed per-event
 * weather evidence but DISCARDED it, printing a hardcoded "(none is today)"
 * even once weather goes live — a false statement on a contractual document.
 *
 * react-pdf's buffer is non-deterministic, so (per the H&S pdf-test convention)
 * the rendered TEXT is asserted on the pure line helpers the template renders,
 * and the component itself is separately proven to render a well-formed PDF.
 */

const GENERATED = "2026-08-01T09:00:00.000Z";
const JOB = "00000000-0000-0000-0000-00000000job1";

function weatherEvent(overrides: Partial<DelayEventRow> = {}): DelayEventRow {
  return {
    id: "ev-weather",
    job_id: JOB,
    category: "weather",
    status: "recorded",
    started_on: "2026-07-01",
    ended_on: "2026-07-02",
    working_days_lost: 2,
    description: "Storm stopped roofing",
    diary_entry_id: null,
    variation_quote_id: null,
    weather_district: "LS1",
    recorded_at: "2026-07-02T18:00:00.000Z",
    recorded_by: "user-1",
    withdrawn_at: null,
    created_at: "2026-07-01T08:00:00.000Z",
    ...overrides,
  };
}

const EVIDENCE: EotWeatherEvidence = {
  district: "LS1",
  readingCount: 12,
  minAirTempC: 4,
  maxWindSpeedMs: 14,
  maxWindGustMs: 22,
  maxPrecipRateMmH: 6,
  totalPrecipMm: 30,
};

const ATTRIBUTION =
  "Weather data by Open-Meteo.com (https://open-meteo.com/), licensed under CC BY 4.0";

function pdfInput(
  evidenceAvailable: boolean,
  byEvent?: Map<string, EotWeatherEvidence>,
  attribution?: string | null,
): EotPackPdfInput {
  return {
    org_name: "Acme Build",
    job_label: "Plot 4 — Maple Rise",
    pack: assembleEotPack({
      jobId: JOB,
      events: [weatherEvent()],
      diaryEntries: [],
      variations: [],
      progress: null,
      weatherEvidenceAvailable: evidenceAvailable,
      weatherEvidenceByEvent: byEvent,
      weatherAttribution: attribution,
      generatedAt: GENERATED,
    }),
  };
}

describe("EOT pack PDF · weather line helpers", () => {
  it("(a) populated evidence renders its observed numeric values", () => {
    const line = weatherEvidenceLine(EVIDENCE);
    expect(line).toMatch(/12 observed readings/);
    expect(line).toMatch(/min air temp 4°C/);
    expect(line).toMatch(/max mean wind 14 m\/s/);
    expect(line).toMatch(/max gust 22 m\/s/);
    expect(line).toMatch(/peak rainfall 6 mm\/h/);
    expect(line).toMatch(/total rainfall 30 mm/);
    expect(line).toMatch(/district LS1/);
  });

  it("(b) the false 'none is today' placeholder is SUPPRESSED when readings exist", () => {
    expect(weatherEvidenceLine(EVIDENCE)).not.toMatch(/none is today/i);
    // The placeholder is confined to the dark case only.
    expect(weatherDarkLine("LS1")).toMatch(/none is today/i);
  });

  it("a null metric is OMITTED, never printed as zero (missing gust must not read as calm)", () => {
    const line = weatherEvidenceLine({ ...EVIDENCE, maxWindGustMs: null, totalPrecipMm: null });
    expect(line).not.toMatch(/max gust/);
    expect(line).not.toMatch(/total rainfall/);
    expect(line).not.toMatch(/\b0\b/); // no fabricated zero
    expect(line).toMatch(/min air temp 4°C/); // present metrics still render
  });

  it("all-null metrics degrade to an explicit no-values statement, still no 'none is today'", () => {
    const line = weatherEvidenceLine({
      district: "LS1",
      readingCount: 3,
      minAirTempC: null,
      maxWindSpeedMs: null,
      maxWindGustMs: null,
      maxPrecipRateMmH: null,
      totalPrecipMm: null,
    });
    expect(line).toMatch(/3 observed readings/);
    expect(line).toMatch(/no metric values reported/);
    expect(line).not.toMatch(/none is today/i);
  });
});

describe("EotPackPdf · component render", () => {
  const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

  it("renders a well-formed PDF in the DARK case (no evidence, honest placeholder)", async () => {
    const b = await renderToBuffer(EotPackPdf({ input: pdfInput(false) }));
    expect(isPdf(b)).toBe(true);
    expect(b.length).toBeGreaterThan(1000);
  });

  it("renders a well-formed PDF when populated evidence exists", async () => {
    const b = await renderToBuffer(
      EotPackPdf({ input: pdfInput(true, new Map([["ev-weather", EVIDENCE]])) }),
    );
    expect(isPdf(b)).toBe(true);
    expect(b.length).toBeGreaterThan(1000);
  });

  it("the pack the template renders carries the evidence when readings exist (not discarded)", () => {
    const pack = pdfInput(true, new Map([["ev-weather", EVIDENCE]])).pack;
    const ev = pack.categories.flatMap((c) => c.events).find((e) => e.id === "ev-weather")!;
    // The template branches on this field; before the fix it was ignored entirely.
    expect(ev.weatherEvidence).toEqual(EVIDENCE);
    expect(pack.gaps.some((g) => g.kind === "weather_evidence_dark")).toBe(false);
  });

  it("renders the CC-BY attribution when evidence AND an attribution are supplied", async () => {
    const input = pdfInput(true, new Map([["ev-weather", EVIDENCE]]), ATTRIBUTION);
    // Assembly binds the attribution onto the pack exactly when evidence is present.
    expect(input.pack.weatherAttribution).toBe(ATTRIBUTION);
    const b = await renderToBuffer(EotPackPdf({ input }));
    expect(isPdf(b)).toBe(true);
    // The rendered licence line carries the vendor string verbatim.
    expect(weatherAttributionLine(ATTRIBUTION)).toContain("CC BY 4.0");
  });

  it("binds NO attribution when evidence is absent — the dark PDF prints nothing new", () => {
    // Attribution supplied but no evidence rendered ⇒ the pack drops it, so the
    // licence line never prints on a pack that shows no weather data.
    const dark = pdfInput(false, undefined, ATTRIBUTION).pack;
    expect(dark.weatherAttribution).toBeNull();
  });
});
