import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/admin/monitoring/selftest — authorisation, rate-limit, disabled-mode and
 * capture safety. The endpoint emits ONE static synthetic Sentry event for an
 * operator; it must 404 for non-super-admins, never spam, never carry PII, and
 * never throw when Sentry is dark or fails.
 */

const { requireHqApiMock, captureMessageMock, flushMock, recordAdminActivityMock, readinessMock } =
  vi.hoisted(() => ({
    requireHqApiMock: vi.fn(),
    captureMessageMock: vi.fn((_message: string, _opts?: unknown): string | undefined => "evt_synthetic_1"),
    flushMock: vi.fn(async () => true),
    recordAdminActivityMock: vi.fn(async () => {}),
    readinessMock: vi.fn(() => ({
      sdkIntegrated: true,
      dsnConfigured: true,
      enabled: true,
      environment: "production",
    })),
  }));

vi.mock("@/server/auth/hq", () => ({ requireHqApi: requireHqApiMock }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: captureMessageMock, flush: flushMock }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: recordAdminActivityMock }));
vi.mock("@/lib/monitoring/readiness", () => ({ getMonitoringReadiness: readinessMock }));

import { POST } from "@/app/api/admin/monitoring/selftest/route";

// Must match the (non-exported) marker in the route module.
const MONITORING_SELFTEST_MARKER = "crewflow-monitoring-selftest";

const URL_ = "https://crewflow.uk/api/admin/monitoring/selftest";
const post = (opts: { origin?: string } = {}) =>
  POST(new Request(URL_, { method: "POST", headers: opts.origin ? { origin: opts.origin } : {} }));

function asSuperAdmin(id = `op-${Math.random().toString(36).slice(2)}`) {
  requireHqApiMock.mockResolvedValue({ ok: true, user: { id, email: "op@crewflow.uk" } });
  return id;
}

beforeEach(() => {
  captureMessageMock.mockClear().mockReturnValue("evt_synthetic_1");
  flushMock.mockClear().mockResolvedValue(true);
  recordAdminActivityMock.mockClear();
  readinessMock.mockReturnValue({ sdkIntegrated: true, dsnConfigured: true, enabled: true, environment: "production" });
});
afterEach(() => vi.unstubAllEnvs());

describe("monitoring self-test — authorisation", () => {
  it("returns the gate's 404 for a non-super-admin and emits nothing", async () => {
    requireHqApiMock.mockResolvedValue({ ok: false, response: new Response("Not found", { status: 404 }) });
    const res = await post({ origin: "https://crewflow.uk" });
    expect(res.status).toBe(404);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST (403) even for a super-admin", async () => {
    asSuperAdmin();
    const res = await post({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});

describe("monitoring self-test — capture", () => {
  it("emits exactly one static synthetic event with NO PII, and returns the event id", async () => {
    asSuperAdmin();
    const res = await post({ origin: "https://crewflow.uk" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, marker: MONITORING_SELFTEST_MARKER, captured: true, environment: "production", eventId: "evt_synthetic_1" });
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, opts] = captureMessageMock.mock.calls[0]!;
    expect(message).toBe(MONITORING_SELFTEST_MARKER);
    // Only a level + two static tags — no body, cookies, tokens, headers, user.
    // NB: this asserts the ARGUMENTS the route passes carry no PII. The SDK is
    // fully mocked here, so the pipeline-level scrub (beforeSend: scrubEvent +
    // sendDefaultPii:false) is proven by the dedicated scrub suite, not this test.
    expect(opts).toEqual({ level: "info", tags: { kind: MONITORING_SELFTEST_MARKER, surface: "admin-selftest" } });
    // The response carries no DSN/secret.
    expect(JSON.stringify(body)).not.toMatch(/sentry\.io|ingest|https?:\/\/[^/]*@/i);
  });

  it("is safe when monitoring is DARK (no DSN) — still 200, captured:false, no throw", async () => {
    asSuperAdmin();
    readinessMock.mockReturnValue({ sdkIntegrated: true, dsnConfigured: false, enabled: false, environment: "production" });
    // Model the real dark no-op: with no DSN the SDK's captureMessage returns undefined.
    captureMessageMock.mockReturnValue(undefined as unknown as string);
    const res = await post({ origin: "https://crewflow.uk" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.monitoringEnabled).toBe(false);
    expect(body.captured).toBe(false);
    expect(body.eventId).toBeNull();
  });

  it("returns captured:false (never throws) when the SDK capture fails", async () => {
    asSuperAdmin();
    captureMessageMock.mockImplementation(() => {
      throw new Error("sentry transport down");
    });
    const res = await post({ origin: "https://crewflow.uk" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, captured: false });
  });
});

describe("monitoring self-test — rate limit", () => {
  it("blocks event spam (429 after the per-operator window is spent)", async () => {
    const id = asSuperAdmin("op-ratelimit-fixed");
    requireHqApiMock.mockResolvedValue({ ok: true, user: { id, email: "op@crewflow.uk" } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post({ origin: "https://crewflow.uk" })).status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(5);
    expect(statuses[5]).toBe(429);
  });
});
