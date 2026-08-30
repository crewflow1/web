import { describe, expect, it } from "vitest";
import {
  foldRecommendations,
  type RecommendationTaskRow,
} from "@/lib/ai-employees/recommendations";

/**
 * CrewFlow HQ — AI employee recommendations (contract item: Recommendations),
 * unit contract.
 *
 * The list is a PURE fold over stored `hq_ai_tasks.result` jsonb — never a
 * generated proposal. Pinned here, with the REAL shapes the runners write
 * (standard envelope actions/alternatives from server/sdk/output.ts, exec
 * review findings from lib/hq/exec-runners.ts, qualification verdicts from
 * lib/qualification/model.ts, research sales-prep briefs from
 * lib/research/model.ts): per-shape extraction, ordering, the bound, and the
 * skip-not-throw posture for malformed results.
 */

const task = (over: Partial<RecommendationTaskRow> = {}): RecommendationTaskRow => ({
  id: "t1",
  task_type: "hq.exec.cfo_review",
  result: null,
  created_at: "2026-08-01T10:00:00.000Z",
  finished_at: "2026-08-01T10:05:00.000Z",
  ...over,
});

// The standard output envelope (server/sdk/output.ts): actions[] + alternatives[].
const envelopeResult = {
  summary: "Reviewed outreach options.",
  actions: [
    { type: "comms.send_email", description: "Draft a follow-up email to the lead." },
    { type: "crm.update_status" },
  ],
  alternatives: [
    { summary: "Wait another week", reasoning: "Signal was thin.", confidence: 0.4 },
  ],
};

// An exec review (lib/hq/exec-runners.ts) — findings carry proposedAction.
const execReviewResult = {
  kind: "exec_review",
  role: "cfo-ai",
  roleLabel: "CFO",
  verdict: "attention",
  findings: [
    {
      key: "overdue_invoices",
      label: "Overdue invoices",
      severity: "warning",
      detail: "3 invoices past due over £2,000.",
      source: "billing_invoices",
      proposedAction: "Review and prioritise with the human owner.",
    },
  ],
  requiresHumanApproval: true,
  autonomousApply: false,
};

// A qualification verdict (lib/qualification/model.ts, result.verdict).
const verdictResult = {
  phase: "completed",
  verdict: {
    decision: "qualified",
    tier: "hot",
    score: 82,
    confidence: 90,
    criteria: [],
    recommendedStatus: "qualified",
    rationale: ["Strong fit score.", "Decision maker identified."],
    summary: "Strong fit — recommend moving to qualified.",
  },
};

// A research sales-prep brief (lib/research/model.ts, result.brief).
const briefResult = {
  phase: "completed",
  brief: {
    coldCallOpener: "…",
    discoveryQuestions: [],
    likelyObjections: [],
    objectionResponses: [],
    valueProposition: "…",
    recommendedModules: ["Jobs", "Quotes", "Fleet"],
    demoFocus: "…",
    meetingAgenda: [],
    bestAngle: "Lead with the scheduling pain their careers page reveals.",
    bestTimeToCall: null,
  },
};

describe("foldRecommendations — the real stored shapes", () => {
  it("extracts envelope actions[] and alternatives[]", () => {
    const items = foldRecommendations([task({ result: envelopeResult })]);
    expect(items).toHaveLength(3);
    const action = items.find((i) => i.key.endsWith(":action:0"));
    expect(action).toMatchObject({
      kind: "action",
      taskId: "t1",
      taskType: "hq.exec.cfo_review",
      at: "2026-08-01T10:05:00.000Z",
      title: "Proposed: comms send email",
      detail: "Draft a follow-up email to the lead.",
    });
    // An action with only its required `type` still surfaces, with no invented detail.
    expect(items.find((i) => i.key.endsWith(":action:1"))).toMatchObject({
      title: "Proposed: crm update status",
      detail: null,
    });
    expect(items.find((i) => i.kind === "alternative")).toMatchObject({
      title: "Wait another week",
      detail: "Signal was thin.",
    });
  });

  it("extracts exec-review findings as their proposedAction", () => {
    const items = foldRecommendations([task({ result: execReviewResult })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "finding",
      title: "Review and prioritise with the human owner.",
      detail: "Overdue invoices — 3 invoices past due over £2,000.",
    });
  });

  it("does NOT read findings[] outside an exec_review result (discriminant gate)", () => {
    const items = foldRecommendations([
      task({ result: { findings: [{ proposedAction: "Do a thing." }] } }),
    ]);
    expect(items).toEqual([]);
  });

  it("extracts a qualification verdict's recommended status", () => {
    const items = foldRecommendations([task({ result: verdictResult })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "verdict",
      title: "Recommended pipeline status: qualified",
      detail: "Strong fit — recommend moving to qualified.",
    });
  });

  it("surfaces a review verdict's null recommendedStatus as the hold it recommends", () => {
    const items = foldRecommendations([
      task({
        result: {
          verdict: { decision: "review", recommendedStatus: null, summary: "Unclear fit." },
        },
      }),
    ]);
    expect(items[0]).toMatchObject({
      kind: "verdict",
      title: "Recommended: hold for human review",
      detail: "Unclear fit.",
    });
  });

  it("extracts a research brief's recommended modules + best angle", () => {
    const items = foldRecommendations([task({ result: briefResult })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "sales_prep",
      title: "Recommended modules: Jobs, Quotes, Fleet",
      detail: "Lead with the scheduling pain their careers page reveals.",
    });
  });
});

describe("foldRecommendations — honesty and bounds", () => {
  it("skips malformed results without throwing and without inventing items", () => {
    const malformed: RecommendationTaskRow[] = [
      task({ id: "m1", result: null }),
      // Fields present but structurally wrong — every one must be skipped.
      task({
        id: "m2",
        result: {
          actions: "send an email", // not an array
          alternatives: [{}, { summary: 42 }, null], // entries missing/typed wrong
          verdict: { recommendedStatus: "qualified" }, // no decision discriminant
          brief: { recommendedModules: [] }, // empty recommendation is none
          findings: [{ proposedAction: "x" }], // no exec_review discriminant
        },
      }),
      task({ id: "m3", result: { verdict: "qualified" } as never }), // verdict not an object
    ];
    expect(() => foldRecommendations(malformed)).not.toThrow();
    expect(foldRecommendations(malformed)).toEqual([]);
  });

  it("orders newest-first by finish time, deterministically, and applies the bound", () => {
    const items = foldRecommendations([
      task({ id: "old", result: execReviewResult, finished_at: "2026-08-01T00:00:00.000Z" }),
      task({ id: "new", result: execReviewResult, finished_at: "2026-08-05T00:00:00.000Z" }),
      // A completed row with no finish stamp falls back to creation time.
      task({
        id: "legacy",
        result: execReviewResult,
        created_at: "2026-08-03T00:00:00.000Z",
        finished_at: null,
      }),
    ]);
    expect(items.map((i) => i.taskId)).toEqual(["new", "legacy", "old"]);

    const bounded = foldRecommendations(
      Array.from({ length: 100 }, (_, n) => task({ id: `t${n}`, result: envelopeResult })),
    );
    expect(bounded).toHaveLength(60);
  });

  it("clips runaway text to the display bound", () => {
    const items = foldRecommendations([
      task({
        result: {
          actions: [{ type: "x", description: "y".repeat(500) }],
        },
      }),
    ]);
    expect(items[0]?.detail?.length).toBe(280);
  });
});
