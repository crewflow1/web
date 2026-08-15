import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Custom-rule dispatch — behaviour against the REAL dispatcher, hermetic store.
 *
 * Proves the engine, given a per-org custom rule, honours the condition gate,
 * runs the chosen actions, is idempotent on re-fire, stays org-scoped, and — when
 * the rule has an approval node — creates exactly ONE pending gate and holds the
 * downstream actions. The automation_runs claim, the custom-rule table and the
 * approvals table are in-memory; emitNotifications + the audit sink are spies.
 * (The concurrent-race + RLS proofs are database properties and live in the
 * integration tier.)
 */

const hoisted = vi.hoisted(() => {
  type Run = { status: string; completed_at: string | null };
  const runs = new Map<string, Run>();
  const runKey = (ruleId: unknown, corr: unknown) => `${ruleId}::${corr}`;

  type Row = Record<string, unknown>;
  // org_id → custom rule rows
  const customRules: Row[] = [];
  const approvals: Row[] = [];

  function runsFrom() {
    let op: "insert" | "update" | null = null;
    let row: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      insert(r: Record<string, unknown>) {
        op = "insert";
        row = r;
        return builder;
      },
      update(r: Record<string, unknown>) {
        op = "update";
        row = r;
        return builder;
      },
      eq(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      is(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      or() {
        return builder;
      },
      select() {
        if (op === "insert") {
          const k = runKey(row.rule_id, row.correlation_id);
          if (runs.has(k)) return Promise.resolve({ data: [], error: null });
          runs.set(k, {
            status: String(row.status),
            completed_at: (row.completed_at as string | null) ?? null,
          });
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        const k = runKey(filters.rule_id, filters.correlation_id);
        const existing = runs.get(k);
        if (existing && existing.completed_at == null && existing.status === "failed") {
          existing.status = "running";
          return Promise.resolve({ data: [{ id: k }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      then(resolveFn: (v: { error: null }) => void) {
        // finishRun / recordTerminalSkip insert path (skip rows are insert+await).
        if (op === "insert") {
          const k = runKey(row.rule_id, row.correlation_id);
          if (!runs.has(k)) {
            runs.set(k, {
              status: String(row.status),
              completed_at: (row.completed_at as string | null) ?? null,
            });
          }
          resolveFn({ error: null });
          return Promise.resolve();
        }
        const k = runKey(filters.rule_id, filters.correlation_id);
        const existing = runs.get(k);
        if (existing && op === "update") {
          if (typeof row.status === "string") existing.status = row.status;
          if ("completed_at" in row) {
            existing.completed_at = (row.completed_at as string | null) ?? null;
          }
        }
        resolveFn({ error: null });
        return Promise.resolve();
      },
    };
    return builder;
  }

  function customRulesFrom() {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select() {
        return builder;
      },
      eq(k: string, v: unknown) {
        filters[k] = v;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        const data = customRules.filter(
          (r) =>
            r.org_id === filters.org_id &&
            r.trigger_event === filters.trigger_event &&
            r.enabled === filters.enabled,
        );
        return Promise.resolve({ data, error: null });
      },
    };
    return builder;
  }

  function approvalsFrom() {
    let row: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      insert(r: Record<string, unknown>) {
        row = r;
        // Idempotent on (custom_rule_id, correlation_id).
        const dup = approvals.some(
          (a) =>
            a.custom_rule_id === row.custom_rule_id &&
            a.correlation_id === row.correlation_id,
        );
        if (!dup) approvals.push({ ...row });
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  }

  function makeAdmin() {
    function from(table: string) {
      if (table === "automation_runs") return runsFrom();
      if (table === "automation_custom_rules") return customRulesFrom();
      if (table === "automation_approvals") return approvalsFrom();
      throw new Error(`unexpected admin table in test: ${table}`);
    }
    return { from };
  }

  return { runs, customRules, approvals, makeAdmin };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => hoisted.makeAdmin(),
}));
vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: vi.fn(async () => {}),
}));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: vi.fn(async () => {}),
}));

describe("dispatchAutomation — custom rules", () => {
  const ORG_A = "11111111-1111-1111-1111-111111111111";
  const ORG_B = "22222222-2222-2222-2222-222222222222";

  type Note = Record<string, unknown>;
  let dispatchAutomation: typeof import("@/server/services/automation-dispatcher").dispatchAutomation;
  let emitNotifications: ReturnType<typeof vi.fn>;

  const emittedNotes = (): Note[] =>
    (emitNotifications.mock.calls as Array<[Note[]]>).flatMap((c) => c[0]);

  const addRule = (over: Record<string, unknown>) =>
    hoisted.customRules.push({
      id: over.id ?? "rule-1",
      org_id: over.org_id ?? ORG_A,
      name: over.name ?? "Test rule",
      trigger_event: over.trigger_event ?? "lead.created",
      enabled: over.enabled ?? true,
      definition: over.definition,
    });

  const leadEvent = (orgId: string, sourceId: string, payload: Record<string, unknown>) => ({
    type: "lead.created" as const,
    org_id: orgId,
    source_table: "leads",
    source_id: sourceId,
    payload,
  });

  beforeEach(async () => {
    hoisted.runs.clear();
    hoisted.customRules.length = 0;
    hoisted.approvals.length = 0;
    const disp = await import("@/server/services/automation-dispatcher");
    dispatchAutomation = disp.dispatchAutomation;
    const notif = await import("@/server/services/notifications-service");
    emitNotifications = notif.emitNotifications as unknown as ReturnType<typeof vi.fn>;
    emitNotifications.mockClear();
  });

  it("runs a custom rule whose condition passes", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: {
          combinator: "and",
          conditions: [{ field: "value", operator: "gt", value: 1000 }],
        },
        actions: [{ type: "create_notification", params: { title: "Big lead!" } }],
        requiresApproval: false,
        approvalPosition: 1,
      },
    });

    const res = await dispatchAutomation(leadEvent(ORG_A, "lead-1", { value: 5000 }));
    const run = res.ran.find((r) => r.rule_id === "custom:rule-1");
    expect(run?.status).toBe("ok");
    expect(emitNotifications).toHaveBeenCalledTimes(1);
    const note = emittedNotes()[0]!;
    expect(note.org_id).toBe(ORG_A);
    expect(note.title).toBe("Big lead!");
  });

  it("skips a custom rule whose condition fails — no action", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: {
          combinator: "and",
          conditions: [{ field: "value", operator: "gt", value: 1000 }],
        },
        actions: [{ type: "create_notification", params: {} }],
        requiresApproval: false,
        approvalPosition: 1,
      },
    });
    const res = await dispatchAutomation(leadEvent(ORG_A, "lead-2", { value: 10 }));
    expect(res.ran.find((r) => r.rule_id === "custom:rule-1")?.status).toBe("skipped");
    expect(emitNotifications).not.toHaveBeenCalled();
  });

  it("is idempotent — re-firing the same event does not double-run", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: null,
        actions: [{ type: "create_notification", params: {} }],
        requiresApproval: false,
        approvalPosition: 1,
      },
    });
    const first = await dispatchAutomation(leadEvent(ORG_A, "lead-3", {}));
    expect(first.ran.find((r) => r.rule_id === "custom:rule-1")?.status).toBe("ok");
    const second = await dispatchAutomation(leadEvent(ORG_A, "lead-3", {}));
    expect(second.ran.find((r) => r.rule_id === "custom:rule-1")?.status).toBe("skipped");
    expect(emitNotifications).toHaveBeenCalledTimes(1);
  });

  it("an approval-gated rule (position 0) creates ONE pending gate and runs NO immediate actions", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: null,
        actions: [{ type: "create_notification", params: { title: "after approval" } }],
        requiresApproval: true,
        approvalPosition: 0,
      },
    });
    const res = await dispatchAutomation(leadEvent(ORG_A, "lead-4", {}));
    expect(res.ran.find((r) => r.rule_id === "custom:rule-1")?.status).toBe("ok");
    // No immediate action ran (the sole action is downstream of the gate).
    expect(emitNotifications).not.toHaveBeenCalled();
    // Exactly one pending approval, carrying the downstream action + snapshot.
    expect(hoisted.approvals).toHaveLength(1);
    const gate = hoisted.approvals[0]!;
    expect(gate.org_id).toBe(ORG_A);
    expect(gate.status).toBe("pending");
    expect(gate.source_id).toBe("lead-4");
    expect(Array.isArray(gate.pending_actions)).toBe(true);
    expect((gate.pending_actions as unknown[]).length).toBe(1);
  });

  it("an approval-gated rule (position 1) runs the first action, holds the rest", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: null,
        actions: [
          { type: "create_notification", params: { title: "immediate" } },
          { type: "add_internal_note", params: { note: "held" } },
        ],
        requiresApproval: true,
        approvalPosition: 1,
      },
    });
    await dispatchAutomation(leadEvent(ORG_A, "lead-5", {}));
    // The first action ran immediately.
    expect(emitNotifications).toHaveBeenCalledTimes(1);
    // One pending gate holding the single downstream action.
    expect(hoisted.approvals).toHaveLength(1);
    expect((hoisted.approvals[0]!.pending_actions as unknown[]).length).toBe(1);
  });

  it("re-firing an approval-gated rule does not create a second gate (idempotent)", async () => {
    addRule({
      definition: {
        trigger: "lead.created",
        conditions: null,
        actions: [{ type: "create_notification", params: {} }],
        requiresApproval: true,
        approvalPosition: 0,
      },
    });
    await dispatchAutomation(leadEvent(ORG_A, "lead-6", {}));
    await dispatchAutomation(leadEvent(ORG_A, "lead-6", {}));
    expect(hoisted.approvals).toHaveLength(1);
  });

  it("is org-scoped — org B's rule never fires for an org A event", async () => {
    addRule({
      id: "rule-b",
      org_id: ORG_B,
      definition: {
        trigger: "lead.created",
        conditions: null,
        actions: [{ type: "create_notification", params: {} }],
        requiresApproval: false,
        approvalPosition: 1,
      },
    });
    const res = await dispatchAutomation(leadEvent(ORG_A, "lead-7", {}));
    // No org-A rule exists; org-B's rule is not loaded for an org-A event.
    expect(res.ran.find((r) => r.rule_id === "custom:rule-b")).toBeUndefined();
    expect(emitNotifications).not.toHaveBeenCalled();
  });

  it("an invalid stored definition is skipped, never thrown", async () => {
    addRule({
      definition: { trigger: "lead.created", actions: [{ type: "exec_evil", params: {} }] },
    });
    const res = await dispatchAutomation(leadEvent(ORG_A, "lead-8", {}));
    expect(res.ran.find((r) => r.rule_id === "custom:rule-1")?.status).toBe("skipped");
    expect(emitNotifications).not.toHaveBeenCalled();
  });
});
