import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  getWeatherReadiness,
  isWeatherAvailable,
  weatherStatusLine,
  KNOWN_WEATHER_PROVIDERS,
  KNOWN_WEATHER_CREDENTIALS,
} from "@/lib/weather/readiness";

/**
 * Weather readiness — the false-green invariants, proven DIRECTLY.
 *
 * This file exists because of the incident lib/comms/readiness.ts documents:
 * WhatsApp once reported `configured: true` from two environment variables at a
 * time when the build contained no WhatsApp sender at all. The equivalent here
 * would be worse than a commercial embarrassment — a weather panel that believes
 * it is live but fetches nothing shows a site manager no warnings, and "no
 * warnings" is indistinguishable from "conditions are fine".
 *
 * The invariants are proven by INJECTING the build-time facts rather than by
 * observing that everything happens to be dark today. Inferring them from the
 * current state would make these tests pass vacuously the moment somebody wired
 * an adapter.
 */

const ENV_KEYS = ["WEATHER_PROVIDER", "MET_OFFICE_API_KEY", "OPEN_METEO_API_KEY"] as const;
const original = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]] as const),
);

afterEach(() => {
  for (const [k, v] of original) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the DARK default posture", () => {
  it("is not available, with no configuration at all", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const r = getWeatherReadiness();
    expect(r.available).toBe(false);
    expect(isWeatherAvailable()).toBe(false);
    expect(r.providerImplemented).toBe(false);
    // TRUE since Train 3: the ONSPD centroid dataset ships in-build. It does
    // not light anything up on its own — `available` stays false above.
    expect(r.districtResolutionAvailable).toBe(true);
    expect(r.provider).toBeNull();
    expect(r.providerResolvable).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  it("reports the decision layer as BUILT — the split that makes the dark UI useful", () => {
    // "Built and switched off" is a far more actionable thing to tell an
    // operator than "not configured", and it is true.
    expect(getWeatherReadiness().decisionLayerImplemented).toBe(true);
  });

  it("names WEATHER_PROVIDER as a blocker when nothing is selected", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(getWeatherReadiness().blockers.join(" ")).toMatch(/WEATHER_PROVIDER must name/);
  });

  it("no longer lists the coordinate dataset — that blocker is CLOSED by the in-build centroids", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const r = getWeatherReadiness();
    expect(r.districtResolutionAvailable).toBe(true);
    expect(r.blockers.join(" ")).not.toMatch(/coordinate/i);
  });

  it("if the dataset ever regressed, the blocker would name the dataset AND the remedy", () => {
    // Injected — the honest wording is part of the contract, not decoration.
    for (const k of ENV_KEYS) delete process.env[k];
    const blockers = getWeatherReadiness({ districtResolutionAvailable: false }).blockers.join(" ");
    expect(blockers).toMatch(/dataset is missing or incomplete/i);
    expect(blockers).toMatch(/ONS Postcode Directory/);
    expect(blockers).toMatch(/derive-district-centroids/);
    expect(blockers).toMatch(/Open Government Licence/i);
  });
});

describe("THE INVARIANT — configuration alone can never manufacture the capability", () => {
  it("a fully configured environment is STILL unavailable, because no adapter exists", () => {
    // The exact false-green this module exists to stop: somebody sets a real key
    // on a deploy and expects weather to work.
    process.env.WEATHER_PROVIDER = "metoffice";
    process.env.MET_OFFICE_API_KEY = "a-real-looking-key";

    const r = getWeatherReadiness();
    expect(r.selectionUsable).toBe(true);
    expect(r.credentialsPresent).toBe(true);
    expect(r.providerImplemented).toBe(false);
    // The headline stays honest.
    expect(r.available).toBe(false);
    expect(r.providerResolvable).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/no 'metoffice' provider adapter exists in this build/);
  });

  it("`available` is false when the adapter is missing, EVEN with everything else satisfied", () => {
    // Injected, so this holds after an adapter lands for some other vendor.
    const r = getWeatherReadiness({
      providerImplemented: false,
      credentialPresent: true,
      districtResolutionAvailable: true,
      decisionLayerImplemented: true,
    });
    expect(r.available).toBe(false);
  });

  it("`available` is false without DISTRICT RESOLUTION, even with a working adapter and key", () => {
    // The second invariant, and the one specific to this feature: every vendor
    // is queried by lat/lon, and this build has no way to produce one. A paid-up
    // API key is not enough.
    process.env.WEATHER_PROVIDER = "metoffice";
    process.env.MET_OFFICE_API_KEY = "k";
    const r = getWeatherReadiness({
      providerImplemented: true,
      districtResolutionAvailable: false,
    });
    expect(r.providerResolvable).toBe(true); // the seam would hand back a provider…
    expect(r.available).toBe(false); // …and it still could not answer a question.
  });

  it("`available` is false without the decision layer, however well configured", () => {
    const r = getWeatherReadiness({
      providerImplemented: true,
      credentialPresent: true,
      districtResolutionAvailable: true,
      decisionLayerImplemented: false,
    });
    expect(r.available).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/decision layer is not present/);
  });

  it("all four conditions together DO produce `available` — the gate is real, not stuck false", () => {
    // The negative control. Without this, every assertion above could pass
    // because `available` is hard-coded false.
    process.env.WEATHER_PROVIDER = "metoffice";
    process.env.MET_OFFICE_API_KEY = "k";
    const r = getWeatherReadiness({
      providerImplemented: true,
      districtResolutionAvailable: true,
      decisionLayerImplemented: true,
      credentialPresent: true,
    });
    expect(r.available).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.provider).toBe("metoffice");
  });
});

describe("provider selection", () => {
  it("an unknown vendor name degrades rather than throwing", () => {
    process.env.WEATHER_PROVIDER = "some-vendor-we-never-heard-of";
    const r = getWeatherReadiness();
    expect(r.selectionUsable).toBe(false);
    expect(r.available).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/is not a provider this build knows/);
  });

  it("treats none/off/disabled/empty as a deliberate kill switch", () => {
    for (const off of ["", "none", "off", "disabled", "  OFF  "]) {
      process.env.WEATHER_PROVIDER = off;
      const r = getWeatherReadiness();
      expect(r.selection, off).toBeNull();
      expect(r.available, off).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive on the vendor name", () => {
    process.env.WEATHER_PROVIDER = "  MetOffice  ";
    expect(getWeatherReadiness().selectionUsable).toBe(true);
  });

  it("has NO 'auto' mode, deliberately", () => {
    // Auto-selection is right when candidates are equivalent and free to try. It
    // is wrong here: Open-Meteo's keyless tier is licensed for NON-COMMERCIAL use
    // only, so an `auto` that silently picked it would put a commercial product
    // in breach of a licence.
    process.env.WEATHER_PROVIDER = "auto";
    const r = getWeatherReadiness();
    expect(r.selectionUsable).toBe(false);
    expect(KNOWN_WEATHER_PROVIDERS).not.toContain("auto");
  });

  it("never throws, for any input", () => {
    for (const v of ["", "  ", "metoffice", "🌧", "null", "undefined", "0"]) {
      process.env.WEATHER_PROVIDER = v;
      expect(() => getWeatherReadiness(), v).not.toThrow();
    }
  });
});

describe("stranded credential risk", () => {
  it("warns when a key is present but no adapter exists anywhere in the build", () => {
    // A key that nothing reads is a standing invitation for some future call site
    // to read it directly and bypass this seam — the AI governor's
    // `ungovernedCredentialRisk`, in a different domain.
    process.env.MET_OFFICE_API_KEY = "stranded";
    const r = getWeatherReadiness();
    expect(r.credentialsFound).toContain("MET_OFFICE_API_KEY");
    expect(r.strandedCredentialRisk).toBe(true);
  });

  it("is quiet when no credential is set — the default everywhere", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const r = getWeatherReadiness();
    expect(r.credentialsFound).toEqual([]);
    expect(r.strandedCredentialRisk).toBe(false);
  });

  it("knows exactly two credential names and introduces no third", () => {
    expect([...KNOWN_WEATHER_CREDENTIALS].sort()).toEqual([
      "MET_OFFICE_API_KEY",
      "OPEN_METEO_API_KEY",
    ]);
  });

  it("reports the WHOLE checklist at once — the adapter AND the key", () => {
    // Not a short-circuiting chain. Writing an adapter and obtaining a
    // subscription are two different people's work on two different timescales,
    // so revealing the second only after the first is done would turn one
    // planning conversation into two.
    process.env.WEATHER_PROVIDER = "metoffice";
    delete process.env.MET_OFFICE_API_KEY;
    const blockers = getWeatherReadiness().blockers;
    expect(blockers.join(" ")).toMatch(/no 'metoffice' provider adapter/);
    expect(blockers).toContain("MET_OFFICE_API_KEY");
    // Two distinct, independently actionable items. (The coordinate dataset
    // used to be the third; Train 3 closed it, so it must NOT reappear here.)
    expect(blockers.length).toBeGreaterThanOrEqual(2);
    expect(blockers.join(" ")).not.toMatch(/coordinate/i);
  });

  it("requires a key for open-meteo even though its free tier needs none", () => {
    // Deliberate: the keyless tier is NON-COMMERCIAL. Mapping it to a required
    // key makes "no key" read as "not activated" rather than "quietly running on
    // the wrong licence".
    process.env.WEATHER_PROVIDER = "open-meteo";
    delete process.env.OPEN_METEO_API_KEY;
    const r = getWeatherReadiness();
    expect(r.credentialsPresent).toBe(false);
    expect(r.blockers).toContain("OPEN_METEO_API_KEY");
  });
});

describe("the runtime watch signal — no green over an empty pipeline", () => {
  const fullyBuilt = {
    providerImplemented: true,
    districtResolutionAvailable: true,
    decisionLayerImplemented: true,
    credentialPresent: true,
  } as const;

  // Select a known vendor + key so `selectionUsable` (env-derived, not
  // overridable) is satisfied and only the watch clause is under test.
  beforeEach(() => {
    process.env.WEATHER_PROVIDER = "metoffice";
    process.env.MET_OFFICE_API_KEY = "k";
  });

  it("defaults to null and does NOT drag `available` down — every DB-free caller is unchanged", () => {
    const r = getWeatherReadiness(fullyBuilt);
    expect(r.hasActiveWatches).toBeNull();
    expect(r.available).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("with a provider fully resolvable but NO active watch, `available` is forced false", () => {
    const r = getWeatherReadiness({ ...fullyBuilt, hasActiveWatches: false });
    expect(r.hasActiveWatches).toBe(false);
    expect(r.available).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/no active weather watches/i);
  });

  it("with at least one active watch, the clause is satisfied and `available` holds", () => {
    const r = getWeatherReadiness({ ...fullyBuilt, hasActiveWatches: true });
    expect(r.hasActiveWatches).toBe(true);
    expect(r.available).toBe(true);
    expect(r.blockers.join(" ")).not.toMatch(/no active weather watches/i);
  });

  it("an empty pipeline can NEVER on its own make weather available — the invariant still needs the build-time facts", () => {
    // hasActiveWatches:true must not paper over a missing provider.
    const r = getWeatherReadiness({
      providerImplemented: false,
      credentialPresent: true,
      districtResolutionAvailable: true,
      decisionLayerImplemented: true,
      hasActiveWatches: true,
    });
    expect(r.available).toBe(false);
  });
});

describe("weatherStatusLine — the sentence a dark surface shows", () => {
  it("says 'not configured' AND that nothing should be read as fair weather", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const line = weatherStatusLine(getWeatherReadiness());
    expect(line).toMatch(/not configured/i);
    // The load-bearing half: silence must not be mistaken for an all-clear.
    expect(line).toMatch(/should be read as conditions being suitable|not checking anything/i);
  });

  it("states that the thresholds ARE built — 'waiting on a decision', not 'broken'", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(weatherStatusLine(getWeatherReadiness())).toMatch(/built and tested/i);
  });

  it("never claims weather data is held", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const line = weatherStatusLine(getWeatherReadiness());
    expect(line).toMatch(/no weather data/i);
  });
});
