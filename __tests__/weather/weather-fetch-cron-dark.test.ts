import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The weather-fetch cron seam on the DARK path — proven at runtime, the twin
 * of the security suite's source-order pins:
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but dark (every real environment today) ⇒ 204 no-op with
 *     ZERO database access: no telemetry row, no admin client, no service run.
 *
 * The auth gate and telemetry are mocked; readiness is the REAL module, dark
 * because nothing in the test environment configures a provider.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const createAdminClient = vi.fn(() => {
  throw new Error("the dark cron path constructed an admin client");
});
const runWeatherFetch = vi.fn(async () => {
  throw new Error("the dark cron path invoked the fetch service");
});

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/server/services/weather-fetch", () => ({ runWeatherFetch }));

const { GET } = await import("@/app/api/cron/weather-fetch/route");

const request = new Request("http://localhost/api/cron/weather-fetch");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/cron/weather-fetch (dark build)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(withCronTelemetry).not.toHaveBeenCalled();
  });

  it("authorised + dark ⇒ 204 no-op, empty body, ZERO database access", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    // The whole point: a scheduled-but-dark tick touches nothing.
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(runWeatherFetch).not.toHaveBeenCalled();
  });
});
