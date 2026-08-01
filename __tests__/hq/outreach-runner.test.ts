import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * CrewFlow HQ — Outreach AI runner, driven through the REAL Task Engine runner
 * (CEO Directive 010, Phase 4; migrated onto the Generic Task Engine, Directive
 * #012 / D-02).
 *
 * Outreach AI is the third employee on the shared task lifecycle (after Research
 * and Lead Qualification), and the first whose work is a GOVERNED generation that
 * is DARK by default. This suite proves the migration's load-bearing behaviours
 * without a database: it mocks ONLY the admin client's rpc/read surface and the
 * three service seams the handler calls (the Draft Engine, the Sales-AI writers,
 * the employee registry), so the REAL runner, the REAL registry and the REAL
 * run-loop execute end to end. The claims it pins:
 *
 *   1. DARK ⇒ COMPLETED, not failed. With no cost tier bound the Draft Engine's
 *      governed leg short-circuits and returns a DETERMINISTIC draft; the run must
 *      COMPLETE (the engine marks the task completed), never fail. Degradation is a
 *      first-class path.
 *   2. The governed generation is invoked with the right template + subject — the
 *      handler routes AI through the Draft Engine (generateDraft), the ONE place
 *      the invokeWithGovernor gate lives, never a direct provider SDK.
 *   3. EXECUTION STAYS LOCKED — the run sends nothing: the draft is the terminal
 *      artifact, logged for human review (outcome='draft', requiresApproval).
 *   4. The failure path is a real, retryable engine failure — a persistence fault
 *      from the Draft Engine throws, and the runner fails the task (not a silent
 *      dark no-op).
 *   5. A missing subject is a NON-retryable terminal failure (a retry cannot fix
 *      a task with no company).
 *   6. An empty queue is an idempotent skip (the type-oriented claim finds nothing).
 */

const { rpcMock, generateDraftMock, assembleContextMock, recordTimelineMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  generateDraftMock: vi.fn(),
  assembleContextMock: vi.fn(),
  recordTimelineMock: vi.fn(),
}));

// The admin client: rpc drives the runner's lifecycle entry points; `from` serves
// the one read runOutreachTask makes after completion (draftOfTask).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: rpcMock,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { result: { summary: { draftId: "draft-outreach-1" } } },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
// Import-safety only: the run-loop pulls in the memory facet, which reaches for embeddings.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

// The Draft Engine seam — the ONE governed generation surface. Default: the DARK
// deterministic fallback (exactly what an unbound tier yields in production).
vi.mock("@/server/services/hq-drafts", () => ({
  generateDraft: generateDraftMock,
  assembleDraftContext: assembleContextMock,
}));

// The Sales-AI writers — timeline provenance. recordTimelineEvent is fire-and-forget.
vi.mock("@/server/services/hq-sales", () => ({
  getCompany: async (id: string) =>
    id === "company-missing"
      ? null
      : { id, name: "Probe Construction Ltd", status: "outreach_ready" },
  recordTimelineEvent: recordTimelineMock,
}));

// The employee registry — a seeded Outreach AI row.
vi.mock("@/server/services/ai-employees", () => ({
  listAiEmployees: async () => [{ id: "emp-outreach", slug: "outreach-ai" }],
}));

// Authority resolves to the locked floor (read+draft+memory, can_execute=false).
vi.mock("@/server/sdk/registry-parity", () => ({
  resolveServedAuthority: async () => ({
    capabilities: { tokens: ["read", "draft", "memory"], source: "registry" },
    posture: { canExecute: false, requiresApproval: true },
    memoryScope: "organization",
  }),
}));

import { runOutreachTask, drainOutreachTasks } from "@/server/services/hq-outreach";

type Row = Record<string, unknown>;

function makeTask(over: Row = {}): Row {
  return {
    id: "task-outreach-1",
    task_type: "generate_email",
    status: "running",
    subject_id: "company-1",
    correlation_id: "corr-outreach-1",
    cost_budget_micros: 0,
    payload: {},
    result: null,
    created_by: "operator@crewflow.test",
    ...over,
  };
}

/** The DARK deterministic draft the Draft Engine returns when no tier is bound. */
function deterministicDraft(over: Row = {}): Row {
  return {
    id: "draft-outreach-1",
    provenance: "deterministic",
    status: "fallback",
    fallback_reason: "no_provider",
    content: { subject: "A quick idea for Probe Construction", body: "…", channel: "email" },
    ...over,
  };
}

/** Wire the rpc surface for one claim → checkpoints → terminal cycle. */
function wireRunner(opts: { task?: Row | null; terminal?: "complete" | "fail" } = {}): void {
  const task = opts.task === undefined ? makeTask() : opts.task;
  rpcMock.mockImplementation((fn: string) => {
    if (fn === "hq_ai_task_claim")
      return task
        ? { data: { ok: true, task }, error: null }
        : { data: { ok: false, reason: "empty" }, error: null };
    if (fn === "hq_ai_task_checkpoint") return { data: true, error: null };
    if (fn === "hq_ai_task_heartbeat") return { data: true, error: null };
    if (fn === "hq_ai_task_complete")
      return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
    if (fn === "hq_ai_task_fail")
      return { data: { ok: true, task: makeTask({ status: "failed" }) }, error: null };
    return { data: null, error: null };
  });
}

function callsTo(fn: string): number {
  return rpcMock.mock.calls.filter((c) => c[0] === fn).length;
}

beforeEach(() => {
  rpcMock.mockReset();
  generateDraftMock.mockReset();
  assembleContextMock.mockReset();
  recordTimelineMock.mockReset();
  assembleContextMock.mockResolvedValue({
    subject: { name: "Probe Construction Ltd", label: "outreach_email" },
    memory: null,
    research: null,
    qualification: null,
  });
  recordTimelineMock.mockResolvedValue(null);
  generateDraftMock.mockResolvedValue({ ok: true, draft: deterministicDraft() });
});

// =====================================================================
// 1. DARK ⇒ COMPLETED (not failed), with the governed generation invoked.
// =====================================================================

describe("outreach-ai — the dark path completes the task with a deterministic draft", () => {
  it("claims → drafts (deterministic) → completes; the task is COMPLETED, never failed", async () => {
    wireRunner();

    const outcome = await runOutreachTask("task-outreach-1");

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.draftId).toBe("draft-outreach-1");
    }

    // The terminal transition was a COMPLETION, not a failure.
    expect(callsTo("hq_ai_task_complete")).toBe(1);
    expect(callsTo("hq_ai_task_fail")).toBe(0);
  });

  it("routes AI through the Draft Engine with the cold_email template + outreach subject", async () => {
    wireRunner();

    await runOutreachTask("task-outreach-1");

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    const arg = generateDraftMock.mock.calls[0]![0];
    expect(arg).toMatchObject({
      aiEmployeeId: "emp-outreach",
      subjectType: "outreach_email",
      subjectId: "company-1",
      kind: "cold_email",
      correlationId: "corr-outreach-1",
    });
  });

  it("EXECUTION STAYS LOCKED — it sends nothing; the draft is logged for human review (outcome='draft')", async () => {
    wireRunner();

    await runOutreachTask("task-outreach-1");

    // The draft was recorded with outcome='draft' + requiresApproval — never sent.
    const draftLog = recordTimelineMock.mock.calls
      .map((c) => c[0] as Row)
      .find((e) => e.event_type === "email_generated");
    expect(draftLog).toBeTruthy();
    expect(draftLog?.outcome).toBe("draft");
    expect((draftLog?.metadata as Row)?.requiresApproval).toBe(true);
    expect(draftLog?.source).toBe("ai_outreach");
  });
});

// =====================================================================
// 2. The failure paths — a real fault fails the task (retryable), a missing
//    subject is terminal, and an empty queue is an idempotent skip.
// =====================================================================

describe("outreach-ai — failures are engine failures, not silent dark no-ops", () => {
  it("a Draft Engine persistence fault throws → the runner FAILS the task (retryable)", async () => {
    wireRunner();
    generateDraftMock.mockResolvedValue({ ok: false, error: "persist_failed" });

    const outcome = await runOutreachTask("task-outreach-1");

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(callsTo("hq_ai_task_fail")).toBe(1);
    expect(callsTo("hq_ai_task_complete")).toBe(0);
    // A generic Error is RETRYABLE — the engine re-queues it (p_retryable=true).
    const failArgs = rpcMock.mock.calls.find((c) => c[0] === "hq_ai_task_fail")?.[1] as Row;
    expect(failArgs?.p_retryable).toBe(true);
  });

  it("a task with no company is a NON-retryable terminal failure", async () => {
    wireRunner({ task: makeTask({ subject_id: null }) });

    const outcome = await runOutreachTask("task-outreach-1");

    expect(outcome.status).toBe("failed");
    expect(generateDraftMock).not.toHaveBeenCalled();
    const failArgs = rpcMock.mock.calls.find((c) => c[0] === "hq_ai_task_fail")?.[1] as Row;
    expect(failArgs?.p_retryable).toBe(false);
  });

  it("an empty queue is an idempotent skip (the type-oriented claim finds nothing)", async () => {
    wireRunner({ task: null });

    const outcome = await runOutreachTask("task-outreach-1");

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("skipped");
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(callsTo("hq_ai_task_complete")).toBe(0);
  });
});

// =====================================================================
// 3. The drain entry point drives the same handler through the runner.
// =====================================================================

describe("outreach-ai — the cron drain runs the handler through the canonical runner", () => {
  it("drains one ready task to completion, then exits on the empty queue", async () => {
    // First claim yields the task; the second (drain loops) yields empty.
    let claims = 0;
    rpcMock.mockImplementation((fn: string) => {
      if (fn === "hq_ai_task_claim") {
        claims += 1;
        return claims === 1
          ? { data: { ok: true, task: makeTask() }, error: null }
          : { data: { ok: false, reason: "empty" }, error: null };
      }
      if (fn === "hq_ai_task_checkpoint") return { data: true, error: null };
      if (fn === "hq_ai_task_heartbeat") return { data: true, error: null };
      if (fn === "hq_ai_task_complete")
        return { data: { ok: true, task: makeTask({ status: "completed" }) }, error: null };
      return { data: null, error: null };
    });

    const res = await drainOutreachTasks(3);

    expect(res.ok).toBe(true);
    expect(res.claimed).toBe(1);
    expect(res.completed).toBe(1);
    expect(res.failed).toBe(0);
    expect(generateDraftMock).toHaveBeenCalledTimes(1);
  });
});
