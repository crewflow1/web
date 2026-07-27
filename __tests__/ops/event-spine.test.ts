import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the service-emitted producer path (Ch.04). Mocks the admin
 * client's RPC so we assert the envelope mapping, the defaults, the
 * correlation-id generation, and the result contract WITHOUT a database (the
 * real DB write is proven in the integration tier).
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { emitEvent } from "@/server/services/event-spine";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lastArgs(): Record<string, unknown> {
  const call = rpcMock.mock.calls.at(-1);
  expect(call?.[0]).toBe("hq_emit_event");
  return call?.[1] as Record<string, unknown>;
}

describe("emitEvent — service-emitted producer", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: 1, error: null });
  });

  it("applies envelope defaults and generates a fresh correlation id", async () => {
    const res = await emitEvent({
      actorType: "system",
      verb: "system.cron_ran",
      objectType: "system",
      objectId: "spine-partitions",
    });

    expect(res).toEqual({ ok: true, id: 1 });
    expect(rpcMock).toHaveBeenCalledTimes(1);

    const args = lastArgs();
    expect(args.p_actor_type).toBe("system");
    expect(args.p_verb).toBe("system.cron_ran");
    expect(args.p_object_type).toBe("system");
    expect(args.p_object_id).toBe("spine-partitions");
    expect(args.p_severity).toBe("info");
    expect(args.p_visibility).toBe("hq");
    expect(args.p_payload).toEqual({});
    expect(args.p_actor_id).toBeNull();
    expect(args.p_target_type).toBeNull();
    expect(args.p_target_id).toBeNull();
    expect(args.p_causation_id).toBeNull();
    expect(args.p_correlation_id).toMatch(UUID_RE);
  });

  it("passes a full envelope through unchanged (no correlation regeneration)", async () => {
    const correlationId = "11111111-2222-3333-4444-555555555555";
    const res = await emitEvent({
      actorType: "ai_employee",
      actorId: "research-ai",
      verb: "ai.run_completed",
      objectType: "ai_employee",
      objectId: "research-ai",
      targetType: "run",
      targetId: "run-99",
      correlationId,
      causationId: 42,
      severity: "warn",
      payload: { cost_usd: 0.12 },
      visibility: "hq",
    });

    expect(res).toEqual({ ok: true, id: 1 });
    const args = lastArgs();
    expect(args.p_actor_type).toBe("ai_employee");
    expect(args.p_actor_id).toBe("research-ai");
    expect(args.p_verb).toBe("ai.run_completed");
    expect(args.p_target_type).toBe("run");
    expect(args.p_target_id).toBe("run-99");
    expect(args.p_correlation_id).toBe(correlationId);
    expect(args.p_causation_id).toBe(42);
    expect(args.p_severity).toBe("warn");
    expect(args.p_payload).toEqual({ cost_usd: 0.12 });
  });

  it("returns ok:false when the RPC errors", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const res = await emitEvent({
      actorType: "system",
      verb: "system.alert_raised",
      objectType: "system",
      objectId: "x",
    });
    expect(res).toEqual({ ok: false, error: "permission denied" });
  });

  it("never throws — a thrown RPC becomes ok:false", async () => {
    rpcMock.mockRejectedValue(new Error("network down"));
    const res = await emitEvent({
      actorType: "system",
      verb: "system.alert_raised",
      objectType: "system",
      objectId: "x",
    });
    expect(res).toEqual({ ok: false, error: "network down" });
  });

  it("coerces a numeric-string id from PostgREST to a number", async () => {
    rpcMock.mockResolvedValue({ data: "456", error: null });
    const res = await emitEvent({
      actorType: "system",
      verb: "system.cron_ran",
      objectType: "system",
      objectId: "x",
    });
    expect(res).toEqual({ ok: true, id: 456 });
  });
});
