import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * A TIMED-OUT CALL IS SETTLED AT ITS CLAIM, NOT AT THE 1p FLOOR.
 *
 * Every governed provider request is non-streaming and carries an AbortSignal.
 * When the signal fires we stop waiting — the vendor keeps working and bills the
 * whole call. Settling that at the 1p failure floor under-counted by up to the
 * full claim, precisely during the incident (a slow provider) in which many
 * calls time out together.
 *
 * SIMULATED-ONLY: the "provider" is a function that throws. No key, no network.
 * The admin client is a mock that records what the settle RPC was asked to
 * commit, which is the fact under test.
 */

const settled = vi.hoisted(() => ({ args: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "ai_reserve_invocation") {
        return {
          data: [
            {
              outcome: "reserved",
              reservation_id: "22222222-2222-2222-2222-222222222222",
              committed_pence: 0,
              reserved_pence: 0,
              ceiling_pence: 10000,
            },
          ],
          error: null,
        };
      }
      if (fn === "ai_settle_reservation") {
        settled.args.push(args);
        return { data: [{ outcome: "settled" }], error: null };
      }
      return { data: [], error: null };
    },
  }),
}));

import { invokeWithGovernor, isTimeoutLike, FAILURE_FLOOR_PENCE } from "@/lib/ai/governor";
import { reservationClaimPence } from "@/lib/ai/governor/policy";
import { TIER_MODEL } from "@/lib/ai/governor/registry";
import { _resetForTests } from "@/lib/security/rate-limit";

const MID = TIER_MODEL.mid!;
const CLAIM = reservationClaimPence(MID, {
  inputTokens: MID.reserveInputTokens,
  outputTokens: MID.reserveOutputTokens,
});

let prevKey: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key"; // inert: arms readiness only, reaches nothing
  settled.args = [];
  _resetForTests();
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

async function failWith(err: unknown) {
  await expect(
    invokeWithGovernor(
      "quote.writer_draft",
      "drafting",
      async () => {
        throw err;
      },
      { orgId: "org-timeout-1", userId: null },
    ),
  ).rejects.toBe(err); // the failure is still RETHROWN — the caller's catch owns the degraded path
  expect(settled.args).toHaveLength(1);
  return settled.args[0]!;
}

describe("isTimeoutLike", () => {
  it("recognises the runtime and vendor-SDK timeout/abort shapes", () => {
    expect(isTimeoutLike(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
    expect(isTimeoutLike(new DOMException("This operation was aborted", "AbortError"))).toBe(true);
    const sdkAbort = new Error("Request was aborted.");
    sdkAbort.name = "APIUserAbortError";
    expect(isTimeoutLike(sdkAbort)).toBe(true);
    const sdkTimeout = new Error("Request timed out.");
    sdkTimeout.name = "APIConnectionTimeoutError";
    expect(isTimeoutLike(sdkTimeout)).toBe(true);
    expect(isTimeoutLike(new Error("wrapped: request timed out after 60000ms"))).toBe(true);
  });

  it("does not treat a vendor REFUSAL or an ordinary bug as a timeout", () => {
    const badRequest = new Error("400 invalid_request_error: max_tokens too large");
    badRequest.name = "BadRequestError";
    expect(isTimeoutLike(badRequest)).toBe(false);
    const rateLimited = new Error("429 rate_limit_error");
    rateLimited.name = "RateLimitError";
    expect(isTimeoutLike(rateLimited)).toBe(false);
    expect(isTimeoutLike(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isTimeoutLike(null)).toBe(false);
    expect(isTimeoutLike("timeout")).toBe(false);
  });
});

describe("invokeWithGovernor — what a failed call is settled as", () => {
  it("a TIMEOUT is settled at the full claim (the vendor finished and billed the call)", async () => {
    expect(CLAIM).toBeGreaterThan(FAILURE_FLOOR_PENCE);
    const args = await failWith(new DOMException("The operation timed out.", "TimeoutError"));
    expect(args.p_success).toBe(false);
    expect(args.p_cost_pence).toBe(CLAIM);
    expect(args.p_error_code).toBe("TimeoutError");
    // We got no usage report, so the token counts stay honestly zero.
    expect(args.p_input_tokens).toBe(0);
    expect(args.p_output_tokens).toBe(0);
  });

  it("an SDK abort is settled at the full claim too", async () => {
    const err = new Error("Request was aborted.");
    err.name = "APIUserAbortError";
    const args = await failWith(err);
    expect(args.p_cost_pence).toBe(CLAIM);
  });

  it("a vendor REFUSAL (4xx) is still settled at the 1p floor — unchanged", async () => {
    const err = new Error("400 invalid_request_error");
    err.name = "BadRequestError";
    const args = await failWith(err);
    expect(args.p_cost_pence).toBe(FAILURE_FLOOR_PENCE);
    expect(args.p_error_code).toBe("BadRequestError");
  });

  it("an ordinary thrown bug is still settled at the 1p floor — unchanged", async () => {
    const args = await failWith(new TypeError("boom"));
    expect(args.p_cost_pence).toBe(FAILURE_FLOOR_PENCE);
  });

  it("a timeout can never be settled BELOW the failure floor or ABOVE its own claim", async () => {
    const args = await failWith(new DOMException("timed out", "TimeoutError"));
    expect(Number(args.p_cost_pence)).toBeGreaterThanOrEqual(FAILURE_FLOOR_PENCE);
    expect(Number(args.p_cost_pence)).toBeLessThanOrEqual(CLAIM);
  });
});
