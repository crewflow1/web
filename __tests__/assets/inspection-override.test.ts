import { describe, expect, it } from "vitest";
import {
  createOverrideSchema,
  currentSafetyBlocks,
  friendlyOverrideError,
  hasUnbypassedBlock,
  isOverrideActive,
  type BlockableInspection,
  type OverrideRow,
} from "@/lib/assets/inspection-override";

const NOW = "2026-07-20T12:00:00.000Z";

const insp = (over: Partial<BlockableInspection>): BlockableInspection => ({
  id: "i1",
  title: "Check",
  status: "issued",
  outcome: "fail",
  safety_critical: true,
  inspected_at: "2026-07-10T09:00:00.000Z",
  created_at: "2026-07-10T09:00:00.000Z",
  reinspection_of: null,
  ...over,
});

const override = (over: Partial<OverrideRow>): OverrideRow => ({
  id: "o1",
  inspection_id: "i1",
  reason: "Awaiting parts; restricted to yard moves only",
  expires_at: null,
  created_at: NOW,
  created_by: "u1",
  revoked_at: null,
  ...over,
});

describe("isOverrideActive", () => {
  it("live = un-revoked and un-expired at the passed clock", () => {
    expect(isOverrideActive(override({}), NOW)).toBe(true);
    expect(isOverrideActive(override({ revoked_at: NOW }), NOW)).toBe(false);
    expect(isOverrideActive(override({ expires_at: "2026-07-20T11:59:00.000Z" }), NOW)).toBe(false); // expired
    expect(isOverrideActive(override({ expires_at: "2026-07-21T00:00:00.000Z" }), NOW)).toBe(true); // future
  });
});

describe("currentSafetyBlocks — the guard's UI mirror", () => {
  const fail = insp({ id: "f1" });

  it("an uncleared issued safety-critical fail blocks", () => {
    const blocks = currentSafetyBlocks([fail], [], NOW);
    expect(blocks).toHaveLength(1);
    expect(hasUnbypassedBlock(blocks)).toBe(true);
  });

  it("arm 1: an EXPLICITLY LINKED issued pass clears — even backdated (arm 2 wouldn't)", () => {
    const backdatedLinkedPass = insp({
      id: "p1",
      outcome: "pass",
      reinspection_of: "f1",
      inspected_at: "2026-07-01T09:00:00.000Z", // BEFORE the fail
      created_at: "2026-07-01T09:00:00.000Z",
    });
    expect(currentSafetyBlocks([fail, backdatedLinkedPass], [], NOW)).toHaveLength(0);
  });

  it("arm 2 (M4c fallback): a LATER issued pass clears", () => {
    const laterPass = insp({ id: "p2", outcome: "pass_with_defects", inspected_at: "2026-07-15T09:00:00.000Z" });
    expect(currentSafetyBlocks([fail, laterPass], [], NOW)).toHaveLength(0);
  });

  it("lineage is scoped: a pass linked to F1 does not clear F2", () => {
    const f2 = insp({ id: "f2", inspected_at: "2026-07-16T09:00:00.000Z", created_at: "2026-07-16T09:00:00.000Z" });
    const linked = insp({
      id: "p3", outcome: "pass", reinspection_of: "f1",
      inspected_at: "2026-07-12T09:00:00.000Z", created_at: "2026-07-12T09:00:00.000Z",
    });
    const blocks = currentSafetyBlocks([fail, f2, linked], [], NOW);
    expect(blocks.map((b) => b.inspection.id)).toEqual(["f2"]);
  });

  it("arm 3: an ACTIVE override attaches but the block stays visible (honest display)", () => {
    const blocks = currentSafetyBlocks([fail], [override({ inspection_id: "f1" })], NOW);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.activeOverride).not.toBeNull();
    expect(hasUnbypassedBlock(blocks)).toBe(false); // bypassed, not cleared
  });

  it("an expired or revoked override no longer bypasses", () => {
    const expired = override({ inspection_id: "f1", expires_at: "2026-07-19T00:00:00.000Z" });
    expect(hasUnbypassedBlock(currentSafetyBlocks([fail], [expired], NOW))).toBe(true);
    const revoked = override({ inspection_id: "f1", revoked_at: NOW });
    expect(hasUnbypassedBlock(currentSafetyBlocks([fail], [revoked], NOW))).toBe(true);
  });
});

describe("createOverrideSchema", () => {
  const base = {
    asset_id: "11111111-1111-1111-1111-111111111111",
    inspection_id: "22222222-2222-2222-2222-222222222222",
  };
  it("requires a real (≥10 char) reason", () => {
    expect(createOverrideSchema.safeParse({ ...base, reason: "ok" }).success).toBe(false);
    expect(
      createOverrideSchema.safeParse({ ...base, reason: "Awaiting hydraulic hose; yard moves only" }).success,
    ).toBe(true);
  });
});

describe("friendlyOverrideError", () => {
  it("maps the DB violations to construction language", () => {
    expect(friendlyOverrideError("23505", "duplicate")).toMatch(/already has a live override/i);
    expect(friendlyOverrideError("23514", "override target x is not an issued safety-critical fail")).toMatch(
      /current failed safety inspection/i,
    );
    expect(friendlyOverrideError("23514", "override x is immutable except revocation")).toMatch(/revoke it/i);
    expect(friendlyOverrideError("XXXXX", "weird")).toMatch(/try again/i);
  });
});
