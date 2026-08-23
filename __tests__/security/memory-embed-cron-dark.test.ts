import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * memory-embed on the DARK path — the runtime twin of hq-apply-drain-cron-dark
 * (Wave A.4 cron-telemetry waste).
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but dark (no embedding provider configured — the prod default,
 *     the `embedding` tier is unbound) ⇒ 204 no-op with ZERO work: no telemetry
 *     row, no embedding worker run.
 *
 * Before the gate this route woke every 2 minutes (720 ticks/day) and wrote a
 * cron_runs row each tick to record the worker had no provider and did nothing.
 * The gate reads `isEmbeddingConfigured()` — the SAME provider-presence contract
 * the worker itself short-circuits on — so the early return can only skip work
 * that would itself have been a guaranteed no-op. It does NOT add a
 * getEmbeddingProvider outside-caller (it wraps the in-module one), so the
 * ai-governance-closure caller ratchet stays green.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const runEmbeddingWorker = vi.fn(async () => {
  throw new Error("the dark cron path ran the embedding worker");
});
const isEmbeddingConfigured = vi.fn(() => false);

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/server/services/memory-embedder", () => ({ runEmbeddingWorker }));
vi.mock("@/lib/ai/embeddings", () => ({ isEmbeddingConfigured }));

const { GET } = await import("@/app/api/cron/memory-embed/route");
const request = new Request("http://localhost/api/cron/memory-embed");

beforeEach(() => {
  vi.clearAllMocks();
  isEmbeddingConfigured.mockReturnValue(false);
});

describe("GET /api/cron/memory-embed (dark build)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(isEmbeddingConfigured).not.toHaveBeenCalled();
    expect(withCronTelemetry).not.toHaveBeenCalled();
  });

  it("authorised + no provider ⇒ 204 no-op, empty body, ZERO work", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(runEmbeddingWorker).not.toHaveBeenCalled();
  });

  it("authorised + provider configured ⇒ the worker runs with full telemetry", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    isEmbeddingConfigured.mockReturnValue(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    runEmbeddingWorker.mockImplementationOnce(async () => ({ ok: true }) as never);

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(withCronTelemetry).toHaveBeenCalledTimes(1);
    expect(runEmbeddingWorker).toHaveBeenCalledTimes(1);
  });
});
