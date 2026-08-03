import { describe, it, expect } from "vitest";
import { bucketPipelineLeads, type RawPipelineLead } from "@/app/(app)/leads/pipeline";
import { LEAD_STAGES } from "@/lib/leads/schema";

/**
 * Pipeline exclusion contract — C28 archived-leads-leak bugfix.
 *
 * Regression pin for the gap where the bucketing loop coerced ANY status not
 * in LEAD_STAGES (notably `archived`, set by the Archive action) into the New
 * column, and — worse — accumulated its estimated_value into the headline
 * forecast BEFORE the enum check ever ran. Archived/terminal leads must:
 *   (a) appear in NO pipeline column,
 *   (b) be excluded from totalValue,
 *   (c) never be coerced to `new` (true for any unknown status, not just archived).
 *
 * Hermetic: exercises the pure aggregator directly — no Supabase client.
 */

function lead(overrides: Partial<RawPipelineLead> & { id: string }): RawPipelineLead {
  return {
    status: "new",
    source: "phone",
    urgency: null,
    postcode: null,
    service: null,
    estimated_value: null,
    last_activity_at: "2026-08-01T00:00:00.000Z",
    customer: null,
    assigned: null,
    ...overrides,
  };
}

function allCards(byStage: ReturnType<typeof bucketPipelineLeads>["byStage"]) {
  return LEAD_STAGES.flatMap((s) => byStage[s]);
}

describe("bucketPipelineLeads", () => {
  it("buckets a known-stage lead and counts its value", () => {
    const { byStage, totalValue } = bucketPipelineLeads([
      lead({ id: "a", status: "quoted", estimated_value: 1200 }),
    ]);
    expect(byStage.quoted.map((c) => c.id)).toEqual(["a"]);
    expect(totalValue).toBe(1200);
  });

  it("(a) excludes an archived lead from every pipeline column", () => {
    const { byStage } = bucketPipelineLeads([
      lead({ id: "live", status: "new" }),
      lead({ id: "archived", status: "archived", estimated_value: 5000 }),
    ]);
    const ids = allCards(byStage).map((c) => c.id);
    expect(ids).toContain("live");
    expect(ids).not.toContain("archived");
    // Specifically must NOT be coerced into the New column (the old bug).
    expect(byStage.new.map((c) => c.id)).toEqual(["live"]);
  });

  it("(b) excludes an archived lead's value from totalValue", () => {
    const { totalValue } = bucketPipelineLeads([
      lead({ id: "live", status: "won", estimated_value: 800 }),
      lead({ id: "archived", status: "archived", estimated_value: 5000 }),
    ]);
    expect(totalValue).toBe(800);
  });

  it("(c) skips an arbitrary unknown status (not coerced to new, not counted)", () => {
    const { byStage, totalValue } = bucketPipelineLeads([
      lead({ id: "weird", status: "on_hold_legacy_2019", estimated_value: 999 }),
    ]);
    expect(allCards(byStage)).toHaveLength(0);
    expect(byStage.new).toHaveLength(0);
    expect(totalValue).toBe(0);
  });

  it("counts only recognised stages when statuses are mixed", () => {
    const { byStage, totalValue } = bucketPipelineLeads([
      lead({ id: "n", status: "new", estimated_value: 100 }),
      lead({ id: "c", status: "contacted", estimated_value: 200 }),
      lead({ id: "arch", status: "archived", estimated_value: 9999 }),
      lead({ id: "junk", status: "", estimated_value: 9999 }),
    ]);
    expect(totalValue).toBe(300);
    expect(allCards(byStage).map((c) => c.id).sort()).toEqual(["c", "n"]);
  });
});
