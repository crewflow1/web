import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  summariseDesignReview,
  type DesignReviewEmployeeRow,
} from "@/lib/hq/roster-workers";

/**
 * HQ Design AI — the P8 design_review contract (L9a).
 *
 * The deterministic review over the design data the platform ACTUALLY stores
 * (roster brand tokens): accent token-format coherence, per-department accent
 * collisions, estate-wide icon reuse. Plus the envelope invariants every
 * roster worker carries, the null-by-construction generative leg, and the
 * handler's dark-seam wiring (seam spied).
 */

const NOW = new Date("2026-08-26T12:00:00Z");

const row = (
  slug: string,
  icon: string | null,
  accent: string | null,
  department: string | null = "engineering",
): DesignReviewEmployeeRow => ({ slug, icon, accent, department });

describe("summariseDesignReview — deterministic findings over real roster tokens", () => {
  it("a coherent roster is a genuine all-clear (ok over real data, not insufficient)", () => {
    const r = summariseDesignReview(
      [row("a-ai", "Bot", "#112233"), row("b-ai", "Brain", "#445566", "sales")],
      NOW,
    );
    expect(r.insufficient).toBe(false);
    expect(r.severity).toBe("ok");
    expect(r.confidence).toBe(1);
    expect(r.signals.mixedAccentFormats).toBe(false);
    expect(r.signals.findings).toEqual([]);
  });

  it("flags mixed accent format families (hex vs named)", () => {
    const r = summariseDesignReview(
      [row("a-ai", "Bot", "#112233"), row("b-ai", "Brain", "teal", "sales")],
      NOW,
    );
    expect(r.severity).toBe("warning");
    expect(r.signals.accentFormats).toEqual(["hex", "named"]);
    expect(r.signals.mixedAccentFormats).toBe(true);
    expect(r.signals.findings.some((f) => f.scope === "roster:accent")).toBe(true);
  });

  it("flags two identities sharing one accent INSIDE a department, not across", () => {
    const r = summariseDesignReview(
      [
        row("a-ai", "Bot", "teal", "engineering"),
        row("b-ai", "Brain", "teal", "engineering"),
        row("c-ai", "Chart", "teal", "sales"), // same accent, different department — fine
      ],
      NOW,
    );
    expect(r.signals.departmentAccentCollisions).toEqual([
      { department: "engineering", accent: "teal", slugs: ["a-ai", "b-ai"] },
    ]);
  });

  it("flags icon reuse estate-wide", () => {
    const r = summariseDesignReview(
      [row("a-ai", "Bot", "red"), row("b-ai", "Bot", "blue", "sales")],
      NOW,
    );
    expect(r.signals.iconCollisions).toEqual([{ icon: "Bot", slugs: ["a-ai", "b-ai"] }]);
  });

  it("an empty roster is honestly insufficient", () => {
    const r = summariseDesignReview([], NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
  });

  it("carries the worker-envelope invariants: sourced, approval-required, clock-injected", () => {
    const r = summariseDesignReview([row("a-ai", "Bot", "teal")], NOW);
    expect(r.approvalRequired).toBe(true);
    expect(r.sources).toEqual(["ai_employees"]);
    expect(r.generatedAt).toBe(NOW.toISOString());
  });

  it("states its honest scope: component audits belong to CI, not a runtime guess", () => {
    const r = summariseDesignReview([row("a-ai", "Bot", "teal")], NOW);
    expect(r.reasoning).toContain("Component-adoption audits live in CI design-system tests");
  });

  it("the generative critique is null-by-construction with the dark note", () => {
    const r = summariseDesignReview([row("a-ai", "Bot", "teal")], NOW);
    expect(r.generativeCritique).toBeNull();
    expect(r.generativeNote).toContain("hq.design_review");
    expect(r.generativeNote).toContain("no model tier is bound");
  });
});

// ---------------------------------------------------------------------------
// The design_review handler — dark-seam wiring, seam + reads spied.
// ---------------------------------------------------------------------------

const { generateDepartmentDraftMock, selectMock } = vi.hoisted(() => ({
  generateDepartmentDraftMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("@/server/services/hq-generative-seams", () => ({
  generateDepartmentDraft: generateDepartmentDraftMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (cols: string) => {
        selectMock(cols);
        return {
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  { slug: "a-ai", icon: "Bot", accent: "teal", department: "eng" },
                  { slug: "b-ai", icon: "Bot", accent: "teal", department: "eng" },
                ],
                error: null,
              }),
          }),
        };
      },
    }),
  }),
}));

describe("design_review handler — dark seam wiring", () => {
  beforeEach(() => {
    generateDepartmentDraftMock.mockReset();
    selectMock.mockReset();
  });

  it("completes deterministically with a NULL critique while the seam is dark", async () => {
    generateDepartmentDraftMock.mockResolvedValue(null);
    const { designReviewHandler } = await import("@/server/services/hq-design-runner");
    const result = (await designReviewHandler({} as never)) as Record<string, unknown>;

    expect(result.kind).toBe("design_review");
    expect(result.generativeCritique).toBeNull();
    expect(String(result.generativeNote)).toContain("hq.design_review");
    expect(generateDepartmentDraftMock).toHaveBeenCalledTimes(1);
    expect(generateDepartmentDraftMock.mock.calls[0]![0]).toBe("hq.design_review");
    // The review read includes department (the collision dimension).
    expect(selectMock).toHaveBeenCalledWith("slug, icon, accent, department");
  });

  it("attaches the governed critique when the seam yields one (armed future)", async () => {
    generateDepartmentDraftMock.mockResolvedValue("A grounded critique.");
    const { designReviewHandler } = await import("@/server/services/hq-design-runner");
    const result = (await designReviewHandler({} as never)) as Record<string, unknown>;
    expect(result.generativeCritique).toBe("A grounded critique.");
    expect(String(result.generativeNote)).toContain("unreviewed draft");
  });
});
