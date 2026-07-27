import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  createInspectionSchema,
  isEditable,
  isIssued,
  isSafetyBlocking,
  isTerminal,
  issueInspectionSchema,
  issueRequiresOutcome,
  materializeInspectionSnapshot,
} from "@/lib/assets/inspection";

describe("inspection state machine", () => {
  it("permits only the legal transitions", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("draft", "archived")).toBe(true);
    expect(canTransition("issued", "superseded")).toBe(true);
    expect(canTransition("issued", "archived")).toBe(true);
    expect(canTransition("superseded", "archived")).toBe(true);
  });

  it("forbids illegal / backwards transitions", () => {
    expect(canTransition("draft", "superseded")).toBe(false); // must issue first
    expect(canTransition("issued", "draft")).toBe(false); // no un-issue
    expect(canTransition("archived", "draft")).toBe(false); // terminal
    expect(canTransition("superseded", "issued")).toBe(false);
  });

  it("assertTransition throws a stable, parseable error", () => {
    expect(() => assertTransition("draft", "issued")).not.toThrow();
    expect(() => assertTransition("issued", "draft")).toThrow("invalid_transition:issued->draft");
  });

  it("classifies editability / issued / terminal", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("issued")).toBe(false);
    expect(isIssued("issued")).toBe(true);
    expect(isTerminal("superseded")).toBe(true);
    expect(isTerminal("archived")).toBe(true);
    expect(isTerminal("draft")).toBe(false);
  });
});

describe("isSafetyBlocking — the predicate the DB guard mirrors", () => {
  const base = { safety_critical: true, status: "issued" as const, outcome: "fail" as const };

  it("blocks only a CURRENT issued safety-critical FAIL", () => {
    expect(isSafetyBlocking(base)).toBe(true);
  });

  it("does not block when any condition is absent", () => {
    expect(isSafetyBlocking({ ...base, safety_critical: false })).toBe(false); // not safety-critical
    expect(isSafetyBlocking({ ...base, outcome: "pass" })).toBe(false); // passed
    expect(isSafetyBlocking({ ...base, outcome: "pass_with_defects" })).toBe(false);
    expect(isSafetyBlocking({ ...base, outcome: null })).toBe(false); // draft, no outcome
    expect(isSafetyBlocking({ ...base, status: "draft" })).toBe(false); // not issued yet
    expect(isSafetyBlocking({ ...base, status: "superseded" })).toBe(false); // re-inspected
    expect(isSafetyBlocking({ ...base, status: "archived" })).toBe(false);
  });
});

describe("issueRequiresOutcome", () => {
  it("is a type guard that rejects null/undefined/bogus", () => {
    expect(issueRequiresOutcome("pass")).toBe(true);
    expect(issueRequiresOutcome("fail")).toBe(true);
    expect(issueRequiresOutcome(null)).toBe(false);
    expect(issueRequiresOutcome(undefined)).toBe(false);
    expect(issueRequiresOutcome("bogus" as never)).toBe(false);
  });
});

describe("createInspectionSchema", () => {
  const assetId = "11111111-1111-1111-1111-111111111111";

  it("accepts a minimal valid draft and defaults safety_critical to false", () => {
    const parsed = createInspectionSchema.parse({ asset_id: assetId, title: "Pre-use check" });
    expect(parsed.title).toBe("Pre-use check");
    expect(parsed.safety_critical).toBe(false);
    expect(parsed.kind).toBeUndefined();
  });

  it("coerces safety_critical and blanks to undefined", () => {
    const parsed = createInspectionSchema.parse({
      asset_id: assetId,
      title: "  LOLER thorough exam  ",
      kind: "loler",
      safety_critical: "on",
      notes: "   ",
    });
    expect(parsed.title).toBe("LOLER thorough exam"); // trimmed
    expect(parsed.safety_critical).toBe(true);
    expect(parsed.kind).toBe("loler");
    expect(parsed.notes).toBeUndefined(); // blank → undefined
  });

  it("rejects an empty title and a bad kind", () => {
    expect(createInspectionSchema.safeParse({ asset_id: assetId, title: "" }).success).toBe(false);
    expect(
      createInspectionSchema.safeParse({ asset_id: assetId, title: "x", kind: "nope" }).success,
    ).toBe(false);
    expect(createInspectionSchema.safeParse({ asset_id: "not-a-uuid", title: "x" }).success).toBe(false);
  });
});

describe("issueInspectionSchema", () => {
  it("requires a valid outcome", () => {
    expect(issueInspectionSchema.parse({ outcome: "pass" }).outcome).toBe("pass");
    expect(issueInspectionSchema.safeParse({ outcome: "maybe" }).success).toBe(false);
    expect(issueInspectionSchema.safeParse({}).success).toBe(false);
  });
});

describe("materializeInspectionSnapshot", () => {
  it("freezes the record deterministically from the passed issuedAt (no clock)", () => {
    const snap = materializeInspectionSnapshot({
      title: "LOLER",
      kind: "loler",
      safety_critical: true,
      outcome: "fail",
      content: { q1: "no", note: "chain worn" },
      asset: { id: "a1", name: "Telehandler", asset_ref: "FLEET-3" },
      inspected_at: "2026-07-19T09:00:00.000Z",
      issuedAt: "2026-07-19T10:00:00.000Z",
    });
    expect(snap.issued_at).toBe("2026-07-19T10:00:00.000Z");
    expect(snap.outcome).toBe("fail");
    expect(snap.safety_critical).toBe(true);
    expect(snap.asset.asset_ref).toBe("FLEET-3");
    expect(snap.content).toEqual({ q1: "no", note: "chain worn" });
  });
});
