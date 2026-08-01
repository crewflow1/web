import { describe, expect, it } from "vitest";
import {
  DELAY_CATEGORIES,
  DELAY_CATEGORY_DESCRIPTIONS,
  DELAY_CATEGORY_LABELS,
  DELAY_STATUSES,
  DELAY_STATUS_LABELS,
  canTransition,
  isDelayCategory,
  isDeletable,
  isEditable,
  openCompletions,
  recordGate,
  type DelayEventStatus,
} from "@/lib/eot/lifecycle";

/**
 * The lifecycle domain mirrors tg_delay_event_transition (20261084). The DB
 * is the authority; this suite proves the FRIENDLY mirror agrees with the
 * graph the migration enforces, edge by edge — including the edges that must
 * NOT exist.
 */

const TODAY = "2026-08-01";

describe("eot lifecycle · the graph", () => {
  it("permits exactly two edges: draft→recorded and recorded→withdrawn", () => {
    const legal: Array<[DelayEventStatus, DelayEventStatus]> = [];
    for (const from of DELAY_STATUSES) {
      for (const to of DELAY_STATUSES) {
        if (canTransition(from, to)) legal.push([from, to]);
      }
    }
    expect(legal).toEqual([
      ["draft", "recorded"],
      ["recorded", "withdrawn"],
    ]);
  });

  it("refuses draft→withdrawn — a terminal row must never skip the recording gate", () => {
    expect(canTransition("draft", "withdrawn")).toBe(false);
  });

  it("refuses every route back: recorded→draft, withdrawn→anything, self-loops", () => {
    expect(canTransition("recorded", "draft")).toBe(false);
    expect(canTransition("withdrawn", "draft")).toBe(false);
    expect(canTransition("withdrawn", "recorded")).toBe(false);
    for (const s of DELAY_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("only drafts are editable and deletable", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("recorded")).toBe(false);
    expect(isEditable("withdrawn")).toBe(false);
    expect(isDeletable("draft")).toBe(true);
    expect(isDeletable("recorded")).toBe(false);
    expect(isDeletable("withdrawn")).toBe(false);
  });
});

describe("eot lifecycle · categories", () => {
  it("every category has a label and a description (the picker cannot render a blank)", () => {
    for (const c of DELAY_CATEGORIES) {
      expect(DELAY_CATEGORY_LABELS[c]).toBeTruthy();
      expect(DELAY_CATEGORY_DESCRIPTIONS[c]).toBeTruthy();
    }
  });

  it("isDelayCategory accepts exactly the canonical list", () => {
    for (const c of DELAY_CATEGORIES) expect(isDelayCategory(c)).toBe(true);
    expect(isDelayCategory("force_majeure")).toBe(false);
    expect(isDelayCategory("")).toBe(false);
    expect(isDelayCategory(null)).toBe(false);
    expect(isDelayCategory(42)).toBe(false);
  });
});

describe("eot lifecycle · recordGate", () => {
  const base = {
    status: "draft" as DelayEventStatus,
    category: "weather",
    startedOn: "2026-07-20",
    endedOn: "2026-07-22",
    workingDaysLost: 2,
    description: "Storm — site stood down",
  };

  it("passes a complete, honest draft", () => {
    expect(recordGate(base, TODAY)).toEqual({ ok: true, reasons: [] });
  });

  it("an ONGOING delay is recordable (contemporaneous recording beats completeness)", () => {
    expect(recordGate({ ...base, endedOn: null }, TODAY).ok).toBe(true);
  });

  it("an UNQUANTIFIED delay is recordable (the pack surfaces the gap instead)", () => {
    expect(recordGate({ ...base, workingDaysLost: null }, TODAY).ok).toBe(true);
  });

  it("refuses a non-draft", () => {
    const r = recordGate({ ...base, status: "recorded" }, TODAY);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/draft/i);
  });

  it("refuses an empty description — the description IS the record", () => {
    expect(recordGate({ ...base, description: "   " }, TODAY).ok).toBe(false);
  });

  it("refuses a future start and a future end (the DB guard's rule)", () => {
    expect(recordGate({ ...base, startedOn: "2026-08-02", endedOn: null }, TODAY).ok).toBe(false);
    expect(recordGate({ ...base, endedOn: "2026-08-02" }, TODAY).ok).toBe(false);
    // Today itself is fine — the boundary is strictly-after.
    expect(recordGate({ ...base, startedOn: TODAY, endedOn: TODAY }, TODAY).ok).toBe(true);
  });

  it("refuses end before start, an unknown category, and a negative/fractional claim", () => {
    expect(recordGate({ ...base, endedOn: "2026-07-19" }, TODAY).ok).toBe(false);
    expect(recordGate({ ...base, category: "acts_of_god" }, TODAY).ok).toBe(false);
    expect(recordGate({ ...base, workingDaysLost: -1 }, TODAY).ok).toBe(false);
    expect(recordGate({ ...base, workingDaysLost: 1.5 }, TODAY).ok).toBe(false);
    // Zero is a legitimate claim, distinct from "not quantified".
    expect(recordGate({ ...base, workingDaysLost: 0 }, TODAY).ok).toBe(true);
  });

  it("collects EVERY refusal, not just the first", () => {
    const r = recordGate(
      {
        status: "recorded",
        category: "nope",
        startedOn: "",
        endedOn: null,
        workingDaysLost: -3,
        description: "",
      },
      TODAY,
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("eot lifecycle · openCompletions (write-once seam)", () => {
  it("only a RECORDED event has open completions", () => {
    expect(openCompletions({ status: "draft", endedOn: null, workingDaysLost: null })).toEqual({
      endedOn: false,
      workingDaysLost: false,
    });
    expect(
      openCompletions({ status: "withdrawn", endedOn: null, workingDaysLost: null }),
    ).toEqual({ endedOn: false, workingDaysLost: false });
  });

  it("reports exactly the NULL fields as open", () => {
    expect(
      openCompletions({ status: "recorded", endedOn: null, workingDaysLost: 4 }),
    ).toEqual({ endedOn: true, workingDaysLost: false });
    expect(
      openCompletions({ status: "recorded", endedOn: "2026-07-22", workingDaysLost: null }),
    ).toEqual({ endedOn: false, workingDaysLost: true });
    expect(
      openCompletions({ status: "recorded", endedOn: "2026-07-22", workingDaysLost: 0 }),
    ).toEqual({ endedOn: false, workingDaysLost: false });
  });

  it("labels exist for every status (badges are never colour-only)", () => {
    for (const s of DELAY_STATUSES) expect(DELAY_STATUS_LABELS[s]).toBeTruthy();
  });
});
