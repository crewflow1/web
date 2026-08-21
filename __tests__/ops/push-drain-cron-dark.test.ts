import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * push-drain on the DARK path — the runtime twin of the source-order pin.
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but dark (no VAPID keys — every environment today) ⇒ 204 no-op
 *     with ZERO database access: no telemetry row, no admin client, no drain.
 *
 * This is the cost fix stated as behaviour: before the gate this route woke 1,440
 * times a day and wrote a cron_runs row each time to record that Web Push was
 * still switched off.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const createAdminClient = vi.fn(() => {
  throw new Error("the dark cron path constructed an admin client");
});
const drainPushQueue = vi.fn(async () => {
  throw new Error("the dark cron path invoked the push drain");
});
const cleanupOldPushDeliveries = vi.fn(async () => {
  throw new Error("the dark cron path invoked the cleanup pass");
});
const isPushConfigured = vi.fn(() => false);

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/notifications/push", () => ({
  drainPushQueue,
  cleanupOldPushDeliveries,
  isPushConfigured,
}));

const { GET } = await import("@/app/api/cron/push-drain/route");
const request = new Request("http://localhost/api/cron/push-drain");

beforeEach(() => {
  vi.clearAllMocks();
  isPushConfigured.mockReturnValue(false);
});

describe("GET /api/cron/push-drain (dark build)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(isPushConfigured).not.toHaveBeenCalled();
    expect(withCronTelemetry).not.toHaveBeenCalled();
  });

  it("authorised + dark ⇒ 204 no-op, empty body, ZERO database access", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(drainPushQueue).not.toHaveBeenCalled();
    expect(cleanupOldPushDeliveries).not.toHaveBeenCalled();
  });

  it("authorised + CONFIGURED ⇒ the drain still runs, unchanged", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    isPushConfigured.mockReturnValue(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    drainPushQueue.mockImplementationOnce(async () => ({ sent: 0 }) as never);
    cleanupOldPushDeliveries.mockImplementationOnce(async () => 0 as never);

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(withCronTelemetry).toHaveBeenCalledTimes(1);
    expect(drainPushQueue).toHaveBeenCalledTimes(1);
  });
});
