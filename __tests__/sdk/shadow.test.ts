import { describe, it, expect } from "vitest";
import {
  shadowObservationRecord,
  createInMemoryShadowObservationStore,
  type ExecutorShadowObservation,
  type ShadowObservationContext,
  type ShadowObservationRecord,
} from "@/server/sdk/shadow";

/**
 * Unit proof for the durable executor-shadow CONTRACT — the pure record builder + the in-memory
 * store reference (server/sdk/shadow.ts)
 * (CEO Directive #016 / D-06, increment R2; ADR 0011; the Shadow Truthfulness Rule — Kernel
 * Contract Map §2, the thirtieth standard).
 *
 * R2 gives the executor shadow's observation a FIRST-CLASS durable home. This file pins the part
 * that makes that safe — that what it persists is, by construction, EXPLICITLY a shadow and never
 * indistinguishable from a real application record:
 *
 *   - every record carries the UNCONDITIONAL `kind: "executor_shadow"` label, for ALL outcomes;
 *   - the `outcome` is drawn from the shadow's OWN vocabulary (`planned`/`refused`/`error`) and is
 *     NEVER an application status (`applied`/`failed`) — there is no `status` field at all;
 *   - the builder is PURE, TOTAL and FROZEN — no clock, no I/O, immutable result;
 *   - the in-memory store is append-only, write-only, and never throws (best-effort).
 *
 * Pure by design — shadow.ts imports nothing at runtime, so this test reaches for nothing real.
 */

const ctx: ShadowObservationContext = {
  source: "autonomous",
  correlationId: "corr-shadow-1",
  taskId: "task-1",
  actionId: "lead:lead_1:memory.write",
};

const planned: ExecutorShadowObservation = {
  outcome: "planned",
  toolLabel: "memory.write",
  idempotencyKey: "autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-shadow-1",
};
const refused: ExecutorShadowObservation = {
  outcome: "refused",
  reason: "invalid_args",
  detail: "memory.write needs a verdict",
};
const errored: ExecutorShadowObservation = { outcome: "error", detail: "boom" };

// =====================================================================
// shadowObservationRecord — the pure, frozen, explicitly-shadow builder
// =====================================================================

describe("shadowObservationRecord — builds an explicitly shadow-labelled record per outcome", () => {
  it("planned → carries the tool label + idempotency key; reason null, detail empty", () => {
    expect(shadowObservationRecord(ctx, planned)).toEqual({
      kind: "executor_shadow",
      outcome: "planned",
      source: "autonomous",
      correlationId: "corr-shadow-1",
      taskId: "task-1",
      actionId: "lead:lead_1:memory.write",
      toolLabel: "memory.write",
      idempotencyKey: "autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·corr-shadow-1",
      reason: null,
      detail: "",
    });
  });

  it("refused → carries the reason + detail; tool label and idempotency key null", () => {
    expect(shadowObservationRecord(ctx, refused)).toEqual({
      kind: "executor_shadow",
      outcome: "refused",
      source: "autonomous",
      correlationId: "corr-shadow-1",
      taskId: "task-1",
      actionId: "lead:lead_1:memory.write",
      toolLabel: null,
      idempotencyKey: null,
      reason: "invalid_args",
      detail: "memory.write needs a verdict",
    });
  });

  it("error → carries the detail; tool label, idempotency key and reason all null", () => {
    expect(shadowObservationRecord(ctx, errored)).toEqual({
      kind: "executor_shadow",
      outcome: "error",
      source: "autonomous",
      correlationId: "corr-shadow-1",
      taskId: "task-1",
      actionId: "lead:lead_1:memory.write",
      toolLabel: null,
      idempotencyKey: null,
      reason: null,
      detail: "boom",
    });
  });

  it("the result is FROZEN — a recorded observation is immutable", () => {
    const rec = shadowObservationRecord(ctx, planned);
    expect(Object.isFrozen(rec)).toBe(true);
  });

  it("threads the run/action identity from the context unchanged, for every outcome", () => {
    for (const obs of [planned, refused, errored]) {
      const rec = shadowObservationRecord(ctx, obs);
      expect(rec.source).toBe("autonomous");
      expect(rec.correlationId).toBe("corr-shadow-1");
      expect(rec.taskId).toBe("task-1");
      expect(rec.actionId).toBe("lead:lead_1:memory.write");
    }
  });

  // ---- The Shadow Truthfulness Rule, made a matter of structure ------------------
  it("is ALWAYS labelled `executor_shadow` and NEVER carries an application status", () => {
    for (const obs of [planned, refused, errored]) {
      const rec = shadowObservationRecord(ctx, obs);
      // the unconditional shadow label — the discriminant a reader keys on
      expect(rec.kind).toBe("executor_shadow");
      // the shadow's OWN vocabulary — never an application status
      expect(["planned", "refused", "error"]).toContain(rec.outcome);
      expect(rec.outcome).not.toBe("applied");
      expect(rec.outcome).not.toBe("failed");
      // structurally NOT an ApplicationRecord: no `status` field exists to be `applied`/`failed`
      expect(rec).not.toHaveProperty("status");
      expect(rec).not.toHaveProperty("applied");
    }
  });
});

// =====================================================================
// createInMemoryShadowObservationStore — append-only, write-only reference
// =====================================================================

describe("createInMemoryShadowObservationStore — append-only, best-effort reference", () => {
  it("records each observation and returns ok with a monotonic id", async () => {
    const store = createInMemoryShadowObservationStore();
    const a = await store.record(shadowObservationRecord(ctx, planned));
    const b = await store.record(shadowObservationRecord(ctx, refused));
    expect(a).toEqual({ ok: true, id: 1 });
    expect(b).toEqual({ ok: true, id: 2 });
  });

  it("recorded() exposes exactly what was appended, in order, each still shadow-labelled", async () => {
    const store = createInMemoryShadowObservationStore();
    await store.record(shadowObservationRecord(ctx, planned));
    await store.record(shadowObservationRecord(ctx, errored));
    const recorded: readonly ShadowObservationRecord[] = store.recorded();
    expect(recorded.map((r) => r.outcome)).toEqual(["planned", "error"]);
    expect(recorded.every((r) => r.kind === "executor_shadow")).toBe(true);
  });

  it("the facade is frozen (the production interface stays write-only)", () => {
    const store = createInMemoryShadowObservationStore();
    expect(Object.isFrozen(store)).toBe(true);
  });
});
