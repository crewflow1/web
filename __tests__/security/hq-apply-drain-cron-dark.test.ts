import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * hq-apply-drain on the DARK path — the runtime twin of push-drain-cron-dark.
 *
 *   - unauthorised ⇒ 401 before anything;
 *   - authorised but dark (CREWFLOW_HQ_APPLY_ON_APPROVAL !== "on" — the default,
 *     and prod today) ⇒ 204 no-op with ZERO database access: no telemetry row,
 *     no admin client, no apply drain.
 *
 * This is the cost fix stated as behaviour: before the gate this route woke every
 * 5 minutes and wrote a cron_runs row each time to record that the apply-on-
 * approval sweep was still switched off. The kill-switch the route reads is the
 * SAME one runApplyOnApprovalDrain short-circuits on, so an early return can only
 * skip work that would itself have been a total no-op.
 */

const isCronAuthorised = vi.fn((_request: Request) => false);
const withCronTelemetry = vi.fn(async () => {
  throw new Error("the dark cron path invoked telemetry — that is a DB write");
});
const createAdminClient = vi.fn(() => {
  throw new Error("the dark cron path constructed an admin client");
});
const runApplyOnApprovalDrain = vi.fn(async () => {
  throw new Error("the dark cron path invoked the apply drain");
});
const hqApplyOnApprovalEnabled = vi.fn(() => false);

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/server/services/hq-apply-drain", () => ({
  runApplyOnApprovalDrain,
  hqApplyOnApprovalEnabled,
}));

const { GET } = await import("@/app/api/cron/hq-apply-drain/route");
const request = new Request("http://localhost/api/cron/hq-apply-drain");

beforeEach(() => {
  vi.clearAllMocks();
  hqApplyOnApprovalEnabled.mockReturnValue(false);
});

describe("GET /api/cron/hq-apply-drain (dark build)", () => {
  it("refuses an unauthorised caller with 401", async () => {
    isCronAuthorised.mockReturnValueOnce(false);
    const res = await GET(request);
    expect(res.status).toBe(401);
    expect(hqApplyOnApprovalEnabled).not.toHaveBeenCalled();
    expect(withCronTelemetry).not.toHaveBeenCalled();
  });

  it("authorised + dark ⇒ 204 no-op, empty body, ZERO database access", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    const res = await GET(request);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(withCronTelemetry).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(runApplyOnApprovalDrain).not.toHaveBeenCalled();
  });

  it("authorised + kill-switch ON ⇒ the drain still runs with full telemetry", async () => {
    isCronAuthorised.mockReturnValueOnce(true);
    hqApplyOnApprovalEnabled.mockReturnValue(true);
    withCronTelemetry.mockImplementationOnce((async (_route: string, fn: () => Promise<unknown>) => {
      await fn();
      return { status: 200, payload: { ok: true } };
    }) as unknown as typeof withCronTelemetry);
    runApplyOnApprovalDrain.mockImplementationOnce(async () => ({ ok: true }) as never);

    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(withCronTelemetry).toHaveBeenCalledTimes(1);
    expect(runApplyOnApprovalDrain).toHaveBeenCalledTimes(1);
  });
});
