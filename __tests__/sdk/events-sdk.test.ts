import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Unit proof for the `ctx.events` SDK facet (server/sdk/events.ts)
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §13).
 *
 * The facet BINDS the already-built spine primitive — `emitEvent`, the validated
 * `hq_emit_event` SECURITY DEFINER write — to ONE employee + ONE run's trace, and
 * stamps both onto every emission. We mock only the admin client's RPC surface, so
 * the REAL `emitEvent` runs end to end; only the database round-trip is faked. That
 * pins the contract:
 *
 *   - identity is stamped on EVERY emit as actor_type:"ai_employee" / actor_id:slug,
 *     so a handler can never record an event as another actor (XIII §8, no spoofing —
 *     the reason EmitInput has no actorType/actorId);
 *   - the run's correlation threads through, and a per-call override wins;
 *   - the optional spine fields (target / causation / severity / payload / visibility)
 *     pass through, with the spine's own defaults when omitted;
 *   - BEST-EFFORT, by spine design: a failed append — an rpc error OR an rpc throw — is
 *     LOGGED and returned as { ok:false }, NEVER thrown (a spine hiccup must not break
 *     the handler's primary work);
 *   - a successful append returns { ok:true, id };
 *   - the bound identity is frozen.
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import { createEvents } from "@/server/sdk/events";

const CORR = "corr-run-1";

/** Args of the first rpc() call to `fn` (or undefined). */
function argsFor(fn: string): Record<string, unknown> | undefined {
  const call = rpcMock.mock.calls.find((c) => c[0] === fn);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  rpcMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// identity + correlation stamping
// ---------------------------------------------------------------------

describe("ctx.events.emit — stamps the bound actor + the run's correlation", () => {
  it("stamps actor_type 'ai_employee' and actor_id = slug (no actor parameter to spoof)", async () => {
    rpcMock.mockResolvedValue({ data: 42, error: null });
    const events = createEvents({ slug: "research-ai" }, CORR);

    const out = await events.emit({
      verb: "ai.run_completed",
      objectType: "ai_task",
      objectId: "task-1",
    });

    expect(out).toEqual({ ok: true, id: 42 });
    const args = argsFor("hq_emit_event")!;
    expect(args.p_actor_type).toBe("ai_employee");
    expect(args.p_actor_id).toBe("research-ai");
    expect(args.p_verb).toBe("ai.run_completed");
    expect(args.p_object_type).toBe("ai_task");
    expect(args.p_object_id).toBe("task-1");
  });

  it("threads the run's correlationId by default", async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });
    const events = createEvents({ slug: "sales-ai" }, CORR);
    await events.emit({ verb: "memory.asserted", objectType: "memory", objectId: "m1" });
    expect(argsFor("hq_emit_event")!.p_correlation_id).toBe(CORR);
  });

  it("lets a per-call correlationId override the run's trace", async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });
    const events = createEvents({ slug: "sales-ai" }, CORR);
    await events.emit({
      verb: "memory.asserted",
      objectType: "memory",
      objectId: "m1",
      correlationId: "other-trace",
    });
    expect(argsFor("hq_emit_event")!.p_correlation_id).toBe("other-trace");
  });

  it("forwards the optional spine fields (target / causation / severity / payload / visibility)", async () => {
    rpcMock.mockResolvedValue({ data: 7, error: null });
    const events = createEvents({ slug: "research-ai" }, CORR);
    await events.emit({
      verb: "ai.run_completed",
      objectType: "ai_task",
      objectId: "task-1",
      targetType: "lead",
      targetId: "lead-9",
      causationId: 100,
      severity: "warn",
      payload: { score: 8 },
      visibility: "ops",
    });
    const args = argsFor("hq_emit_event")!;
    expect(args.p_target_type).toBe("lead");
    expect(args.p_target_id).toBe("lead-9");
    expect(args.p_causation_id).toBe(100);
    expect(args.p_severity).toBe("warn");
    expect(args.p_payload).toEqual({ score: 8 });
    expect(args.p_visibility).toBe("ops");
  });

  it("leaves target/causation null when omitted (the spine fills its own defaults)", async () => {
    rpcMock.mockResolvedValue({ data: 1, error: null });
    const events = createEvents({ slug: "research-ai" }, CORR);
    await events.emit({ verb: "ai.run_completed", objectType: "ai_task", objectId: "task-1" });
    const args = argsFor("hq_emit_event")!;
    expect(args.p_target_type).toBeNull();
    expect(args.p_target_id).toBeNull();
    expect(args.p_causation_id).toBeNull();
  });
});

// ---------------------------------------------------------------------
// best-effort ABI — never throws
// ---------------------------------------------------------------------

describe("ctx.events.emit — BEST-EFFORT: returns the outcome and NEVER throws", () => {
  it("returns { ok:false } and LOGS when the rpc reports an error (does not throw)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { message: "spine down" } });
    const events = createEvents({ slug: "research-ai" }, CORR);

    const out = await events.emit({
      verb: "ai.run_completed",
      objectType: "ai_task",
      objectId: "t1",
    });

    expect(out).toEqual({ ok: false, error: "spine down" });
    expect(errSpy).toHaveBeenCalled();
  });

  it("returns { ok:false } and LOGS when the rpc THROWS (a hiccup cannot break the handler)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockRejectedValue(new Error("connection reset"));
    const events = createEvents({ slug: "research-ai" }, CORR);

    const out = await events.emit({
      verb: "ai.run_completed",
      objectType: "ai_task",
      objectId: "t1",
    });

    expect(out).toEqual({ ok: false, error: "connection reset" });
    expect(errSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// identity immutability
// ---------------------------------------------------------------------

describe("ctx.events — identity is frozen", () => {
  it("exposes a frozen copy of the bound identity", () => {
    const events = createEvents({ slug: "research-ai" }, CORR);
    expect(events.identity.slug).toBe("research-ai");
    expect(Object.isFrozen(events.identity)).toBe(true);
    expect(() => {
      (events.identity as { slug: string }).slug = "evil-ai";
    }).toThrow();
  });
});
