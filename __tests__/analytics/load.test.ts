import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser analytics loader is the ONE place PostHog initialises, so the
 * "no analytics before consent" contract lives here. Node test env: we stub
 * window/document and mock posthog-js + the consent helpers to drive each branch.
 */

const { posthogInit, posthogCapture, posthogOptIn, posthogOptOut, posthogClearOpt } = vi.hoisted(
  () => ({
    posthogInit: vi.fn(),
    posthogCapture: vi.fn(),
    posthogOptIn: vi.fn(),
    posthogOptOut: vi.fn(),
    posthogClearOpt: vi.fn(),
  }),
);
vi.mock("posthog-js", () => ({
  default: {
    init: posthogInit,
    capture: posthogCapture,
    opt_in_capturing: posthogOptIn,
    opt_out_capturing: posthogOptOut,
    clear_opt_in_out_capturing: posthogClearOpt,
  },
}));

const consentMock = vi.hoisted(() => ({
  analyticsConfigured: vi.fn(),
  analyticsAllowed: vi.fn(),
  readConsentFromCookieString: vi.fn(() => "granted"),
  isFirstPartySurface: vi.fn((_pathname: string) => true),
  // Real implementations of the pure clean-up helpers (the purge is under test).
  isAnalyticsStorageKey: (key: string) => key.startsWith("ph_") || key.startsWith("__ph_"),
  cookieDomainCandidates: (hostname: string) =>
    hostname === "crewflow.uk" ? ["", "crewflow.uk", ".crewflow.uk"] : [""],
}));
vi.mock("@/lib/analytics/consent", () => consentMock);

const eventsMock = vi.hoisted(() => ({ setAnalyticsSink: vi.fn() }));
vi.mock("@/lib/analytics/events", () => eventsMock);

type Globals = { window?: unknown; document?: { cookie: string } };
const g = globalThis as unknown as Globals;

async function freshLoad(): Promise<() => Promise<void>> {
  vi.resetModules();
  return (await import("@/lib/analytics/load")).loadAnalyticsIfAllowed;
}

async function freshModule(): Promise<typeof import("@/lib/analytics/load")> {
  vi.resetModules();
  return import("@/lib/analytics/load");
}

/** A minimal Storage double. */
function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    keys: () => Array.from(data.keys()),
  };
}

/** A `document` double that records every cookie write. */
function fakeDocument(cookie: string) {
  const writes: string[] = [];
  return {
    writes,
    doc: {
      get cookie() {
        return cookie;
      },
      set cookie(v: string) {
        writes.push(v);
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  g.window = {};
  g.document = { cookie: "" };
  consentMock.readConsentFromCookieString.mockReturnValue("granted");
  consentMock.isFirstPartySurface.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete g.window;
  delete g.document;
});

describe("loadAnalyticsIfAllowed", () => {
  it("does nothing without a configured key", async () => {
    consentMock.analyticsConfigured.mockReturnValue(false);
    await (await freshLoad())();
    expect(posthogInit).not.toHaveBeenCalled();
    expect(eventsMock.setAnalyticsSink).not.toHaveBeenCalled();
  });

  it("does nothing without consent", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(false);
    await (await freshLoad())();
    expect(posthogInit).not.toHaveBeenCalled();
  });

  it("does nothing outside the browser (no window)", async () => {
    delete g.window;
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    await (await freshLoad())();
    expect(posthogInit).not.toHaveBeenCalled();
  });

  it("inits once when configured + consented, with UUID-masking sanitize_properties", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    const load = await freshLoad();
    await load();
    await load(); // idempotent

    expect(posthogInit).toHaveBeenCalledTimes(1);
    const call = posthogInit.mock.calls[0]!;
    const key = call[0] as string;
    const opts = call[1] as {
      capture_pageview?: boolean;
      autocapture?: boolean;
      disable_session_recording?: boolean;
      sanitize_properties?: (p: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(key).toBe("phc_test");
    expect(opts.capture_pageview).toBe(true);
    expect(opts.autocapture).toBe(false);
    expect(opts.disable_session_recording).toBe(true);
    expect(typeof opts.sanitize_properties).toBe("function");

    const masked = opts.sanitize_properties!({
      $current_url: "https://crewflow.uk/jobs/3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(masked.$current_url).toBe("https://crewflow.uk/jobs/:id");

    expect(eventsMock.setAnalyticsSink).toHaveBeenCalledTimes(1);
  });

  it("initialises the vendor opted-OUT by default and only then opts in, with no synthetic event", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    await (await freshLoad())();

    const opts = posthogInit.mock.calls[0]![1] as {
      opt_out_capturing_by_default?: boolean;
      opt_out_persistence_by_default?: boolean;
    };
    expect(opts.opt_out_capturing_by_default).toBe(true);
    expect(opts.opt_out_persistence_by_default).toBe(true);
    expect(posthogOptIn).toHaveBeenCalledTimes(1);
    expect(posthogOptIn).toHaveBeenCalledWith({ captureEventName: false });
    expect(posthogInit.mock.invocationCallOrder[0]!).toBeLessThan(
      posthogOptIn.mock.invocationCallOrder[0]!,
    );
  });

  it("pins every optional PostHog product off and forbids remote script loading", async () => {
    // Consent is given for usage statistics only. PostHog's remote project
    // config can enable these server-side unless the init config says no, so
    // each one is asserted explicitly: removing a line here is a privacy change.
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    await (await freshLoad())();
    const opts = posthogInit.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts).toMatchObject({
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      capture_performance: false,
      capture_exceptions: false,
      rageclick: false,
      disable_external_dependency_loading: true,
    });
  });

  it("does nothing on an external surface (portal / quote / worker / enquiry)", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    consentMock.isFirstPartySurface.mockReturnValue(false);
    await (await freshLoad())();
    expect(posthogInit).not.toHaveBeenCalled();
    expect(eventsMock.setAnalyticsSink).not.toHaveBeenCalled();
  });

  it("drops events raised on an external surface via before_send", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    await (await freshLoad())();
    const opts = posthogInit.mock.calls[0]![1] as {
      before_send: (e: { event: string } | null) => { event: string } | null;
    };
    const event = { event: "$pageview" };
    expect(opts.before_send(event)).toBe(event);
    consentMock.isFirstPartySurface.mockReturnValue(false);
    expect(opts.before_send(event)).toBeNull();
  });

  it("does not opt in if consent was withdrawn while the SDK was loading", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    // allowed for the pre-import check, withdrawn by the post-init re-check
    consentMock.analyticsAllowed.mockReturnValueOnce(true).mockReturnValue(false);
    await (await freshLoad())();
    expect(posthogInit).toHaveBeenCalledTimes(1);
    expect(posthogOptIn).not.toHaveBeenCalled();
    expect(eventsMock.setAnalyticsSink).not.toHaveBeenCalled();
  });
});

describe("stopAnalytics — withdrawal", () => {
  it("detaches the sink, opts the vendor out, clears its opt flag, and purges its storage", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    const { doc, writes } = fakeDocument(
      "cf_cookie_consent=v2.t1.analytics1.performance0; ph_phc_test_posthog=%7B%7D; sb-x-auth-token=abc",
    );
    const local = fakeStorage({
      ph_phc_test_posthog: "{}",
      __ph_opt_in_out_phc_test: "1",
      "cf-nav-expanded": "[]",
      "crewflow-offline-identity": "{}",
    });
    const session = fakeStorage({ ph_phc_test_window_id: "w", keep: "1" });
    g.document = doc;
    g.window = {
      location: { pathname: "/", hostname: "crewflow.uk" },
      localStorage: local,
      sessionStorage: session,
    };

    const mod = await freshModule();
    await mod.loadAnalyticsIfAllowed();
    eventsMock.setAnalyticsSink.mockClear();

    mod.stopAnalytics();

    expect(eventsMock.setAnalyticsSink).toHaveBeenCalledWith(null);
    expect(posthogOptOut).toHaveBeenCalledTimes(1);
    expect(posthogClearOpt).toHaveBeenCalledTimes(1);
    // vendor keys gone, first-party keys untouched
    expect(local.keys().sort()).toEqual(["cf-nav-expanded", "crewflow-offline-identity"]);
    expect(session.keys()).toEqual(["keep"]);
    // the vendor cookie is expired on every candidate domain; ours are not written
    const expired = writes.filter((w) => w.startsWith("ph_phc_test_posthog=;"));
    expect(expired).toHaveLength(3);
    expect(expired.every((w) => w.includes("max-age=0"))).toBe(true);
    expect(expired.some((w) => w.includes("domain=.crewflow.uk"))).toBe(true);
    expect(writes.some((w) => w.startsWith("cf_cookie_consent"))).toBe(false);
    expect(writes.some((w) => w.startsWith("sb-"))).toBe(false);
  });

  it("purges leftovers even when analytics never started in this page", async () => {
    const { doc, writes } = fakeDocument("ph_phc_old_posthog=%7B%7D");
    const local = fakeStorage({ ph_phc_old_posthog: "{}" });
    g.document = doc;
    g.window = {
      location: { pathname: "/", hostname: "localhost" },
      localStorage: local,
      sessionStorage: fakeStorage({}),
    };
    const mod = await freshModule();
    mod.stopAnalytics();
    expect(posthogOptOut).not.toHaveBeenCalled();
    expect(local.keys()).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it("re-granting in the same page resumes capture without a second init", async () => {
    consentMock.analyticsConfigured.mockReturnValue(true);
    consentMock.analyticsAllowed.mockReturnValue(true);
    const mod = await freshModule();
    await mod.loadAnalyticsIfAllowed();
    mod.stopAnalytics();
    await mod.loadAnalyticsIfAllowed();
    expect(posthogInit).toHaveBeenCalledTimes(1);
    expect(posthogOptIn).toHaveBeenCalledTimes(2);
  });

  it("never throws when storage and cookies are unavailable", async () => {
    g.window = {};
    g.document = { cookie: "" };
    const mod = await freshModule();
    expect(() => mod.stopAnalytics()).not.toThrow();
  });
});
