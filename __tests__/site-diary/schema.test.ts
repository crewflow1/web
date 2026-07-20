import { describe, expect, it } from "vitest";
import {
  createDiaryEntrySchema,
  formatDiaryDate,
} from "@/lib/site-diary/schema";

describe("formatDiaryDate", () => {
  it("formats a well-formed ISO date deterministically", () => {
    expect(formatDiaryDate("2026-07-18")).toBe("18 Jul 2026");
    expect(formatDiaryDate("2026-01-01")).toBe("1 Jan 2026");
    expect(formatDiaryDate("2026-12-31")).toBe("31 Dec 2026");
  });

  it("returns the input unchanged when it isn't an ISO date", () => {
    expect(formatDiaryDate("18/07/2026")).toBe("18/07/2026");
    expect(formatDiaryDate("")).toBe("");
    expect(formatDiaryDate("2026-13-40")).toBe("2026-13-40");
  });
});

describe("createDiaryEntrySchema", () => {
  it("accepts a minimal entry (date only)", () => {
    const parsed = createDiaryEntrySchema.parse({ entry_date: "2026-07-18" });
    expect(parsed.entry_date).toBe("2026-07-18");
    expect(parsed.job_id).toBeUndefined();
    expect(parsed.labour_count).toBeUndefined();
    expect(parsed.work_summary).toBeUndefined();
  });

  it("requires a valid entry_date", () => {
    expect(createDiaryEntrySchema.safeParse({}).success).toBe(false);
    expect(
      createDiaryEntrySchema.safeParse({ entry_date: "18-07-2026" }).success,
    ).toBe(false);
  });

  it("coerces empty optional strings to undefined (no empty writes)", () => {
    const parsed = createDiaryEntrySchema.parse({
      entry_date: "2026-07-18",
      job_id: "",
      weather: "",
      labour_count: "",
      work_summary: "",
      delays: "",
      notes: "",
    });
    expect(parsed.job_id).toBeUndefined();
    expect(parsed.weather).toBeUndefined();
    expect(parsed.labour_count).toBeUndefined();
    expect(parsed.work_summary).toBeUndefined();
    expect(parsed.delays).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it("coerces a numeric labour_count and rejects a negative or non-numeric one", () => {
    expect(
      createDiaryEntrySchema.parse({ entry_date: "2026-07-18", labour_count: "5" })
        .labour_count,
    ).toBe(5);
    expect(
      createDiaryEntrySchema.safeParse({
        entry_date: "2026-07-18",
        labour_count: "-1",
      }).success,
    ).toBe(false);
    expect(
      createDiaryEntrySchema.safeParse({
        entry_date: "2026-07-18",
        labour_count: "abc",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid job reference", () => {
    expect(
      createDiaryEntrySchema.safeParse({
        entry_date: "2026-07-18",
        job_id: "nope",
      }).success,
    ).toBe(false);
  });

  it("keeps a well-formed entry intact", () => {
    const uuid = "22222222-2222-2222-2222-222222222222";
    const parsed = createDiaryEntrySchema.parse({
      entry_date: "2026-07-18",
      job_id: uuid,
      weather: "Dry am, heavy rain pm",
      labour_count: "4",
      work_summary: "First fix plumbing complete on plots 3-5.",
      delays: "Concrete pour delayed by rain.",
      notes: "Building control visit booked Thursday.",
    });
    expect(parsed.job_id).toBe(uuid);
    expect(parsed.labour_count).toBe(4);
    expect(parsed.weather).toContain("rain");
  });
});
