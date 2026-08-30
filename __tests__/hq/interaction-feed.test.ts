import { describe, expect, it } from "vitest";
import {
  mergeInteractionFeed,
  taskResultSummary,
  type FeedActivityRow,
  type FeedApprovalRow,
  type FeedTaskRow,
} from "@/lib/ai-employees/interaction-feed";

/**
 * CrewFlow HQ — AI employee interaction feed (contract item 5), unit contract.
 *
 * The feed is the employee's HONEST conversation history: a deterministic merge
 * of stored rows (engine tasks, human config decisions, approvals) — never a
 * generated transcript. Pinned here: ordering, per-source honesty (no invented
 * detail), the finished-at-over-created-at placement, and the bound.
 */

const task = (over: Partial<FeedTaskRow> = {}): FeedTaskRow => ({
  id: "t1",
  task_type: "hq.worker.security_posture",
  status: "completed",
  result: null,
  error_message: null,
  created_at: "2026-08-01T10:00:00.000Z",
  finished_at: null,
  ...over,
});

const activity = (over: Partial<FeedActivityRow> = {}): FeedActivityRow => ({
  id: "a1",
  actor_email: "hello@crewflow.uk",
  action: "ai_employee.config_updated",
  metadata: { status_from: "idle", status_to: "disabled" },
  created_at: "2026-08-02T10:00:00.000Z",
  ...over,
});

const approval = (over: Partial<FeedApprovalRow> = {}): FeedApprovalRow => ({
  id: "p1",
  subject_type: "outreach_email",
  action: "send",
  state: "approved",
  reviewer_email: "hello@crewflow.uk",
  decision_reason: null,
  requested_at: "2026-08-03T10:00:00.000Z",
  decided_at: null,
  ...over,
});

describe("taskResultSummary", () => {
  it("reads a summary/message string out of the result payload, clipped", () => {
    expect(taskResultSummary({ summary: "Posture holds." }, null)).toBe("Posture holds.");
    expect(taskResultSummary({ message: "Drafted 3 items" }, null)).toBe("Drafted 3 items");
    const long = "x".repeat(400);
    expect(taskResultSummary({ summary: long }, null)?.length).toBe(280);
  });
  it("falls back to the error message, and NEVER invents a summary", () => {
    expect(taskResultSummary(null, "lease lost")).toBe("lease lost");
    expect(taskResultSummary(null, null)).toBeNull();
    expect(taskResultSummary({ count: 3 }, null)).toBeNull();
  });
});

describe("mergeInteractionFeed", () => {
  it("merges all three sources newest-first", () => {
    const items = mergeInteractionFeed([task()], [activity()], [approval()]);
    expect(items.map((i) => i.kind)).toEqual(["approval", "config", "task"]);
  });

  it("places a finished task at its finish time (when it 'answered'), not its creation", () => {
    const items = mergeInteractionFeed(
      [
        task({
          id: "t-old-start",
          created_at: "2026-08-01T00:00:00.000Z",
          finished_at: "2026-08-04T00:00:00.000Z",
        }),
      ],
      [activity()],
      [],
    );
    expect(items[0]?.key).toBe("task:t-old-start");
    expect(items[0]?.at).toBe("2026-08-04T00:00:00.000Z");
  });

  it("uses a decided approval's decision time, and carries the reviewer + reason", () => {
    const items = mergeInteractionFeed(
      [],
      [],
      [
        approval({
          state: "rejected",
          decision_reason: "Wrong recipient",
          decided_at: "2026-08-05T00:00:00.000Z",
        }),
      ],
    );
    expect(items[0]?.at).toBe("2026-08-05T00:00:00.000Z");
    expect(items[0]?.status).toBe("rejected");
    expect(items[0]?.detail).toBe("Wrong recipient");
    expect(items[0]?.actor).toBe("hello@crewflow.uk");
  });

  it("derives an honest config detail (status transition) and humanises the action", () => {
    const items = mergeInteractionFeed([], [activity()], []);
    expect(items[0]?.title).toBe("config updated");
    expect(items[0]?.detail).toBe("status idle → disabled");
  });

  it("leaves detail null when a source row carries none — nothing is invented", () => {
    const items = mergeInteractionFeed(
      [task()],
      [activity({ metadata: null })],
      [approval()],
    );
    for (const i of items) expect(i.detail).toBeNull();
  });

  it("is bounded and deterministic on timestamp ties", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      task({ id: `t${i}`, created_at: "2026-08-01T10:00:00.000Z" }),
    );
    const items = mergeInteractionFeed(many, [], [], 60);
    expect(items).toHaveLength(60);
    const again = mergeInteractionFeed(many, [], [], 60);
    expect(items.map((i) => i.key)).toEqual(again.map((i) => i.key));
  });
});
