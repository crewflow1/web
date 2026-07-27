import { describe, expect, it } from "vitest";
import { createToolboxTalkSchema } from "@/lib/toolbox-talks/schema";

describe("createToolboxTalkSchema", () => {
  it("accepts a minimal talk (date + topic)", () => {
    const parsed = createToolboxTalkSchema.parse({
      talk_date: "2026-07-18",
      topic: "Working at height",
    });
    expect(parsed.topic).toBe("Working at height");
    expect(parsed.presenter).toBeUndefined();
    expect(parsed.attendee_count).toBeUndefined();
  });

  it("requires a topic", () => {
    expect(
      createToolboxTalkSchema.safeParse({ talk_date: "2026-07-18", topic: "  " })
        .success,
    ).toBe(false);
  });

  it("requires a valid talk_date", () => {
    expect(
      createToolboxTalkSchema.safeParse({ topic: "x" }).success,
    ).toBe(false);
    expect(
      createToolboxTalkSchema.safeParse({ talk_date: "18/07/2026", topic: "x" })
        .success,
    ).toBe(false);
  });

  it("coerces empty optionals to undefined (no empty writes)", () => {
    const parsed = createToolboxTalkSchema.parse({
      talk_date: "2026-07-18",
      topic: "Manual handling",
      job_id: "",
      presenter: "",
      attendees: "",
      attendee_count: "",
      notes: "",
    });
    expect(parsed.job_id).toBeUndefined();
    expect(parsed.presenter).toBeUndefined();
    expect(parsed.attendees).toBeUndefined();
    expect(parsed.attendee_count).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it("coerces attendee_count and rejects a negative or non-numeric one", () => {
    expect(
      createToolboxTalkSchema.parse({
        talk_date: "2026-07-18",
        topic: "x",
        attendee_count: "6",
      }).attendee_count,
    ).toBe(6);
    expect(
      createToolboxTalkSchema.safeParse({
        talk_date: "2026-07-18",
        topic: "x",
        attendee_count: "-2",
      }).success,
    ).toBe(false);
    expect(
      createToolboxTalkSchema.safeParse({
        talk_date: "2026-07-18",
        topic: "x",
        attendee_count: "lots",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid job reference", () => {
    expect(
      createToolboxTalkSchema.safeParse({
        talk_date: "2026-07-18",
        topic: "x",
        job_id: "nope",
      }).success,
    ).toBe(false);
  });
});
