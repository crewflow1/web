import { describe, it, expect } from "vitest";
import {
  deriveIdempotencyKey,
  resolveAppliedPayload,
  appliedRecord,
  failedRecord,
  shouldEscalate,
  createInMemoryApplicationStore,
  applyOnce,
  DEFAULT_APPLICATION_RETRY_CEILING,
  type ExecutionIdentity,
  type ApproverAttribution,
} from "@/server/sdk/application";
import { type ExecutionOutcome } from "@/server/sdk/executor";

/**
 * Unit proof for the apply-on-approval marker — server/sdk/application.ts
 * (CEO Directive #014 / D-04, Phase C, increment C3; ADR 0009 Decisions 4, 5, 6, 9, 10; Volume XIII §15).
 *
 * C3 records that a cleared action was applied, exactly once, and never twice — even under the Task
 * Engine's whole-task retry and a re-running out-of-band sweep. These pin: the idempotency key is
 * DETERMINISTIC and collision-free (the Executor Idempotency Rule); `resolveAppliedPayload` honours
 * `edited_payload ?? proposed_payload` (Decision 10); the application record is a frozen, discriminated
 * applied/failed marker (Decision 5/9); the in-memory store round-trips; and — the heart of C3 —
 * `applyOnce` applies through the injected boundary exactly once, no-ops a second time on an
 * already-applied key (the central no-double-apply guarantee), and escalates on exhaustion rather than
 * retrying forever or silently dropping.
 */

// ── Identity builders — full, typed shapes for each apply path. ──
function autoId(
  parts: Partial<{ correlationId: string; taskId: string; toolLabel: string; actionId: string }> = {},
): ExecutionIdentity {
  return {
    source: "autonomous",
    correlationId: parts.correlationId ?? "corr_1",
    taskId: parts.taskId ?? "task_1",
    toolLabel: parts.toolLabel ?? "memory.write",
    actionId: parts.actionId ?? "act_1",
  };
}
function apprId(
  parts: Partial<{ correlationId: string; approvalId: string; toolLabel: string; actionId: string }> = {},
): ExecutionIdentity {
  return {
    source: "approval",
    correlationId: parts.correlationId ?? "corr_1",
    approvalId: parts.approvalId ?? "appr_1",
    toolLabel: parts.toolLabel ?? "comm.send",
    actionId: parts.actionId ?? "act_1",
  };
}

// ── Injected boundaries that record how often they were crossed — never a real effect. ──
function appliedApply(result: unknown = { ok: true }, label = "memory.write") {
  let calls = 0;
  const apply = async (): Promise<ExecutionOutcome> => {
    calls += 1;
    return { status: "applied", label, result };
  };
  return { apply, count: () => calls };
}
function failedApply(error = "boundary refused the tampered call", label = "comm.send") {
  let calls = 0;
  const apply = async (): Promise<ExecutionOutcome> => {
    calls += 1;
    return { status: "failed", label, error };
  };
  return { apply, count: () => calls };
}

// =====================================================================
// 1. deriveIdempotencyKey — deterministic, namespaced, collision-free.
// =====================================================================

describe("deriveIdempotencyKey — a deterministic, stable key (the Executor Idempotency Rule)", () => {
  it("is deterministic — the same identity always yields the same key", () => {
    const id = autoId({ actionId: "a1" });
    expect(deriveIdempotencyKey(id)).toBe(deriveIdempotencyKey(id));
    expect(deriveIdempotencyKey(autoId({ actionId: "a1" }))).toBe(deriveIdempotencyKey(autoId({ actionId: "a1" })));
  });

  it("namespaces the two paths — an autonomous key and an approval key never collide", () => {
    const auto = deriveIdempotencyKey(autoId({ actionId: "a1" }));
    const appr = deriveIdempotencyKey(apprId({ actionId: "a1" }));
    expect(auto).not.toBe(appr);
    expect(auto.startsWith("autonomous")).toBe(true);
    expect(appr.startsWith("approval")).toBe(true);
  });

  it("varies with every identity field — a different anything yields a different key", () => {
    const base = deriveIdempotencyKey(autoId());
    expect(deriveIdempotencyKey(autoId({ taskId: "task_2" }))).not.toBe(base);
    expect(deriveIdempotencyKey(autoId({ toolLabel: "comm.send" }))).not.toBe(base);
    expect(deriveIdempotencyKey(autoId({ actionId: "act_2" }))).not.toBe(base);
    expect(deriveIdempotencyKey(autoId({ correlationId: "corr_2" }))).not.toBe(base);
  });

  it("escapes segments — a delimiter inside a field cannot bleed into the next (no collision)", () => {
    // Under a naive join both would be "autonomous·a·t·b·c·d"; escaping keeps them distinct.
    const a = deriveIdempotencyKey(autoId({ taskId: "a", toolLabel: "t", actionId: "b·c", correlationId: "d" }));
    const b = deriveIdempotencyKey(autoId({ taskId: "a", toolLabel: "t·b", actionId: "c", correlationId: "d" }));
    expect(a).not.toBe(b);
  });

  it("throws on an empty required segment — a key from an incomplete identity would break the guarantee", () => {
    expect(() => deriveIdempotencyKey(autoId({ taskId: "" }))).toThrow();
    expect(() => deriveIdempotencyKey(autoId({ actionId: "   " }))).toThrow();
    expect(() => deriveIdempotencyKey(apprId({ approvalId: "" }))).toThrow();
  });
});

// =====================================================================
// 2. resolveAppliedPayload — edited_payload ?? proposed_payload.
// =====================================================================

describe("resolveAppliedPayload — honour the reviewer's revision (Decision 10)", () => {
  const proposed = { body: "original" };

  it("uses the edited payload when one exists", () => {
    expect(resolveAppliedPayload(proposed, { body: "revised" })).toEqual({ body: "revised" });
  });

  it("falls back to the proposal when the edit is null or absent", () => {
    expect(resolveAppliedPayload(proposed, null)).toBe(proposed);
    expect(resolveAppliedPayload(proposed)).toBe(proposed);
  });

  it("treats an empty-but-present edit as the edit (not the proposal) — `{}` is not nullish", () => {
    expect(resolveAppliedPayload(proposed, {})).toEqual({});
  });
});

// =====================================================================
// 3. The records — frozen, discriminated applied/failed markers.
// =====================================================================

describe("appliedRecord / failedRecord — frozen, discriminated markers", () => {
  it("builds a frozen applied marker with sensible defaults", () => {
    const r = appliedRecord({ key: "k", identity: autoId(), label: "memory.write", result: { id: "m1" } });
    expect(r.status).toBe("applied");
    expect(r.result).toEqual({ id: "m1" });
    expect(r.attempts).toBe(1); // default
    expect(r.approver).toBeNull(); // default
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("builds a frozen failed marker carrying the error and escalation flag", () => {
    const r = failedRecord({ key: "k", identity: apprId(), label: "comm.send", error: "boom", escalated: true, attempts: 3 });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("boom");
    expect(r.escalated).toBe(true);
    expect(r.attempts).toBe(3);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

// =====================================================================
// 4. shouldEscalate — the retry-ceiling decision.
// =====================================================================

describe("shouldEscalate — escalate on exhaustion (Decision 9)", () => {
  it("does not escalate below the ceiling, escalates at or above it", () => {
    expect(shouldEscalate(1, 3)).toBe(false);
    expect(shouldEscalate(2, 3)).toBe(false);
    expect(shouldEscalate(3, 3)).toBe(true);
    expect(shouldEscalate(4, 3)).toBe(true);
  });

  it("defaults the ceiling to the Task Engine's retry default", () => {
    expect(DEFAULT_APPLICATION_RETRY_CEILING).toBe(3);
    expect(shouldEscalate(2)).toBe(false);
    expect(shouldEscalate(3)).toBe(true);
  });
});

// =====================================================================
// 5. createInMemoryApplicationStore — the reference persistence seam.
// =====================================================================

describe("createInMemoryApplicationStore — the reference store", () => {
  it("returns undefined for an unknown key", async () => {
    const store = createInMemoryApplicationStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  it("round-trips a record under its own key and is frozen", async () => {
    const store = createInMemoryApplicationStore();
    expect(Object.isFrozen(store)).toBe(true);
    const rec = appliedRecord({ key: "k1", identity: autoId(), label: "memory.write", result: 1 });
    await store.put(rec);
    expect(await store.get("k1")).toBe(rec);
  });
});

// =====================================================================
// 6. The heart of C3 — applyOnce applies exactly once, idempotently.
// =====================================================================

describe("applyOnce — apply exactly once through the injected boundary", () => {
  it("applies a first-time action and records the marker", async () => {
    const store = createInMemoryApplicationStore();
    const boundary = appliedApply({ wrote: "qualified" });
    const r = await applyOnce({ store, identity: autoId({ actionId: "A" }), apply: boundary.apply });
    expect(r.status).toBe("applied");
    expect(boundary.count()).toBe(1);
    if (r.status === "applied") {
      expect(r.record.status).toBe("applied");
      expect(r.record.label).toBe("memory.write");
      expect(r.record.attempts).toBe(1);
    }
    expect(await store.get(r.key)).toBeDefined();
  });

  it("THE CENTRAL GUARANTEE: an applied action is never re-applied — a second call is a no-op success", async () => {
    const store = createInMemoryApplicationStore();
    const first = appliedApply({ wrote: "A" });
    await applyOnce({ store, identity: autoId({ actionId: "A" }), apply: first.apply });
    expect(first.count()).toBe(1);

    // Retry the SAME identity — the boundary must NOT be crossed again.
    const retry = appliedApply({ wrote: "A-again" });
    const r = await applyOnce({ store, identity: autoId({ actionId: "A" }), apply: retry.apply });
    expect(r.status).toBe("already_applied");
    expect(retry.count()).toBe(0); // never re-applied
    if (r.status === "already_applied") expect(r.record.result).toEqual({ wrote: "A" }); // the ORIGINAL result
  });

  it("isolates distinct actions — applying A does not mark B (independent keys)", async () => {
    const store = createInMemoryApplicationStore();
    const a = appliedApply({ wrote: "A" });
    const b = appliedApply({ wrote: "B" });
    await applyOnce({ store, identity: autoId({ actionId: "A" }), apply: a.apply });
    const rb = await applyOnce({ store, identity: autoId({ actionId: "B" }), apply: b.apply });
    expect(rb.status).toBe("applied"); // B was NOT short-circuited by A's marker
    expect(b.count()).toBe(1);
  });

  it("records a failure below the ceiling as re-attemptable, incrementing attempts", async () => {
    const store = createInMemoryApplicationStore();
    const id = autoId({ actionId: "B" });
    const r1 = await applyOnce({ store, identity: id, apply: failedApply("boom").apply, ceiling: 3 });
    expect(r1.status).toBe("failed");
    if (r1.status === "failed") {
      expect(r1.record.escalated).toBe(false);
      expect(r1.record.attempts).toBe(1);
    }

    const second = failedApply("boom-2");
    const r2 = await applyOnce({ store, identity: id, apply: second.apply, ceiling: 3 });
    expect(second.count()).toBe(1); // re-attempted (not short-circuited)
    expect(r2.status).toBe("failed");
    if (r2.status === "failed") expect(r2.record.attempts).toBe(2);
  });

  it("escalates once attempts reach the ceiling, and then does not auto re-attempt", async () => {
    const store = createInMemoryApplicationStore();
    const id = autoId({ actionId: "C" });
    await applyOnce({ store, identity: id, apply: failedApply("x").apply, ceiling: 2 }); // attempt 1 → failed
    const r2 = await applyOnce({ store, identity: id, apply: failedApply("x").apply, ceiling: 2 }); // attempt 2 → escalated
    expect(r2.status).toBe("escalated");
    if (r2.status === "escalated") expect(r2.record.escalated).toBe(true);

    // A third sweep must NOT cross the boundary — a human already owns it (Decision 9).
    const third = failedApply("x");
    const r3 = await applyOnce({ store, identity: id, apply: third.apply, ceiling: 2 });
    expect(r3.status).toBe("escalated");
    expect(third.count()).toBe(0);
  });

  it("attributes the human approver on the approval path", async () => {
    const store = createInMemoryApplicationStore();
    const approver: ApproverAttribution = { approverId: "u_1", approverEmail: "ceo@crewflow.uk" };
    const r = await applyOnce({
      store,
      identity: apprId({ actionId: "D" }),
      apply: appliedApply({ sent: true }, "comm.send").apply,
      approver,
    });
    expect(r.status).toBe("applied");
    if (r.status === "applied") expect(r.record.approver).toEqual(approver);
  });
});
