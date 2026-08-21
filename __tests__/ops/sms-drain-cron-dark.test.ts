import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * sms-drain on the DARK path — the runtime twin of the source-order pin.
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but dark (no Twilio credentials — every environment today) ⇒ 204 no-op
 *     with ZERO database access: no telemetry row, no admin client, no drain.
 *
 * This is the cost fix stated as behaviour: before the gate this route woke 1,440
 * times a day and wrote a cron_runs row each time to record that the SMS transport was
 * still switched off.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const createAdminClient = vi.fn(() => {
  throw new Error("the dark cron path constructed an admin client");
});
const drainSmsQueue = vi.fn(async () => {
  throw new Error("the dark cron path invoked the sms drain");
});
const cleanupOldSmsDeliveries = vi.fn(async () => {
  throw new Error("the dark cron path invoked the cleanup pass");
});
const isSmsConfigured = vi.fn(() => false);

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/notifications/sms", () => ({
  drainSmsQueue,
  cleanupOldSmsDeliveries,
  isSmsConfigured,
}));

const { GET } = await import("@/app/api/cron/sms-drain/route");
const request = new Request("http://localhost/api/cron/sms-drain");

beforeEach(() => {
  vi.clearAllMocks();
  isSmsConfigured.mockReturnValue(false);
});

describe("GET /api/cron/sms-drain (dark build)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(isSmsConfigured).not.toHaveBeenCalled();
    expect(withCronTelemetry).not.toHaveBeenCalled();
  });

  it("authorised + dark ⇒ 204 no-op, empty body, ZERO database access", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(drainSmsQueue).not.toHaveBeenCalled();
    expect(cleanupOldSmsDeliveries).not.toHaveBeenCalled();
  });

  it("authorised + CONFIGURED ⇒ the drain still runs, unchanged", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    isSmsConfigured.mockReturnValue(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    drainSmsQueue.mockImplementationOnce(async () => ({ sent: 0 }) as never);
    cleanupOldSmsDeliveries.mockImplementationOnce(async () => 0 as never);

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(withCronTelemetry).toHaveBeenCalledTimes(1);
    expect(drainSmsQueue).toHaveBeenCalledTimes(1);
  });
});
