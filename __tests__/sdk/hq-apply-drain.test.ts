import { describe, it, expect } from "vitest";
import {
  runApplyOnApprovalDrain,
  hqApplyOnApprovalEnabled,
  createUnboundApplyAuthority,
  type ApprovedItem,
  type ApplyAuthority,
  type ApprovedItemReader,
} from "@/server/services/hq-apply-drain";
import { createInMemoryApplicationStore } from "@/server/sdk/application";
import type { ExecutionOutcome } from "@/server/sdk/executor";

/**
 * CrewFlow HQ — the apply-on-approval drain (out-of-band sweep), unit behaviour
 * (CEO Directive #014 / D-04, Phase C, C3 rollout; ADR 0009 Decisions 5, 6, 9).
 *
 * The migration + durable store are proven against real Postgres in the integration tier; here we
 * prove the SWEEP'S behaviour over injected seams (an in-memory store, a fake authority, a fixed
 * reader) — the pure logic a mock CAN prove:
 *   • kill-switch OFF (the default) ⇒ a total no-op: nothing read, nothing applied;
 *   • kill-switch ON ⇒ an approved item applies EXACTLY ONCE, and a re-run is a no-op success;
 *   • the sweep applies ONLY through the injected sanctioned authority — a `null` authority (the
 *     production default) applies nothing and records nothing (dark), never a bare write;
 *   • the identity is source `approval` (the out-of-band path), keyed per item.
 */

const clock = () => new Date("2026-08-03T00:00:00.000Z");

function approvedApproval(id: string, over: Partial<ApprovedItem> = {}): ApprovedItem {
  return {
    kind: "approval",
    id,
    identity: {
      source: "approval",
      correlationId: `corr-${id}`,
      approvalId: id,
      toolLabel: "send",
      actionId: `outreach_email:${id}:send`,
    },
    approver: { approverId: "rev-1", approverEmail: "reviewer@crewflow.uk" },
    descriptor: { type: "send", subjectType: "outreach_email", subjectId: id, payload: { body: "hi" } },
    ...over,
  };
}

/** An authority that records every apply it is asked to cross, and returns `applied`. */
function recordingAuthority(): ApplyAuthority & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(item: ApprovedItem): (() => Promise<ExecutionOutcome>) | null {
      return async (): Promise<ExecutionOutcome> => {
        calls.push(item.id);
        return { status: "applied", label: item.descriptor.type, result: { ok: true, id: item.id } };
      };
    },
  };
}

const readerOf = (items: ApprovedItem[]): ApprovedItemReader => async () => items;
const throwingReader: ApprovedItemReader = async () => {
  throw new Error("reader must not be called when the kill-switch is OFF");
};

describe("hqApplyOnApprovalEnabled — the kill-switch is default-OFF", () => {
  it("is false when the var is absent, empty, or anything but exactly 'on'", () => {
    expect(hqApplyOnApprovalEnabled({})).toBe(false);
    expect(hqApplyOnApprovalEnabled({ CREWFLOW_HQ_APPLY_ON_APPROVAL: "" })).toBe(false);
    expect(hqApplyOnApprovalEnabled({ CREWFLOW_HQ_APPLY_ON_APPROVAL: "ON" })).toBe(false);
    expect(hqApplyOnApprovalEnabled({ CREWFLOW_HQ_APPLY_ON_APPROVAL: "true" })).toBe(false);
    expect(hqApplyOnApprovalEnabled({ CREWFLOW_HQ_APPLY_ON_APPROVAL: "1" })).toBe(false);
  });
  it("is true only for the exact literal 'on'", () => {
    expect(hqApplyOnApprovalEnabled({ CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" })).toBe(true);
  });
});

describe("runApplyOnApprovalDrain — kill-switch OFF is a total no-op", () => {
  it("reads nothing and applies nothing when disabled (the darkness guarantee)", async () => {
    const store = createInMemoryApplicationStore();
    const authority = recordingAuthority();
    const summary = await runApplyOnApprovalDrain({
      env: {}, // default-off
      store,
      authority,
      readApproved: throwingReader, // would throw if the sweep read anything
      now: clock,
    });
    expect(summary.enabled).toBe(false);
    expect(summary.ok).toBe(true);
    expect(summary).toMatchObject({ swept: 0, applied: 0, alreadyApplied: 0, failed: 0, escalated: 0, skipped: 0 });
    expect(authority.calls).toHaveLength(0);
  });
});

describe("runApplyOnApprovalDrain — kill-switch ON applies approved items exactly once", () => {
  it("applies an approved item once, and a re-run is an idempotent no-op success", async () => {
    const store = createInMemoryApplicationStore();
    const authority = recordingAuthority();
    const items = [approvedApproval("appr-1")];
    const deps = { env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" }, store, authority, readApproved: readerOf(items), now: clock };

    const first = await runApplyOnApprovalDrain(deps);
    expect(first).toMatchObject({ enabled: true, swept: 1, applied: 1, alreadyApplied: 0, skipped: 0 });
    expect(authority.calls).toEqual(["appr-1"]);

    // The Task Engine re-runs the sweep every tick — the SAME approved item must not re-apply.
    const second = await runApplyOnApprovalDrain(deps);
    expect(second).toMatchObject({ enabled: true, swept: 1, applied: 0, alreadyApplied: 1 });
    // The boundary was crossed exactly once across both sweeps.
    expect(authority.calls).toEqual(["appr-1"]);
  });

  it("applies each distinct approved item exactly once", async () => {
    const store = createInMemoryApplicationStore();
    const authority = recordingAuthority();
    const items = [approvedApproval("a"), approvedApproval("b"), approvedApproval("c")];
    const summary = await runApplyOnApprovalDrain({
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" },
      store,
      authority,
      readApproved: readerOf(items),
      now: clock,
    });
    expect(summary).toMatchObject({ swept: 3, applied: 3, alreadyApplied: 0, skipped: 0 });
    expect(authority.calls.sort()).toEqual(["a", "b", "c"]);
  });

  it("a failed apply below the ceiling is retried and eventually escalates — never re-applied after escalation", async () => {
    const store = createInMemoryApplicationStore();
    // An authority whose boundary always fails.
    const failing: ApplyAuthority = {
      resolve: () => async () => ({ status: "failed", label: "send", error: "boom" }),
    };
    const deps = { env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" }, store, authority: failing, readApproved: readerOf([approvedApproval("f")]), now: clock };

    const r1 = await runApplyOnApprovalDrain(deps); // attempt 1
    const r2 = await runApplyOnApprovalDrain(deps); // attempt 2
    const r3 = await runApplyOnApprovalDrain(deps); // attempt 3 → reaches the default ceiling (3)
    expect(r1).toMatchObject({ failed: 1, escalated: 0 });
    expect(r2).toMatchObject({ failed: 1, escalated: 0 });
    expect(r3).toMatchObject({ failed: 0, escalated: 1 });

    // Once escalated a human owns it — a later sweep does NOT auto-retry.
    let crossed = 0;
    const spyAuthority: ApplyAuthority = {
      resolve: () => async () => {
        crossed += 1;
        return { status: "failed", label: "send", error: "boom" };
      },
    };
    const r4 = await runApplyOnApprovalDrain({ ...deps, authority: spyAuthority });
    expect(r4).toMatchObject({ escalated: 1 });
    expect(crossed, "an escalated item must not cross the boundary again").toBe(0);
  });
});

describe("runApplyOnApprovalDrain — the sanctioned authority is the ONLY path to an effect", () => {
  it("a null-resolving authority (the production default) applies nothing and records nothing", async () => {
    // A counting wrapper over the frozen in-memory store — proves no record was persisted.
    const inner = createInMemoryApplicationStore();
    let puts = 0;
    const store = { get: inner.get, put: async (r: Parameters<typeof inner.put>[0]) => { puts += 1; return inner.put(r); } };
    const items = [approvedApproval("x"), approvedApproval("y")];
    const summary = await runApplyOnApprovalDrain({
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" },
      store,
      authority: createUnboundApplyAuthority(), // dark: resolves everything to null
      readApproved: readerOf(items),
      now: clock,
    });
    expect(summary).toMatchObject({ enabled: true, swept: 2, applied: 0, alreadyApplied: 0, skipped: 2 });
    // No application record was written — a null authority is never a bare write.
    expect(puts).toBe(0);
  });

  it("the production authority resolves EVERY item to null (dark until the CEO cut-over)", () => {
    const authority = createUnboundApplyAuthority();
    expect(authority.resolve(approvedApproval("z"))).toBeNull();
    expect(
      authority.resolve({
        kind: "decision",
        id: "d1",
        identity: { source: "approval", correlationId: "d1", approvalId: "d1", toolLabel: "hq.decision", actionId: "decision:d1" },
        approver: null,
        descriptor: { type: "hq.decision", payload: {} },
      }),
    ).toBeNull();
  });

  it("the DEFAULT authority (production wiring, authority omitted) is unbound — every item is skipped, nothing applied or recorded", async () => {
    // The route runs `runApplyOnApprovalDrain()` with NO authority, so the default resolves — this
    // proves the production default (createUnboundApplyAuthority) is the one actually wired, not just
    // that an explicitly-passed unbound authority behaves. A skip per item is the safe-no-op proof.
    const inner = createInMemoryApplicationStore();
    let puts = 0;
    const store = { get: inner.get, put: async (r: Parameters<typeof inner.put>[0]) => { puts += 1; return inner.put(r); } };
    const items = [approvedApproval("p"), approvedApproval("q"), approvedApproval("r")];
    const summary = await runApplyOnApprovalDrain({
      env: { CREWFLOW_HQ_APPLY_ON_APPROVAL: "on" }, // kill-switch ON, but authority is the default
      store,
      readApproved: readerOf(items),
      now: clock,
      // authority intentionally omitted — exercise the production default (unbound)
    });
    expect(summary).toMatchObject({ enabled: true, swept: 3, applied: 0, alreadyApplied: 0, failed: 0, escalated: 0, skipped: 3 });
    expect(puts, "an unbound default authority must never record an application marker").toBe(0);
  });
});
