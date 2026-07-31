import { describe, it, expect } from "vitest";
import {
  assessWorkability,
  assessAll,
  summariseWindow,
  dewPointC,
  msToMph,
  sourcedThresholdRatio,
} from "@/lib/weather/decision";
import {
  ALL_THRESHOLDS,
  FULLY_UNSOURCED_WORK_TYPES,
  UNSOURCED_THRESHOLD_COUNT,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  WORK_TYPE_THRESHOLDS,
  isSourced,
} from "@/lib/weather/thresholds";
import type { PostcodeDistrict, WeatherReading, WeatherWindow } from "@/lib/weather/types";

/**
 * Weather decision layer — the value of this wave, proven against fixtures.
 *
 * The decision layer is the only part of weather intelligence that can be
 * completely finished while no provider exists, so it is where the testing effort
 * goes. Every case below is a hand-built window: pure inputs, pure outputs, no
 * clock, no database, no network.
 *
 * The invariant these tests exist to defend, above all others:
 *
 *     `viable` requires EVERY threshold to have been evaluated against real
 *     data. MISSING DATA CAN NEVER READ AS SAFE.
 *
 * A layer that answered "viable" to an empty window would tell a site manager to
 * pour concrete on the strength of no information whatsoever — and an empty
 * window is EVERY window in this build, because no provider is bound.
 */

const LS1 = "LS1" as PostcodeDistrict;

/** One reading, with only the fields a case cares about. */
function reading(over: Partial<WeatherReading> = {}): WeatherReading {
  return {
    district: LS1,
    kind: "forecast",
    validAt: new Date("2026-11-12T09:00:00Z"),
    ...over,
  };
}

function windowOf(
  readings: ReadonlyArray<WeatherReading>,
  over: Partial<WeatherWindow> = {},
): WeatherWindow {
  return { district: LS1, readings, ...over };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** A mild, dry, still November morning. Complete data for concrete. */
const MILD_DRY = windowOf([
  reading({ airTempC: 11, precipRateMmH: 0, windGustMs: 4, windSpeedMs: 2, visibilityM: 12000 }),
  reading({
    validAt: new Date("2026-11-12T12:00:00Z"),
    airTempC: 13,
    precipRateMmH: 0,
    windGustMs: 5,
    windSpeedMs: 3,
    visibilityM: 15000,
  }),
]);

/** A hard frost overnight. */
const FROSTY = windowOf([
  reading({ airTempC: 1, precipRateMmH: 0 }),
  reading({ validAt: new Date("2026-11-12T03:00:00Z"), airTempC: -3, precipRateMmH: 0 }),
]);

/** A gale. */
const GALE = windowOf([
  reading({ airTempC: 9, windSpeedMs: 16, windGustMs: 24, precipRateMmH: 1, visibilityM: 8000 }),
]);

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE INVARIANT: missing data never reads as safe.
// ═════════════════════════════════════════════════════════════════════════════

describe("the load-bearing invariant — missing data is never 'viable'", () => {
  it("an EMPTY window is `unknown` for every work type, never `viable`", () => {
    // This is the dark build's answer to everything, so it is the single most
    // important assertion in the file.
    for (const workType of WORK_TYPES) {
      const a = assessWorkability(windowOf([]), workType);
      expect(a.verdict, workType).toBe("unknown");
      expect(a.verdict, workType).not.toBe("viable");
      expect(a.breaches, workType).toHaveLength(0);
      expect(a.gaps.length, workType).toBeGreaterThan(0);
    }
  });

  it("an empty window says so in the headline and the caveats", () => {
    const a = assessWorkability(windowOf([]), "concrete_pour");
    expect(a.headline).toMatch(/no weather data/i);
    expect(a.caveats.join(" ")).toMatch(/no weather data for this period/i);
  });

  it("a window missing ONE metric cannot be `viable`, even when all the rest pass", () => {
    // Temperature and rain are fine; nothing reports visibility, which
    // crane_lift needs. The answer must be `unknown`, not `viable`.
    const a = assessWorkability(
      windowOf([reading({ airTempC: 14, windGustMs: 3, precipRateMmH: 0 })]),
      "crane_lift",
    );
    expect(a.verdict).toBe("unknown");
    expect(a.gaps.map((g) => g.thresholdId)).toContain("lifting.visibility");
  });

  it("a CAUTION breach cannot lift a gap-bearing window to `caution` — that reads as permission", () => {
    // Gust of 10 m/s breaches the sail-area caution (>9) but visibility is
    // absent. `caution` would imply "we checked and it's marginal"; the truth is
    // "we did not check everything".
    const a = assessWorkability(
      windowOf([reading({ windGustMs: 10, windSpeedMs: 7 })]),
      "crane_lift",
    );
    expect(a.verdict).toBe("unknown");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("lifting.wind_gust_sail_area");
  });

  it("a BLOCKING breach still wins over a gap — you already know the answer", () => {
    // Gust 24 m/s blocks; visibility is missing. Definitive beats incomplete.
    const a = assessWorkability(windowOf([reading({ windGustMs: 24 })]), "crane_lift");
    expect(a.verdict).toBe("not_viable");
  });

  it("`viable` is reachable — the invariant is a real gate, not a stuck `unknown`", () => {
    // A negative control for the tests above: if nothing could ever be viable,
    // they would all pass vacuously.
    const a = assessWorkability(MILD_DRY, "concrete_pour");
    expect(a.verdict).toBe("viable");
    expect(a.gaps).toHaveLength(0);
    expect(a.breaches).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Determinism.
// ═════════════════════════════════════════════════════════════════════════════

describe("determinism", () => {
  it("the same window and work type produce a deeply equal assessment every time", () => {
    const a = assessWorkability(GALE, "roofing");
    const b = assessWorkability(GALE, "roofing");
    expect(a).toStrictEqual(b);
  });

  it("no verdict depends on the wall clock — a window dated in the past assesses identically", () => {
    // The readings' own timestamps are the only time this layer sees. Shifting
    // them a decade back must not change a single verdict.
    const shifted = windowOf(
      GALE.readings.map((r) => ({
        ...r,
        validAt: new Date(r.validAt.getTime() - 10 * 365 * 24 * 3600 * 1000),
      })),
    );
    expect(assessWorkability(shifted, "roofing").verdict).toBe(
      assessWorkability(GALE, "roofing").verdict,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Reduction: extremes, not averages, and null is not zero.
// ═════════════════════════════════════════════════════════════════════════════

describe("summariseWindow", () => {
  it("takes extremes rather than means — the coldest hour is what ruins a pour", () => {
    const { summary } = summariseWindow(FROSTY);
    expect(summary.minAirTempC).toBe(-3);
    expect(summary.maxAirTempC).toBe(1);
  });

  it("an unreported metric is null, NOT zero", () => {
    // The bug this guards: `?? 0` on wind would report dead calm during a gale,
    // and `?? 0` on temperature would report a permanent hard frost.
    const { summary } = summariseWindow(windowOf([reading({ airTempC: 8 })]));
    expect(summary.maxWindGustMs).toBeNull();
    expect(summary.maxWindSpeedMs).toBeNull();
    expect(summary.minVisibilityM).toBeNull();
    expect(summary.maxHumidityPct).toBeNull();
    expect(summary.minAirTempC).toBe(8);
  });

  it("precipitation TOTALS sum while rates take a maximum", () => {
    const { summary } = summariseWindow(
      windowOf([
        reading({ precipTotalMm: 1.5, precipRateMmH: 1.5 }),
        reading({ precipTotalMm: 2.5, precipRateMmH: 4 }),
      ]),
    );
    expect(summary.totalPrecipMm).toBe(4);
    expect(summary.maxPrecipRateMmH).toBe(4);
  });

  it("NaN and Infinity from a misbehaving provider cannot poison an extreme", () => {
    const { summary } = summariseWindow(
      windowOf([
        reading({ airTempC: Number.NaN }),
        reading({ airTempC: Number.POSITIVE_INFINITY }),
        reading({ airTempC: 6 }),
      ]),
    );
    expect(summary.minAirTempC).toBe(6);
    expect(summary.maxAirTempC).toBe(6);
  });

  it("an empty window reduces every metric to null", () => {
    const { summary, coverage } = summariseWindow(windowOf([]));
    expect(Object.values(summary).every((v) => v === null)).toBe(true);
    expect(coverage.readingCount).toBe(0);
  });

  it("dew-point margin is computed PER READING, not from the window's extremes", () => {
    // 20 °C @ 40% is a wide margin; 6 °C @ 99% is almost none. Pairing the
    // window's min temperature with its max humidity would invent a moment that
    // never occurred, and would report a margin neither reading had.
    const { summary } = summariseWindow(
      windowOf([
        reading({ airTempC: 20, humidityPct: 40 }),
        reading({ airTempC: 6, humidityPct: 99 }),
      ]),
    );
    // The 6 °C/99% reading's own margin is tiny — under 1 °C.
    expect(summary.minDewPointMarginC).not.toBeNull();
    expect(summary.minDewPointMarginC!).toBeLessThan(1);
    expect(summary.minDewPointMarginC!).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Concrete — frost and cold.
// ═════════════════════════════════════════════════════════════════════════════

describe("concrete_pour", () => {
  it("a hard frost stops the pour, citing the placing limit AND the frost rule", () => {
    const a = assessWorkability(FROSTY, "concrete_pour");
    expect(a.verdict).toBe("not_viable");
    const ids = a.breaches.map((b) => b.thresholdId);
    expect(ids).toContain("concrete.air_temp_placing"); // < 3 °C
    expect(ids).toContain("concrete.frost_before_strength"); // < 0 °C
    expect(a.headline).toMatch(/should not go ahead/i);
  });

  it("4 °C is above the 3 °C placing limit but below the 5 °C fresh-concrete minimum ⇒ caution", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 4, precipRateMmH: 0 })]),
      "concrete_pour",
    );
    expect(a.verdict).toBe("caution");
    expect(a.breaches.map((b) => b.thresholdId)).toEqual(["concrete.fresh_temp_proxy"]);
    // And that one is a genuine standard, not our own number.
    expect(a.breaches[0]!.sourceKind).toBe("standard");
    expect(a.breaches[0]!.source).toMatch(/BS 8500-2/);
  });

  it("heavy rain blocks a pour", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 12, precipRateMmH: 5 })]),
      "concrete_pour",
    );
    expect(a.verdict).toBe("not_viable");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("concrete.rain_during_pour");
  });

  it("always warns that air temperature is only a PROXY for frozen ground", () => {
    // The limit that matters most and that no forecast can report.
    const a = assessWorkability(MILD_DRY, "concrete_pour");
    expect(a.caveats.join(" ")).toMatch(/frozen ground, formwork or reinforcement/i);
  });

  it("blocking breaches sort before cautions, so a UI leads with the stopper", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: -1, precipRateMmH: 0 })]),
      "concrete_pour",
    );
    expect(a.breaches.length).toBeGreaterThan(1);
    expect(a.breaches[0]!.severity).toBe("blocking");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Lifting — gusts, and the one permitted inference.
// ═════════════════════════════════════════════════════════════════════════════

describe("crane_lift", () => {
  it("a 24 m/s gust exceeds the 20 m/s ceiling ⇒ not viable", () => {
    const a = assessWorkability(GALE, "crane_lift");
    expect(a.verdict).toBe("not_viable");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("lifting.wind_gust_ceiling");
  });

  it("MEAN wind above a gust limit is a SOUND definitive breach, and is marked as inferred", () => {
    // Physically gust >= mean, so mean-exceeds-limit proves gust-exceeds-limit.
    // The inference is recorded rather than silently substituted.
    const a = assessWorkability(
      windowOf([reading({ windSpeedMs: 22, visibilityM: 10000 })]),
      "crane_lift",
    );
    expect(a.verdict).toBe("not_viable");
    const breach = a.breaches.find((b) => b.thresholdId === "lifting.wind_gust_ceiling");
    expect(breach).toBeDefined();
    expect(breach!.inferredFromMeanWind).toBe(true);
    expect(breach!.observed).toBe(22);
  });

  it("mean wind BELOW a gust limit proves nothing — the threshold stays unknown, never `met`", () => {
    // The asymmetry is the point: a 5 m/s mean is entirely compatible with a
    // 25 m/s gust, so this must not be reported as within limits.
    const a = assessWorkability(
      windowOf([reading({ windSpeedMs: 5, visibilityM: 10000 })]),
      "crane_lift",
    );
    expect(a.verdict).toBe("unknown");
    const r = a.reasons.find((x) => x.thresholdId === "lifting.wind_gust_ceiling");
    expect(r!.status).toBe("unknown");
    expect(r!.status).not.toBe("met");
  });

  it("no gust data anywhere in the window produces an explicit caveat", () => {
    const a = assessWorkability(
      windowOf([reading({ windSpeedMs: 5, visibilityM: 10000 })]),
      "crane_lift",
    );
    expect(a.caveats.join(" ")).toMatch(/no gust data/i);
  });

  it("the ceiling names the manufacturer's limit as governing — no number is presented as law", () => {
    const ceiling = WORK_TYPE_THRESHOLDS.crane_lift.find(
      (t) => t.id === "lifting.wind_gust_ceiling",
    )!;
    expect(ceiling.source).toMatch(/manufacturer's maximum/i);
    expect(ceiling.rule).toMatch(/may be far lower/i);
    // It is practice guidance, NOT a regulation or a standard — because there is
    // no legal wind limit for lifting, and claiming one would be wrong.
    expect(ceiling.sourceKind).toBe("practice_guidance");
  });

  it("fog is a caution in its own right, independent of wind", () => {
    const a = assessWorkability(
      windowOf([reading({ windGustMs: 3, visibilityM: 80 })]),
      "crane_lift",
    );
    expect(a.verdict).toBe("caution");
    expect(a.breaches.map((b) => b.thresholdId)).toEqual(["lifting.visibility"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Roofing and work at height — wind and wet.
// ═════════════════════════════════════════════════════════════════════════════

describe("roofing and working_at_height", () => {
  it("roofing stops at force 6 (11 m/s) — lower than general work at height (14 m/s)", () => {
    const w = windowOf([reading({ windGustMs: 12, precipRateMmH: 0, airTempC: 9 })]);
    expect(assessWorkability(w, "roofing").verdict).toBe("not_viable");
    // The same wind is only a caution for general work at height, because sheet
    // material is what makes roofing the stricter case.
    expect(assessWorkability(w, "working_at_height").verdict).toBe("caution");
  });

  it("light rain alone stops roof work — a wet pitched roof is a slip hazard", () => {
    const a = assessWorkability(
      windowOf([reading({ windGustMs: 3, precipRateMmH: 0.5, airTempC: 9 })]),
      "roofing",
    );
    expect(a.verdict).toBe("not_viable");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("roofing.wet_surface");
  });

  it("the wet-surface rule cites the Work at Height Regulations as its DUTY while owning the number", () => {
    const t = WORK_TYPE_THRESHOLDS.roofing.find((x) => x.id === "roofing.wet_surface")!;
    expect(t.source).toMatch(/Work at Height Regulations 2005/);
    // Honest split: the duty is law, the millimetre figure is ours.
    expect(t.sourceKind).toBe("configurable_default");
  });

  it("sub-zero is an ice caution for work at height", () => {
    const a = assessWorkability(
      windowOf([reading({ windGustMs: 3, precipRateMmH: 0, airTempC: -2 })]),
      "working_at_height",
    );
    expect(a.verdict).toBe("caution");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("height.ice_risk");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Groundworks — the honestly weak one.
// ═════════════════════════════════════════════════════════════════════════════

describe("groundworks", () => {
  it("60 mm of antecedent rain blocks excavation", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })], {
        antecedentPrecipMm: 60,
        antecedentWindowHours: 72,
      }),
      "groundworks",
    );
    expect(a.verdict).toBe("not_viable");
    expect(a.breaches.map((b) => b.thresholdId)).toContain("groundworks.saturation_blocking");
  });

  it("30 mm is a caution", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })], {
        antecedentPrecipMm: 30,
        antecedentWindowHours: 72,
      }),
      "groundworks",
    );
    expect(a.verdict).toBe("caution");
    expect(a.breaches.map((b) => b.thresholdId)).toEqual(["groundworks.saturation_caution"]);
  });

  it("NO antecedent rainfall ⇒ unknown, never a clean bill of health", () => {
    // Saturation cannot be derived from a forecast, so its absence must not be
    // read as dry ground.
    const a = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })]),
      "groundworks",
    );
    expect(a.verdict).toBe("unknown");
    expect(a.caveats.join(" ")).toMatch(/no antecedent rainfall supplied/i);
  });

  it("states the antecedent window, and says so when the window is unknown", () => {
    // 40 mm over a day and 40 mm over a month mean opposite things, so a bare
    // figure must never be quoted as if it were self-explanatory.
    const withWindow = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })], {
        antecedentPrecipMm: 12.5,
        antecedentWindowHours: 72,
      }),
      "groundworks",
    );
    expect(withWindow.caveats.join(" ")).toMatch(/12\.5 mm of rain over the previous 72 hours/);

    const withoutWindow = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })], { antecedentPrecipMm: 12.5 }),
      "groundworks",
    );
    expect(withoutWindow.caveats.join(" ")).toMatch(/the period it covers was not recorded/i);
  });

  it("says LOUDLY that every one of its thresholds is CrewFlow's own", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 8, precipRateMmH: 0 })], {
        antecedentPrecipMm: 5,
        antecedentWindowHours: 72,
      }),
      "groundworks",
    );
    expect(a.caveats.join(" ")).toMatch(/CrewFlow's own default|CrewFlow’s own default/i);
    expect(a.caveats.join(" ")).toMatch(/no published standard states one/i);
  });

  it("is the ONLY fully-unsourced work type, and that is asserted rather than assumed", () => {
    expect(FULLY_UNSOURCED_WORK_TYPES).toEqual(["groundworks"]);
  });

  it("still cites the real statutory duty behind the invented numbers", () => {
    for (const t of WORK_TYPE_THRESHOLDS.groundworks) {
      if (t.id === "groundworks.frozen_ground") continue; // productivity, not safety
      expect(t.source, t.id).toMatch(/CDM 2015 reg\. 22/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Masonry and coatings — the best-sourced rules.
// ═════════════════════════════════════════════════════════════════════════════

describe("external_masonry", () => {
  it("2 °C stops bricklaying, on a British Standard rather than a house rule", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 2, precipRateMmH: 0 })]),
      "external_masonry",
    );
    expect(a.verdict).toBe("not_viable");
    const breach = a.breaches.find((b) => b.thresholdId === "masonry.air_temp")!;
    expect(breach.sourceKind).toBe("standard");
    expect(breach.source).toMatch(/BS 8000-3/);
  });

  it("4 °C is above the standard's limit and passes", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 4, precipRateMmH: 0 })]),
      "external_masonry",
    );
    expect(a.verdict).toBe("viable");
  });
});

describe("external_coatings", () => {
  it("90% humidity blocks application, per ISO 12944", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 12, humidityPct: 90, precipRateMmH: 0 })]),
      "external_coatings",
    );
    expect(a.verdict).toBe("not_viable");
    const breach = a.breaches.find((b) => b.thresholdId === "coatings.humidity")!;
    expect(breach.source).toMatch(/ISO 12944-7/);
    expect(breach.sourceKind).toBe("standard");
  });

  it("a narrow dew-point margin blocks application even at moderate humidity", () => {
    // 6 °C at 84% RH: humidity squeaks under the 85% limit, but the surface is
    // within 3 °C of the dew point, so condensation will form.
    const a = assessWorkability(
      windowOf([reading({ airTempC: 6, humidityPct: 84, precipRateMmH: 0 })]),
      "external_coatings",
    );
    expect(a.verdict).toBe("not_viable");
    const ids = a.breaches.map((b) => b.thresholdId);
    expect(ids).toContain("coatings.dew_point_margin");
    expect(ids).not.toContain("coatings.humidity");
  });

  it("a warm dry day is viable", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 18, humidityPct: 50, precipRateMmH: 0 })]),
      "external_coatings",
    );
    expect(a.verdict).toBe("viable");
  });

  it("warns that AIR temperature is a proxy for the SUBSTRATE the standard governs", () => {
    const a = assessWorkability(
      windowOf([reading({ airTempC: 18, humidityPct: 50, precipRateMmH: 0 })]),
      "external_coatings",
    );
    expect(a.caveats.join(" ")).toMatch(/substrate/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Provenance — every number is attributable, and the guesses are counted.
// ═════════════════════════════════════════════════════════════════════════════

describe("threshold provenance", () => {
  it("EVERY threshold declares a non-empty source", () => {
    for (const t of ALL_THRESHOLDS) {
      expect(t.source.trim().length, t.id).toBeGreaterThan(0);
    }
  });

  it("every threshold id is unique", () => {
    const ids = ALL_THRESHOLDS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every UNSOURCED threshold says so in its own source text", () => {
    // So a reader of the raw data, not just of this file, can tell.
    for (const t of ALL_THRESHOLDS.filter((x) => !isSourced(x))) {
      expect(t.source, t.id).toMatch(/configurable default/i);
    }
  });

  it("no SOURCED threshold pretends to be a default", () => {
    for (const t of ALL_THRESHOLDS.filter(isSourced)) {
      expect(t.source, t.id).not.toMatch(/^Configurable default/i);
    }
  });

  it("pins the count of CrewFlow's own numbers — adding one silently is not allowed", () => {
    // 25 thresholds, 10 attributable to a regulation/standard/trade guidance,
    // 15 our own. Adding an unsourced number is permitted; doing it without
    // updating this number is not.
    expect(ALL_THRESHOLDS).toHaveLength(25);
    expect(UNSOURCED_THRESHOLD_COUNT).toBe(15);
    expect(ALL_THRESHOLDS.length - UNSOURCED_THRESHOLD_COUNT).toBe(10);
  });

  it("reports the sourced ratio per work type, so a surface can state its own confidence", () => {
    expect(sourcedThresholdRatio("groundworks")).toEqual({ sourced: 0, total: 4 });
    expect(sourcedThresholdRatio("external_masonry")).toEqual({ sourced: 2, total: 3 });
  });

  it("every work type has at least one BLOCKING threshold — an advisory-only type would be useless", () => {
    for (const w of WORK_TYPES) {
      expect(
        WORK_TYPE_THRESHOLDS[w].some((t) => t.severity === "blocking"),
        w,
      ).toBe(true);
    }
  });

  it("every work type has a label, and every threshold a sane unit", () => {
    for (const w of WORK_TYPES) {
      expect(WORK_TYPE_LABELS[w]?.length ?? 0).toBeGreaterThan(0);
    }
    for (const t of ALL_THRESHOLDS) {
      expect(["°C", "m/s", "mm/h", "mm", "%", "m"], t.id).toContain(t.unit);
    }
  });

  it("carries the reason's source through to the assessment output, not just the table", () => {
    // The UI must be able to quote the source beside the verdict without
    // re-deriving it.
    const a = assessWorkability(FROSTY, "concrete_pour");
    for (const r of a.reasons) {
      expect(r.source.trim().length, r.thresholdId).toBeGreaterThan(0);
    }
  });

  it("always appends the advisory disclaimer, whatever the verdict", () => {
    for (const w of WORK_TYPES) {
      const a = assessWorkability(MILD_DRY, w);
      expect(a.caveats.join(" "), w).toMatch(/advisory only/i);
      expect(a.caveats.join(" "), w).toMatch(/competent person/i);
    }
  });

  it("always states the district-resolution caveat — the key's honest weakness", () => {
    const a = assessWorkability(MILD_DRY, "concrete_pour");
    expect(a.caveats.join(" ")).toMatch(/postcode district/i);
    expect(a.caveats.join(" ")).toMatch(/1,000 km/);
  });

  it("names the measured distance instead of the generic caveat when it is known", () => {
    const a = assessWorkability(
      windowOf(MILD_DRY.readings, { resolvedDistanceKm: 18 }),
      "concrete_pour",
    );
    expect(a.caveats.join(" ")).toMatch(/about 18 km from the work/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Helpers.
// ═════════════════════════════════════════════════════════════════════════════

describe("dewPointC", () => {
  it("returns the air temperature at 100% humidity — saturation, by definition", () => {
    expect(dewPointC(20, 100)).toBeCloseTo(20, 1);
  });

  it("matches the Magnus–Tetens reference value for 18 °C at 50% RH (~7.4 °C)", () => {
    expect(dewPointC(18, 50)).toBeCloseTo(7.4, 1);
  });

  it("is always at or below the air temperature", () => {
    for (const t of [-5, 0, 5, 12, 25, 33]) {
      for (const rh of [10, 40, 70, 95, 100]) {
        const td = dewPointC(t, rh)!;
        expect(td, `${t}°C @ ${rh}%`).toBeLessThanOrEqual(t + 1e-9);
      }
    }
  });

  it("refuses unphysical humidity rather than returning -Infinity", () => {
    expect(dewPointC(10, 0)).toBeNull();
    expect(dewPointC(10, -1)).toBeNull();
    expect(dewPointC(10, 101)).toBeNull();
    expect(dewPointC(Number.NaN, 50)).toBeNull();
  });
});

describe("msToMph", () => {
  it("converts using the exact factor", () => {
    expect(msToMph(20)).toBeCloseTo(44.7, 1);
    expect(msToMph(11)).toBeCloseTo(24.6, 1);
    expect(msToMph(0)).toBe(0);
  });
});

describe("assessAll", () => {
  it("returns one assessment per requested work type, in order", () => {
    const out = assessAll(MILD_DRY, ["concrete_pour", "roofing"]);
    expect(out.map((a) => a.workType)).toEqual(["concrete_pour", "roofing"]);
  });

  it("returns an empty array for no work types", () => {
    expect(assessAll(MILD_DRY, [])).toEqual([]);
  });
});
