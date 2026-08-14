import { describe, it, expect } from "vitest";
import {
  fieldsEqual,
  normalizeField,
  threeWayMerge,
} from "@/lib/offline/merge";

/**
 * The three-way merge — the DETERMINISTIC, EXPLAINABLE conflict policy for a queued
 * offline UPDATE. It decides whose words survive when a foreman edited a record
 * with no signal and someone in the office edited the same record meanwhile, so
 * every branch of the policy is pinned here in isolation (no DB, no clock).
 */

const DIARY = [
  "entry_date",
  "job_id",
  "weather",
  "labour_count",
  "work_summary",
  "delays",
  "notes",
] as const;

describe("normalizeField / fieldsEqual — equality by meaning, not representation", () => {
  it("treats null, undefined and blank strings as the same absent state", () => {
    expect(normalizeField(null)).toBeNull();
    expect(normalizeField(undefined)).toBeNull();
    expect(normalizeField("")).toBeNull();
    expect(normalizeField("   ")).toBeNull();
    for (const [a, b] of [
      [null, undefined],
      [undefined, ""],
      ["", "   "],
      [null, "  "],
    ] as const) {
      expect(fieldsEqual(a, b), `${String(a)} == ${String(b)}`).toBe(true);
    }
  });

  it("trims strings before comparing but keeps real content distinct", () => {
    expect(fieldsEqual(" wet ", "wet")).toBe(true);
    expect(fieldsEqual("wet", "dry")).toBe(false);
  });

  it("0 is a real value, never 'absent'", () => {
    expect(normalizeField(0)).toBe(0);
    expect(fieldsEqual(0, null)).toBe(false);
    expect(fieldsEqual(0, "")).toBe(false);
    expect(fieldsEqual(0, 0)).toBe(true);
  });
});

describe("threeWayMerge — the four per-field cases", () => {
  it("case 1: a field only the SERVER changed is kept (I did not touch it)", () => {
    const base = { weather: "wet", notes: "am start" };
    const mine = { weather: "wet", notes: "am start" }; // I changed nothing
    const theirs = { weather: "dry", notes: "am start" }; // admin fixed weather
    const r = threeWayMerge(["weather", "notes"], base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.weather).toBe("dry"); // server's value survives
    expect(r.conflicts).toEqual([]);
  });

  it("case 2: an OWNED field (only I changed) wins — last-writer-wins", () => {
    const base = { weather: "wet", notes: "am start" };
    const mine = { weather: "wet", notes: "am start; rain pm" }; // I extended notes
    const theirs = { weather: "wet", notes: "am start" };
    const r = threeWayMerge(["weather", "notes"], base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.notes).toBe("am start; rain pm");
    expect(r.conflicts).toEqual([]);
  });

  it("case 3: both changed a field to the SAME value — convergent, no conflict", () => {
    const base = { weather: "wet" };
    const mine = { weather: "dry" };
    const theirs = { weather: "dry" };
    const r = threeWayMerge(["weather"], base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.weather).toBe("dry");
    expect(r.conflicts).toEqual([]);
  });

  it("case 4: both changed a field DIFFERENTLY — a surfaced conflict, nothing forced", () => {
    const base = { weather: "wet" };
    const mine = { weather: "dry am, rain pm" };
    const theirs = { weather: "overcast" };
    const r = threeWayMerge(["weather"], base, mine, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toEqual([
      { field: "weather", base: "wet", mine: "dry am, rain pm", theirs: "overcast" },
    ]);
    // default (not keep-mine): the merged value holds the SERVER's value, and the
    // caller declines to write because it is not clean.
    expect(r.merged.weather).toBe("overcast");
  });

  it("keep-mine forces the author's value on a divergent field and clears the clash", () => {
    const base = { weather: "wet" };
    const mine = { weather: "dry am, rain pm" };
    const theirs = { weather: "overcast" };
    const r = threeWayMerge(["weather"], base, mine, theirs, {
      preferMineOnConflict: true,
    });
    // A divergence DID occur (clean reflects the data, not the resolution), but the
    // author's value is forced and the clash is still reported for the audit trail.
    expect(r.clean).toBe(false);
    expect(r.merged.weather).toBe("dry am, rain pm");
    expect(r.conflicts).toHaveLength(1);
  });
});

describe("threeWayMerge — a realistic diary edit with two independent changes", () => {
  it("keeps the admin's field AND the foreman's field (no false conflict)", () => {
    const base = {
      entry_date: "2026-07-30",
      job_id: "11111111-1111-4111-8111-111111111111",
      weather: "wet",
      labour_count: 4,
      work_summary: "first fix",
      delays: null,
      notes: null,
    };
    // Foreman corrected the labour count offline.
    const mine = { ...base, labour_count: 6 };
    // Admin fixed a weather typo online, meanwhile.
    const theirs = { ...base, weather: "dry am, rain pm" };
    const r = threeWayMerge(DIARY, base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.labour_count).toBe(6); // foreman's owned change
    expect(r.merged.weather).toBe("dry am, rain pm"); // admin's owned change
    expect(r.conflicts).toEqual([]);
  });

  it("surfaces ONLY the field both edited, keeping the rest merged", () => {
    const base = { weather: "wet", labour_count: 4, notes: null };
    const mine = { weather: "dry", labour_count: 6, notes: null };
    const theirs = { weather: "overcast", labour_count: 4, notes: "visitor" };
    const r = threeWayMerge(
      ["weather", "labour_count", "notes"],
      base,
      mine,
      theirs,
    );
    expect(r.clean).toBe(false);
    expect(r.conflicts.map((c) => c.field)).toEqual(["weather"]);
    // the non-divergent fields still merge correctly around the conflict
    expect(r.merged.labour_count).toBe(6); // only I changed it
    expect(r.merged.notes).toBe("visitor"); // only they changed it
  });
});

describe("threeWayMerge — the field list is the boundary", () => {
  it("never merges a key outside the allowed field set", () => {
    const base = { title: "a" };
    const mine = { title: "b", status: "verified", org_id: "evil" };
    const theirs = { title: "a" };
    const r = threeWayMerge(["title"], base, mine, theirs);
    expect(Object.keys(r.merged)).toEqual(["title"]);
    expect(r.merged).not.toHaveProperty("status");
    expect(r.merged).not.toHaveProperty("org_id");
  });

  it("blank-vs-null does NOT read as a change (no phantom conflict)", () => {
    // A field the DB stores as null and the form rendered as "" must not conflict
    // just because the author never touched it.
    const base = { notes: null };
    const mine = { notes: "" };
    const theirs = { notes: "admin note" };
    const r = threeWayMerge(["notes"], base, mine, theirs);
    expect(r.clean).toBe(true);
    expect(r.merged.notes).toBe("admin note"); // I didn't touch it → keep theirs
  });
});
