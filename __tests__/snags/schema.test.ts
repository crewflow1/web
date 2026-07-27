import { describe, expect, it } from "vitest";
import {
  createSnagSchema,
  isTerminalStatus,
  resolvedAtForTransition,
  SNAG_PRIORITIES,
  SNAG_PRIORITY_LABELS,
  SNAG_STATUS_LABELS,
  SNAG_STATUSES,
  type SnagStatus,
} from "@/lib/snags/schema";

describe("snag status constants", () => {
  it("every status and priority has a human label", () => {
    for (const s of SNAG_STATUSES) {
      expect(SNAG_STATUS_LABELS[s], `label for ${s}`).toBeTruthy();
    }
    for (const p of SNAG_PRIORITIES) {
      expect(SNAG_PRIORITY_LABELS[p], `label for ${p}`).toBeTruthy();
    }
  });

  it("only verified + wont_fix are terminal", () => {
    const terminal = SNAG_STATUSES.filter((s) => isTerminalStatus(s));
    expect(terminal).toEqual(["verified", "wont_fix"]);
  });
});

describe("resolvedAtForTransition", () => {
  const now = new Date("2026-07-18T09:00:00.000Z");

  it("stamps now when first entering a terminal status", () => {
    expect(resolvedAtForTransition("fixed", "verified", now)).toEqual(now);
    expect(resolvedAtForTransition("open", "wont_fix", now)).toEqual(now);
  });

  it("clears to null when reopening from a terminal status", () => {
    expect(resolvedAtForTransition("verified", "open", now)).toBeNull();
    expect(resolvedAtForTransition("wont_fix", "in_progress", now)).toBeNull();
  });

  it("leaves resolved_at untouched for non-terminal transitions", () => {
    expect(resolvedAtForTransition("open", "in_progress", now)).toBeUndefined();
    expect(resolvedAtForTransition("in_progress", "fixed", now)).toBeUndefined();
  });

  it("leaves resolved_at untouched moving between two terminal statuses", () => {
    expect(resolvedAtForTransition("verified", "wont_fix", now)).toBeUndefined();
  });

  it("covers every status pairing without throwing", () => {
    for (const from of SNAG_STATUSES) {
      for (const to of SNAG_STATUSES) {
        expect(() =>
          resolvedAtForTransition(from as SnagStatus, to as SnagStatus, now),
        ).not.toThrow();
      }
    }
  });
});

describe("createSnagSchema", () => {
  it("accepts a minimal snag (title only) and defaults priority to medium", () => {
    const parsed = createSnagSchema.parse({ title: "Cracked tile in ensuite" });
    expect(parsed.title).toBe("Cracked tile in ensuite");
    expect(parsed.priority).toBe("medium");
    expect(parsed.description).toBeUndefined();
    expect(parsed.job_id).toBeUndefined();
  });

  it("rejects an empty title", () => {
    const r = createSnagSchema.safeParse({ title: "   " });
    expect(r.success).toBe(false);
  });

  it("coerces empty optional strings to undefined (no empty writes)", () => {
    const parsed = createSnagSchema.parse({
      title: "Missing seal",
      description: "",
      location: "",
      trade: "",
      job_id: "",
      assigned_to: "",
      due_date: "",
    });
    expect(parsed.description).toBeUndefined();
    expect(parsed.location).toBeUndefined();
    expect(parsed.trade).toBeUndefined();
    expect(parsed.job_id).toBeUndefined();
    expect(parsed.assigned_to).toBeUndefined();
    expect(parsed.due_date).toBeUndefined();
  });

  it("rejects a non-uuid job reference", () => {
    const r = createSnagSchema.safeParse({ title: "x", job_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("rejects a malformed due date", () => {
    const r = createSnagSchema.safeParse({ title: "x", due_date: "18/07/2026" });
    expect(r.success).toBe(false);
  });

  it("accepts a well-formed due date and uuid refs", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const parsed = createSnagSchema.parse({
      title: "Paint scuff",
      priority: "high",
      job_id: uuid,
      assigned_to: uuid,
      due_date: "2026-08-01",
    });
    expect(parsed.priority).toBe("high");
    expect(parsed.job_id).toBe(uuid);
    expect(parsed.due_date).toBe("2026-08-01");
  });
});
