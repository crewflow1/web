import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * whatsapp-events-sweep on the DARK path (activation-hardening P2-4) — the
 * memory-embed-cron-dark twin.
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but the WhatsApp channel is DARK (NEXT_PUBLIC_FEATURE_WHATSAPP
 *     off — today's prod state) ⇒ 204 no-op with ZERO work: no telemetry row,
 *     no sweep pass. While the flag is off the webhook 404s, so no ingress
 *     events can exist to sweep — the early return can only skip a guaranteed
 *     no-op, and the cron stays free until activation flips the flag.
 *   - flag on ⇒ the sweep runs under full telemetry, with the query `limit`
 *     bound respected.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const sweepWhatsAppWebhookEvents = vi.fn(async () => {
  throw new Error("the dark cron path ran the sweep");
});

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/server/services/whatsapp-events-sweep", () => ({ sweepWhatsAppWebhookEvents }));

const { GET } = await import("@/app/api/cron/whatsapp-events-sweep/route");
const request = new Request("http://localhost/api/cron/whatsapp-events-sweep");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/whatsapp-events-sweep (channel dark)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(sweepWhatsAppWebhookEvents).not.toHaveBeenCalled();
  });

  it("authorised + flag OFF (prod today) ⇒ 204 no-op, empty body, ZERO work", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(sweepWhatsAppWebhookEvents).not.toHaveBeenCalled();
  });

  it("authorised + flag ON ⇒ the sweep runs with full telemetry", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    isCronAuthorised.mockReturnValueOnce(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    sweepWhatsAppWebhookEvents.mockImplementationOnce(async () => ({ ok: true }) as never);

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(withCronTelemetry).toHaveBeenCalledTimes(1);
    expect(sweepWhatsAppWebhookEvents).toHaveBeenCalledTimes(1);
  });

  it("a manual `limit` kick is clamped to 50 and threaded through", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    isCronAuthorised.mockReturnValueOnce(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    sweepWhatsAppWebhookEvents.mockImplementationOnce(async () => ({ ok: true }) as never);

    await GET(new Request("http://localhost/api/cron/whatsapp-events-sweep?limit=500"));
    expect(sweepWhatsAppWebhookEvents).toHaveBeenCalledWith({ batch: 50 });
  });
});
