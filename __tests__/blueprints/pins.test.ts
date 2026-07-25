import { describe, it, expect } from "vitest";
import {
  pointerToNormalized,
  normalizedToPercent,
  isTap,
  toStoredPage,
  pinsForSheet,
  pinDisplayStatus,
  pinShortLabel,
  filterPins,
  createNotePinSchema,
  createSnagPinSchema,
  linkSnagPinSchema,
  movePinSchema,
  type BlueprintPin,
} from "@/lib/blueprints/pins";

const rect = { left: 100, top: 50, width: 200, height: 400 };

const pin = (over: Partial<BlueprintPin>): BlueprintPin => ({
  id: "11111111-1111-1111-1111-111111111111",
  blueprint_version_id: "22222222-2222-2222-2222-222222222222",
  page_number: 1,
  u: 0.5,
  v: 0.5,
  kind: "note",
  title: null,
  note: "hi",
  snag_id: null,
  created_at: "2026-07-22T00:00:00Z",
  ...over,
});

describe("pointerToNormalized — DOM page-box model", () => {
  it("maps a click at the box centre to (0.5, 0.5)", () => {
    expect(pointerToNormalized(200, 250, rect)).toEqual({ u: 0.5, v: 0.5 });
  });
  it("maps the top-left corner to (0,0) and bottom-right to (1,1)", () => {
    expect(pointerToNormalized(100, 50, rect)).toEqual({ u: 0, v: 0 });
    expect(pointerToNormalized(300, 450, rect)).toEqual({ u: 1, v: 1 });
  });
  it("clamps clicks outside the box into [0,1] (letterbox margin taps)", () => {
    expect(pointerToNormalized(0, 0, rect)).toEqual({ u: 0, v: 0 });
    expect(pointerToNormalized(9999, 9999, rect)).toEqual({ u: 1, v: 1 });
  });
  it("returns (0,0) for a degenerate zero-size box (not NaN)", () => {
    expect(pointerToNormalized(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ u: 0, v: 0 });
  });
});

describe("normalizedToPercent — render anchor", () => {
  it("converts to CSS percentages", () => {
    expect(normalizedToPercent({ u: 0.25, v: 0.75 })).toEqual({ left: "25%", top: "75%" });
  });
  it("clamps before formatting", () => {
    expect(normalizedToPercent({ u: -1, v: 2 })).toEqual({ left: "0%", top: "100%" });
  });
});

describe("isTap — place vs pan", () => {
  it("treats a near-stationary gesture as a tap", () => {
    expect(isTap(100, 100, 103, 102, 6)).toBe(true);
  });
  it("treats a dragged gesture as not-a-tap", () => {
    expect(isTap(100, 100, 130, 100, 6)).toBe(false);
  });
});

describe("page-number convention (0-based viewer ↔ 1-based storage)", () => {
  it("shifts a 0-based sheet index to 1-based storage", () => {
    expect(toStoredPage(0)).toBe(1);
    expect(toStoredPage(4)).toBe(5);
  });
  it("never yields < 1 even for odd input", () => {
    expect(toStoredPage(-3)).toBe(1);
  });
  it("pinsForSheet selects the pins on the shown sheet", () => {
    const pins = [pin({ id: "a", page_number: 1 }), pin({ id: "b", page_number: 2 }), pin({ id: "c", page_number: 1 })];
    expect(pinsForSheet(pins, 0).map((p) => p.id)).toEqual(["a", "c"]);
    expect(pinsForSheet(pins, 1).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("pinDisplayStatus — derived, snag is authority", () => {
  it("a note pin is always 'Note'", () => {
    expect(pinDisplayStatus({ kind: "note", snag_status: null })).toEqual({ label: "Note", tone: "note" });
  });
  it("a snag pin mirrors the snag's status", () => {
    expect(pinDisplayStatus({ kind: "snag", snag_status: "open" }).tone).toBe("open");
    expect(pinDisplayStatus({ kind: "snag", snag_status: "in_progress" }).tone).toBe("progress");
    expect(pinDisplayStatus({ kind: "snag", snag_status: "verified" }).tone).toBe("resolved");
    expect(pinDisplayStatus({ kind: "snag", snag_status: "wont_fix" }).tone).toBe("muted");
  });
  it("a snag pin with an unresolved join falls back to a muted 'Snag'", () => {
    expect(pinDisplayStatus({ kind: "snag", snag_status: null })).toEqual({ label: "Snag", tone: "muted" });
  });
});

describe("pinShortLabel", () => {
  it("prefers the explicit title", () => {
    expect(pinShortLabel(pin({ title: "Beam here", note: "x" }))).toBe("Beam here");
  });
  it("falls back to the snag title, then note text", () => {
    expect(pinShortLabel(pin({ kind: "snag", title: null, snag_title: "Cracked render", note: null }))).toBe("Cracked render");
    expect(pinShortLabel(pin({ kind: "note", title: null, note: "check level" }))).toBe("check level");
  });
});

describe("filterPins — local bounded filtering", () => {
  const pins = [
    pin({ id: "n", kind: "note", note: "x" }),
    pin({ id: "s1", kind: "snag", note: null, snag_id: "x", snag_status: "open" }),
    pin({ id: "s2", kind: "snag", note: null, snag_id: "y", snag_status: "verified" }),
  ];
  it("filters by kind", () => {
    expect(filterPins(pins, { kind: "snag", status: "all" }).map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(filterPins(pins, { kind: "note", status: "all" }).map((p) => p.id)).toEqual(["n"]);
  });
  it("open vs resolved considers only snags", () => {
    expect(filterPins(pins, { kind: "all", status: "open" }).map((p) => p.id)).toEqual(["s1"]);
    expect(filterPins(pins, { kind: "all", status: "resolved" }).map((p) => p.id)).toEqual(["s2"]);
  });
});

describe("input schemas", () => {
  const base = { blueprint_version_id: "22222222-2222-2222-2222-222222222222", page_number: 1, u: 0.5, v: 0.5 };
  it("createNotePin requires note text and in-range coords", () => {
    expect(createNotePinSchema.safeParse({ ...base, note: "hello" }).success).toBe(true);
    expect(createNotePinSchema.safeParse({ ...base, note: "" }).success).toBe(false);
    expect(createNotePinSchema.safeParse({ ...base, u: 1.2, note: "x" }).success).toBe(false);
  });
  it("createSnagPin requires a snag title and defaults priority to medium", () => {
    const ok = createSnagPinSchema.safeParse({ ...base, snag_title: "Cracked render" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.snag_priority).toBe("medium");
    expect(createSnagPinSchema.safeParse({ ...base, snag_title: "" }).success).toBe(false);
  });
  it("linkSnagPin requires a snag uuid", () => {
    expect(linkSnagPinSchema.safeParse({ ...base, snag_id: "22222222-2222-2222-2222-222222222222" }).success).toBe(true);
    expect(linkSnagPinSchema.safeParse({ ...base, snag_id: "not-a-uuid" }).success).toBe(false);
  });
  it("movePin requires id + coords", () => {
    expect(movePinSchema.safeParse({ id: "22222222-2222-2222-2222-222222222222", u: 0.1, v: 0.9 }).success).toBe(true);
    expect(movePinSchema.safeParse({ id: "22222222-2222-2222-2222-222222222222", u: 2, v: 0 }).success).toBe(false);
  });
});
