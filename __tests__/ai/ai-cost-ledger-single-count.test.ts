import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RecordInvocationInput } from "@/lib/ai/governor";

/**
 * Cost-ledger single-count integrity (PR #902).
 *
 * Proves one AI invocation produces EXACTLY ONE accounting row:
 *   - the settle RPC (ai_settle_reservation) is the single ledger writer;
 *   - recordInvocation is a FALLBACK, used only when the reservation vanished —
 *     never in addition to a successful RPC settle (no double-count);
 *   - a re-settle of the same reservation is idempotent ('already_settled') — no
 *     second row (retry-safe);
 *   - the fallback flag is attributable, so a local→hosted fallback is two
 *     rows (two real provider invocations) with the hosted one flagged.
 */

const { rpcMock, insertMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), insertMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: rpcMock,
    from: () => ({ insert: insertMock }),
  }),
}));

const fallbackInput = (over: Partial<RecordInvocationInput> = {}): RecordInvocationInput => ({
  orgId: "org-1",
  userId: null,
  feature: "quote.writer_draft",
  taskClass: "drafting",
  usage: { provider: "anthropic", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20 },
  latencyMs: 1200,
  success: true,
  estimatedCostPence: 3,
  ...over,
});

const settleArgs = (over: Record<string, unknown> = {}) => ({
  reservationId: "res-1",
  success: true,
  costPence: 3,
  usage: { provider: "anthropic", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20 },
  latencyMs: 1200,
  fallback: fallbackInput(),
  ...over,
});

beforeEach(() => {
  rpcMock.mockReset();
  insertMock.mockReset();
  insertMock.mockResolvedValue({ error: null });
});

describe("settleReservation — exactly one accounting row per invocation", () => {
  it("normal settle: RPC writes the row, recordInvocation NOT called (one row)", async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: "settled" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0]![0]).toBe("ai_settle_reservation");
    expect(insertMock).not.toHaveBeenCalled(); // no second write
  });

  it("re-settle is idempotent ('already_settled') — no new row", async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: "already_settled" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("reservation vanished ('not_found'): recordInvocation writes exactly one fallback row", async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: "not_found" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1); // the fallback — the ONLY write here
  });

  it("RPC failure BEFORE commit → idempotent retry eventually settles exactly once", async () => {
    // attempt 1 errors (pre-commit), attempt 2 settles.
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: "transient" } })
      .mockResolvedValueOnce({ data: [{ outcome: "settled" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(2); // retried the IDEMPOTENT rpc
    expect(insertMock).not.toHaveBeenCalled(); // never a blind fallback on RPC error
  });

  it("RPC response LOST after DB commit → retry sees 'already_settled' → still ONE row (no double-count)", async () => {
    // attempt 1 "errors" (response lost though Postgres committed); attempt 2 the
    // idempotent rpc reports the commit already happened → NO second row.
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: "network reset" } })
      .mockResolvedValueOnce({ data: [{ outcome: "already_settled" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(insertMock).not.toHaveBeenCalled(); // the committed-but-lost case does NOT double-write
  });

  it("PERMANENT DB failure → degraded (ok=false), NO blind insert (never double-count)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "db down" } });
    const { settleReservation } = await import("@/lib/ai/governor");
    const ok = await settleReservation(settleArgs());
    expect(ok).toBe(false); // explicit degraded — surfaced via /admin/ai-costs, not silent
    expect(rpcMock).toHaveBeenCalledTimes(3); // bounded retries exhausted
    expect(insertMock).not.toHaveBeenCalled(); // the RPC may have committed — never blind-insert
  });

  it("a failed invocation is settled (success=false), still one row", async () => {
    rpcMock.mockResolvedValue({ data: [{ outcome: "settled" }], error: null });
    const { settleReservation } = await import("@/lib/ai/governor");
    await settleReservation(settleArgs({ success: false, errorCode: "provider_500", fallback: fallbackInput({ success: false, errorCode: "provider_500" }) }));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0]![1]).toMatchObject({ p_success: false, p_error_code: "provider_500" });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("recordInvocation — fallback flag + engine attributable (local→hosted = two rows)", () => {
  it("records engine + is_fallback honest defaults (hosted / false)", async () => {
    const { recordInvocation } = await import("@/lib/ai/governor");
    await recordInvocation(fallbackInput());
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0]![0]).toMatchObject({ engine: "hosted", is_fallback: false });
  });

  it("a local→hosted fallback is TWO rows: local (is_fallback=false) then hosted (is_fallback=true)", async () => {
    const { recordInvocation } = await import("@/lib/ai/governor");
    await recordInvocation(fallbackInput({ engine: "local", isFallback: false, usage: { provider: "ollama", model: "qwen3:4b", inputTokens: 100, outputTokens: 20 } }));
    await recordInvocation(fallbackInput({ engine: "hosted", isFallback: true }));
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock.mock.calls[0]![0]).toMatchObject({ engine: "local", is_fallback: false });
    expect(insertMock.mock.calls[1]![0]).toMatchObject({ engine: "hosted", is_fallback: true });
  });
});
