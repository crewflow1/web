import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { foldWorkflowRuns, litCiSnapshot, darkCiSnapshot } from "@/lib/hq/qa-ci";
import { GithubAdapter } from "@/lib/integrations/github/adapter";

/**
 * HQ QA AI — the R092 CI-signal leg (P9 residual).
 *
 *   A. foldWorkflowRuns — pure, deterministic, honest: exact counts over a
 *      real-shaped runs payload, malformed entries SKIPPED (never coerced),
 *      and NO pass rate while nothing has concluded (null, not 0-as-real).
 *   B. The dark seam, refuse-before-fetch: with no GITHUB_TOKEN/GITHUB_REPO
 *      the adapter and the `qa_ci_snapshot` handler both complete honestly
 *      dark — and the fetch spy proves the network was NEVER touched.
 */

const NOW = new Date("2026-08-26T12:00:00Z");

/** A real-shaped GitHub Actions run, as the adapter maps it. */
const run = (
  id: number,
  conclusion: string | null,
  daysAgo: number,
  status = conclusion == null ? "in_progress" : "completed",
) => ({
  id,
  name: "CI",
  status,
  conclusion,
  headBranch: "main",
  createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  updatedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
});

// ---------------------------------------------------------------------------
// A. The fold — pure and honest.
// ---------------------------------------------------------------------------

describe("A. foldWorkflowRuns — deterministic fold of a bounded run window", () => {
  it("folds a real-shaped payload into exact counts and a real pass rate", () => {
    const snapshot = foldWorkflowRuns(
      [
        run(1, "success", 1),
        run(2, "success", 2),
        run(3, "failure", 3),
        run(4, "cancelled", 5),
        run(5, null, 0), // still executing — no conclusion yet
      ],
      NOW,
    );
    expect(snapshot.total).toBe(5);
    expect(snapshot.byConclusion).toEqual({
      success: 2,
      failure: 1,
      cancelled: 1,
      in_progress: 1,
    });
    // 2 successes of 4 CONCLUDED runs — the in-flight run is not guessed at.
    expect(snapshot.passRatePct).toBe(50);
    expect(snapshot.windowDays).toBe(5);
  });

  it("skips a malformed entry — counted nowhere, never coerced into a metric", () => {
    const malformed = { id: "not-a-number", conclusion: 42 }; // structurally broken
    const snapshot = foldWorkflowRuns(
      [run(1, "success", 1), malformed, null, "junk", run(2, "failure", 2)],
      NOW,
    );
    expect(snapshot.total).toBe(2);
    expect(snapshot.byConclusion).toEqual({ success: 1, failure: 1 });
    expect(snapshot.passRatePct).toBe(50);
  });

  it("reports NO pass rate while nothing has concluded — null, not a fabricated 0", () => {
    const snapshot = foldWorkflowRuns([run(1, null, 0), run(2, null, 0)], NOW);
    expect(snapshot.total).toBe(2);
    expect(snapshot.passRatePct).toBeNull();
    expect(snapshot.byConclusion).toEqual({ in_progress: 2 });
  });

  it("is empty-honest: zero runs ⇒ zero total, null pass rate, zero window", () => {
    const snapshot = foldWorkflowRuns([], NOW);
    expect(snapshot).toEqual({
      total: 0,
      byConclusion: {},
      passRatePct: null,
      windowDays: 0,
    });
  });

  it("is deterministic — same rows, same now, same snapshot", () => {
    const rows = [run(1, "success", 1), run(2, "failure", 4), run(3, null, 0)];
    expect(foldWorkflowRuns(rows, NOW)).toEqual(foldWorkflowRuns(rows, NOW));
  });

  it("litCiSnapshot wraps the fold with lit provenance and a grounded summary", () => {
    const result = litCiSnapshot([run(1, "success", 1), run(2, "failure", 2)], NOW);
    expect(result.kind).toBe("qa_ci_snapshot");
    expect(result.dark).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.runs).toEqual({
      total: 2,
      byConclusion: { success: 1, failure: 1 },
      passRatePct: 50,
      windowDays: 2,
    });
    expect(result.sources).toEqual(["github:workflow_runs"]);
    expect(result.summary).toContain("50%");
  });

  it("darkCiSnapshot carries the stated reason and null runs — the honest absence", () => {
    const result = darkCiSnapshot("GitHub is not connected.", NOW);
    expect(result.dark).toBe(true);
    expect(result.reason).toBe("GitHub is not connected.");
    expect(result.runs).toBeNull();
    expect(result.summary).toContain("awaiting GitHub credential");
    expect(result.sources).toEqual(["github:workflow_runs (dark — not configured)"]);
  });
});

// ---------------------------------------------------------------------------
// B. The dark seam — refuse BEFORE fetch, with the network spied.
// ---------------------------------------------------------------------------

const fetchSpy = vi.fn();

// The handler's queue-side imports are irrelevant to the dark path — mock the
// server plumbing so importing the runner pulls no Supabase/identity chain.
vi.mock("@/server/services/hq-tasks", () => ({ enqueueTask: vi.fn() }));
vi.mock("@/server/services/hq-worker-runner-kit", () => ({
  resolveWorkerIdentity: vi.fn(),
  normaliseWorkerOutcome: vi.fn(),
}));
vi.mock("@/server/sdk/tasks", () => ({
  drainTaskType: vi.fn(),
  registerTaskHandler: vi.fn(),
  runReadyTask: vi.fn(),
}));

describe("B. dark path — no credential, no network, an honest completion", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the adapter refuses listRecentWorkflowRuns before fetch when dark", async () => {
    const result = await new GithubAdapter().listRecentWorkflowRuns(100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_configured");
      expect(result.message).toContain("GITHUB_TOKEN");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the qa_ci_snapshot handler COMPLETES dark — never fails, never fetches", async () => {
    const { qaCiSnapshotHandler } = await import("@/server/services/hq-qa-ci-runner");
    const result = (await qaCiSnapshotHandler(
      { identity: { employeeId: "emp-test-1", slug: "qa-ai" } } as never,
    )) as Record<string, unknown>;

    expect(result.kind).toBe("qa_ci_snapshot");
    expect(result.dark).toBe(true);
    expect(result.runs).toBeNull();
    // The reason is the adapter's OWN refusal — activation is the only switch.
    expect(String(result.reason)).toContain("GITHUB_TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enqueueQaCiSnapshot dedupes per UTC day and assigns to the resolved qa-ai", async () => {
    const { resolveWorkerIdentity } = await import(
      "@/server/services/hq-worker-runner-kit"
    );
    const { enqueueTask } = await import("@/server/services/hq-tasks");
    vi.mocked(resolveWorkerIdentity).mockResolvedValue({
      identity: { slug: "qa-ai" } as never,
      employeeId: "emp-qa-1",
    });
    vi.mocked(enqueueTask).mockResolvedValue({
      ok: true,
      task: { id: "task-1" },
    } as never);

    const { enqueueQaCiSnapshot } = await import("@/server/services/hq-qa-ci-runner");
    const out = await enqueueQaCiSnapshot(NOW);
    expect(out).toEqual({ ok: true, taskId: "task-1" });
    expect(vi.mocked(enqueueTask).mock.calls[0]![0]).toMatchObject({
      taskType: "qa_ci_snapshot",
      assignedEmployeeId: "emp-qa-1",
      dedupeKey: "qa_ci_snapshot:2026-08-26",
      origin: "cron",
    });
  });

  it("skips the enqueue entirely when the qa-ai identity was never seeded", async () => {
    const { resolveWorkerIdentity } = await import(
      "@/server/services/hq-worker-runner-kit"
    );
    const { enqueueTask } = await import("@/server/services/hq-tasks");
    vi.mocked(enqueueTask).mockClear();
    vi.mocked(resolveWorkerIdentity).mockResolvedValue({
      identity: { slug: "qa-ai" } as never,
      employeeId: null,
    });
    const { enqueueQaCiSnapshot } = await import("@/server/services/hq-qa-ci-runner");
    const out = await enqueueQaCiSnapshot(NOW);
    expect(out).toEqual({ ok: true, skipped: true });
    expect(vi.mocked(enqueueTask)).not.toHaveBeenCalled();
  });
});
