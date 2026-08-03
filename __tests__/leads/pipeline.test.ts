import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  /**
   * F-1: the page fed the kanban + forecast from a `.limit(500)` read, so a
   * busy pipeline was silently truncated and totalValue under-reported. The
   * fix pages every non-archived lead in; the bucketing must scale to it while
   * still excluding archived leads from BOTH the columns and the forecast.
   */
  it("buckets far more than 500 non-archived leads and counts every one in totalValue", () => {
    const N = 1500; // past the old .limit(500) cap and the 1000-row PostgREST cap
    const live: RawPipelineLead[] = Array.from({ length: N }, (_, i) =>
      lead({
        id: `live-${String(i).padStart(6, "0")}`,
        status: LEAD_STAGES[i % LEAD_STAGES.length]!,
        estimated_value: 10,
      }),
    );
    // Archived leads mixed throughout must never leak into a column or the total.
    const archived: RawPipelineLead[] = Array.from({ length: 40 }, (_, i) =>
      lead({ id: `arch-${i}`, status: "archived", estimated_value: 9999 }),
    );

    const { byStage, totalValue } = bucketPipelineLeads([...live, ...archived]);

    expect(allCards(byStage)).toHaveLength(N);
    expect(totalValue).toBe(N * 10);
    const ids = new Set(allCards(byStage).map((c) => c.id));
    expect(ids.has(`live-${String(N - 1).padStart(6, "0")}`)).toBe(true);
    expect([...ids].some((id) => id.startsWith("arch-"))).toBe(false);
  });
});

describe("leads/page.tsx wiring — pipeline read is paged, not capped (F-1)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../app/(app)/leads/page.tsx"),
    "utf8",
  );

  it("pages the whole pipeline via fetchAllRows and drops the .limit(500) cap", () => {
    expect(src).toContain("fetchAllRows");
    expect(src).toMatch(/fetchAllRows\(\(from, to\) =>\s*\n?\s*query\.range\(from, to\)/);
    expect(src).not.toContain(".limit(500)");
  });

  it("keeps the C28 archived-lead exclusion + org scoping intact", () => {
    expect(src).toMatch(/\.neq\("status", "archived"\)/);
    expect(src).toMatch(/\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("uses a stable id secondary sort so paging can't skip/duplicate rows", () => {
    expect(src).toMatch(/\.order\("id", \{ ascending: true \}\)/);
  });
});
