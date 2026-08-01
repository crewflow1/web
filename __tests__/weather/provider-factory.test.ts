import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The factory's doors, proven at RUNTIME.
 *
 * The security suite pins the SOURCE of getWeatherProvider (one construction
 * site, key-guarded); this file proves the BEHAVIOUR by re-importing the seam
 * under different environments (vi.resetModules — lib/env parses process.env
 * at import, so a fresh import is the only honest way to vary it).
 *
 * The kill switch has no flag system of its own: it IS the WEATHER_PROVIDER
 * selection ("", "none", "off", "disabled" ⇒ null regardless of any key), and
 * removing the credential kills it just as dead — every gate is conjunctive.
 */

async function loadSeam() {
  vi.resetModules();
  return await import("@/lib/weather");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getWeatherProvider — the credential-gated doors", () => {
  it("returns null with nothing configured — the posture of every real environment", async () => {
    const seam = await loadSeam();
    expect(seam.getWeatherProvider()).toBeNull();
    expect(seam.isWeatherProviderConfigured()).toBe(false);
  });

  it("selection WITHOUT the credential stays null — a key-less open-meteo would be the licence breach", async () => {
    vi.stubEnv("WEATHER_PROVIDER", "open-meteo");
    const seam = await loadSeam();
    expect(seam.getWeatherProvider()).toBeNull();
  });

  it("credential WITHOUT selection stays null — a key alone activates nothing", async () => {
    vi.stubEnv("OPEN_METEO_API_KEY", "sk-test");
    const seam = await loadSeam();
    expect(seam.getWeatherProvider()).toBeNull();
  });

  it("selection + credential yields the adapter — the one live path, exercised only here", async () => {
    vi.stubEnv("WEATHER_PROVIDER", "open-meteo");
    vi.stubEnv("OPEN_METEO_API_KEY", "sk-test");
    const seam = await loadSeam();
    const provider = seam.getWeatherProvider();
    expect(provider).not.toBeNull();
    expect(provider!.info.provider).toBe("open-meteo");
    expect(provider!.info.attribution).toMatch(/CC BY 4\.0/);
    // Constructing is not connecting: no fetch happened to hand this back.
  });

  it("the KILL SWITCH: an off-selection beats a present credential", async () => {
    for (const off of ["none", "off", "disabled", ""]) {
      vi.stubEnv("WEATHER_PROVIDER", off);
      vi.stubEnv("OPEN_METEO_API_KEY", "sk-test");
      const seam = await loadSeam();
      expect(seam.getWeatherProvider(), `WEATHER_PROVIDER="${off}" must be off`).toBeNull();
      vi.unstubAllEnvs();
    }
  });

  it("metoffice stays null even fully configured — no adapter exists for it", async () => {
    vi.stubEnv("WEATHER_PROVIDER", "metoffice");
    vi.stubEnv("MET_OFFICE_API_KEY", "sk-test");
    const seam = await loadSeam();
    expect(seam.getWeatherProvider()).toBeNull();
  });

  it("an unknown vendor name degrades to null, never throws", async () => {
    vi.stubEnv("WEATHER_PROVIDER", "acme-weather");
    vi.stubEnv("OPEN_METEO_API_KEY", "sk-test");
    const seam = await loadSeam();
    expect(seam.getWeatherProvider()).toBeNull();
  });
});
