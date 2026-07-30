import { describe, expect, it } from "vitest";
import {
  CONTROL_POINTS,
  CONTROL_POINT_META,
  ITP_STATUSES,
  ITP_STATUS_LABELS,
  SIGNOFF_RESULTS,
  SIGNOFF_RESULT_META,
  canIssue,
  canTransition,
  completionPercent,
  holdPointWarnings,
  isEditable,
  isFullyAccepted,
  requiresComment,
  resultAccepts,
  type PlanProgress,
} from "@/lib/quality/itp";
import {
  createPlanSchema,
  planItemSchema,
  signoffSchema,
  voidSignoffSchema,
  orNull,
} from "@/lib/quality/schema";

/**
 * Works Quality — pure domain unit tests. No DB, no I/O, no AI.
 *
 * The hold-point GATE itself is deliberately NOT computed in TS (its single
 * authority is the database), so what is tested here is the interpretation of
 * the gate the database reports, and the input validation that keeps a write
 * from reaching a constraint the operator can't read.
 */

const JOB = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";

const progress = (over: Partial<PlanProgress> = {}): PlanProgress => ({
  totalItems: 0,
  holdPointItems: 0,
  signedOffItems: 0,
  outstandingRequiredItems: 0,
  openHoldPoints: 0,
  failedItems: 0,
  holdPointBreaches: 0,
  openHoldItemNumber: null,
  ...over,
});

describe("lifecycle", () => {
  it("only a draft is editable", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ITP_STATUSES.filter((x) => x !== "draft")) {
      expect(isEditable(s)).toBe(false);
    }
  });

  it("mirrors the DB transition matrix exactly", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("draft", "withdrawn")).toBe(true);
    expect(canTransition("issued", "superseded")).toBe(true);
    expect(canTransition("issued", "withdrawn")).toBe(true);
    // Everything else is refused, including every backwards move.
    expect(canTransition("draft", "superseded")).toBe(false);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("superseded", "issued")).toBe(false);
    expect(canTransition("withdrawn", "issued")).toBe(false);
    expect(canTransition("superseded", "withdrawn")).toBe(false);
  });

  it("labels an issued plan 'Current' — the word a site team uses", () => {
    expect(ITP_STATUS_LABELS.issued).toBe("Current");
  });
});

describe("issue readiness", () => {
  const base = { status: "draft" as const, title: "ITP", workPackage: "Drainage", jobId: JOB, itemCount: 3 };

  it("passes a complete draft", () => {
    expect(canIssue(base)).toEqual({ ok: true, reasons: [] });
  });

  it("requires a job — an ITP governs a specific job's works", () => {
    const r = canIssue({ ...base, jobId: null });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/job/i);
  });

  it("requires at least one check", () => {
    const r = canIssue({ ...base, itemCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/at least one inspection item/i);
  });

  it("requires a work package (the plan's natural key with the job)", () => {
    expect(canIssue({ ...base, workPackage: "   " }).ok).toBe(false);
  });

  it("refuses a non-draft", () => {
    expect(canIssue({ ...base, status: "issued" }).ok).toBe(false);
    expect(canIssue({ ...base, status: "superseded" }).ok).toBe(false);
  });

  it("reports every problem, not just the first", () => {
    const r = canIssue({ status: "issued", title: "", workPackage: "", jobId: null, itemCount: 0 });
    expect(r.reasons).toHaveLength(5);
  });
});

describe("sign-off results", () => {
  it("pass and pass-with-comment accept the works; fail does not", () => {
    expect(resultAccepts("pass")).toBe(true);
    expect(resultAccepts("pass_with_comment")).toBe(true);
    expect(resultAccepts("fail")).toBe(false);
  });

  it("the accepting set matches the DB predicate exactly", () => {
    // The DB releases a hold point on `result in ('pass','pass_with_comment')`.
    // If a result is ever added, this forces both sides to be reconsidered.
    const accepting = SIGNOFF_RESULTS.filter((r) => SIGNOFF_RESULT_META[r].accepts);
    expect([...accepting].sort()).toEqual(["pass", "pass_with_comment"]);
  });

  it("a non-pass must be explained", () => {
    expect(requiresComment("pass")).toBe(false);
    expect(requiresComment("pass_with_comment")).toBe(true);
    expect(requiresComment("fail")).toBe(true);
  });

  it("every result and control point has display metadata", () => {
    for (const r of SIGNOFF_RESULTS) expect(SIGNOFF_RESULT_META[r].label).toBeTruthy();
    for (const c of CONTROL_POINTS) {
      expect(CONTROL_POINT_META[c].label).toBeTruthy();
      expect(CONTROL_POINT_META[c].help).toBeTruthy();
    }
  });
});

describe("hold-point WARN seam", () => {
  it("is silent when nothing is outstanding", () => {
    expect(holdPointWarnings(progress({ totalItems: 4, signedOffItems: 4 }))).toEqual([]);
  });

  it("names the gate item when a hold point is open, at danger tone", () => {
    const w = holdPointWarnings(progress({ openHoldPoints: 1, openHoldItemNumber: 2 }));
    expect(w).toHaveLength(1);
    expect(w[0]!.id).toBe("open-hold-point");
    expect(w[0]!.tone).toBe("danger");
    expect(w[0]!.title).toMatch(/Hold point 2/);
    // The wording must say "should not proceed", not "cannot" — nothing is blocked.
    expect(w[0]!.body).toMatch(/should not proceed past item 2/i);
    expect(w[0]!.body).not.toMatch(/blocked|cannot proceed|prevented/i);
  });

  it("counts multiple open hold points while still naming the earliest gate", () => {
    const w = holdPointWarnings(progress({ openHoldPoints: 3, openHoldItemNumber: 2 }));
    expect(w[0]!.body).toMatch(/3 hold points are still open/);
    expect(w[0]!.body).toMatch(/past item 2/);
  });

  it("surfaces out-of-sequence sign-offs recorded past an open hold point", () => {
    const w = holdPointWarnings(progress({ holdPointBreaches: 2 }));
    expect(w.map((x) => x.id)).toContain("hold-point-breach");
    expect(w.find((x) => x.id === "hold-point-breach")!.title).toMatch(/2 sign-offs were recorded/);
  });

  it("surfaces failed checks separately from open hold points", () => {
    const w = holdPointWarnings(progress({ failedItems: 1 }));
    expect(w.map((x) => x.id)).toEqual(["failed-item"]);
    expect(w[0]!.title).toMatch(/1 check has failed/);
  });

  it("orders the open gate first when several things are wrong", () => {
    const w = holdPointWarnings(
      progress({ openHoldPoints: 1, openHoldItemNumber: 5, holdPointBreaches: 1, failedItems: 2 }),
    );
    expect(w.map((x) => x.id)).toEqual(["open-hold-point", "hold-point-breach", "failed-item"]);
  });
});

describe("progress arithmetic", () => {
  it("an empty plan is 0% and never fully accepted", () => {
    expect(completionPercent(progress())).toBe(0);
    expect(isFullyAccepted(progress())).toBe(false);
  });

  it("counts a plan with nothing outstanding as complete", () => {
    const p = progress({ totalItems: 5, outstandingRequiredItems: 0, signedOffItems: 5 });
    expect(completionPercent(p)).toBe(100);
    expect(isFullyAccepted(p)).toBe(true);
  });

  it("a FAILED check keeps the plan incomplete (the DB counts it outstanding)", () => {
    // The read-model treats a live `fail` as outstanding — a failed check that
    // read as done would be the control-failing-open false negative.
    const p = progress({ totalItems: 4, signedOffItems: 4, failedItems: 1, outstandingRequiredItems: 1 });
    expect(isFullyAccepted(p)).toBe(false);
    expect(completionPercent(p)).toBe(75);
  });

  it("clamps to 0..100", () => {
    expect(completionPercent(progress({ totalItems: 2, outstandingRequiredItems: 9 }))).toBe(0);
  });
});

describe("input schemas", () => {
  it("a plan requires a job, a title and a work package", () => {
    expect(createPlanSchema.safeParse({ title: "T", workPackage: "WP", jobId: JOB }).success).toBe(true);
    expect(createPlanSchema.safeParse({ title: "T", workPackage: "WP" }).success).toBe(false);
    expect(createPlanSchema.safeParse({ title: "", workPackage: "WP", jobId: JOB }).success).toBe(false);
    expect(createPlanSchema.safeParse({ title: "T", workPackage: " ", jobId: JOB }).success).toBe(false);
  });

  it("an item requires acceptance criteria and a valid control point", () => {
    const ok = planItemSchema.safeParse({
      planId: JOB,
      itemNumber: 1,
      title: "Rebar",
      acceptanceCriteria: "To S-204",
      controlPoint: "witness",
    });
    expect(ok.success).toBe(true);
    expect(
      planItemSchema.safeParse({
        planId: JOB,
        itemNumber: 1,
        title: "Rebar",
        acceptanceCriteria: "",
        controlPoint: "inspect",
      }).success,
    ).toBe(false);
    expect(
      planItemSchema.safeParse({
        planId: JOB,
        itemNumber: 1,
        title: "Rebar",
        acceptanceCriteria: "x",
        controlPoint: "hold",
      }).success,
    ).toBe(false);
  });

  it("item numbers start at 1 and are integers", () => {
    const bad = (n: unknown) =>
      planItemSchema.safeParse({
        planId: JOB,
        itemNumber: n,
        title: "t",
        acceptanceCriteria: "a",
        controlPoint: "inspect",
      }).success;
    expect(bad(0)).toBe(false);
    expect(bad(1.5)).toBe(false);
    expect(bad(-3)).toBe(false);
    expect(bad(1)).toBe(true);
  });

  it("a fail must carry a comment (mirrors the DB CHECK)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const base = { itemId: UID, planId: JOB, signedName: "A Person", inspectedAt: today };
    expect(signoffSchema.safeParse({ ...base, result: "pass" }).success).toBe(true);
    expect(signoffSchema.safeParse({ ...base, result: "fail" }).success).toBe(false);
    expect(signoffSchema.safeParse({ ...base, result: "fail", comments: "Falls too shallow" }).success).toBe(true);
    expect(signoffSchema.safeParse({ ...base, result: "pass_with_comment", comments: "  " }).success).toBe(false);
  });

  it("refuses a future inspection date (mirrors tg_signoff_validate)", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = signoffSchema.safeParse({
      itemId: UID,
      planId: JOB,
      result: "pass",
      signedName: "A Person",
      inspectedAt: tomorrow,
    });
    expect(r.success).toBe(false);
  });

  it("a signature needs a name", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(
      signoffSchema.safeParse({ itemId: UID, planId: JOB, result: "pass", signedName: " ", inspectedAt: today })
        .success,
    ).toBe(false);
  });

  it("voiding requires a reason — an unexplained retraction is not an audit trail", () => {
    expect(voidSignoffSchema.safeParse({ id: UID, planId: JOB, voidReason: "Wrong item" }).success).toBe(true);
    expect(voidSignoffSchema.safeParse({ id: UID, planId: JOB, voidReason: "" }).success).toBe(false);
    expect(voidSignoffSchema.safeParse({ id: UID, planId: JOB }).success).toBe(false);
  });

  it("orNull collapses blank text to null", () => {
    expect(orNull("")).toBeNull();
    expect(orNull("   ")).toBeNull();
    expect(orNull(undefined)).toBeNull();
    expect(orNull(" x ")).toBe("x");
  });
});
