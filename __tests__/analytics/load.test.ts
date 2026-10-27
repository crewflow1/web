import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser analytics loader is the ONE place PostHog initialises, so the
 * "no analytics before consent" contract lives here. Node test env: we stub
 * window/document and mock posthog-js + the consent helpers to drive each branch.
 */

const { posthogInit, posthogCapture } = vi.hoisted(() => ({
  posthogInit: vi.fn(),
  posthogCapture: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: { init: posthogInit, capture: posthogCapture } }));

const consentMock = vi.hoisted(() => ({
  analyticsConfigured: vi.fn(),
  analyticsAllowed: vi.fn(),
  readConsentFromCookieString: vi.fn(() => "granted"),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  g.window = {};
  g.document = { cookie: "" };
  consentMock.readConsentFromCookieString.mockReturnValue("granted");
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
});
