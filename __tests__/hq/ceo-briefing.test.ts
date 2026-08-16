import { describe, it, expect, vi } from "vitest";
import { composeCeoBriefing } from "@/lib/hq/ceo-briefing";
import type { CeoBoard, DeptCard } from "@/lib/hq/ceo";
import type { ExecCard } from "@/lib/hq/executive";

/**
 * Unit proof for the auto morning CEO briefing (lib/hq/ceo-briefing.ts + the compose/record
 * runtime). The composer turns the assembled CEO board into a deterministic headline + narrative —
 * narrating the board's REAL figures and honest health tones, fabricating nothing, and making no
 * model call. The runtime records it once per day, best-effort, through an injectable seam.
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/server/services/hq-ceo", () => ({ getCeoDashboard: vi.fn() }));

const NOW = new Date("2026-08-14T06:00:00Z");

function vital(over: Partial<ExecCard> & Pick<ExecCard, "key" | "label" | "value" | "format">): ExecCard {
  return { accent: "emerald", ...over };
}

function dept(
  over: { key: string; title: string; tone: DeptCard["health"]["tone"] } & Partial<DeptCard>,
): DeptCard {
  return {
    key: over.key,
    title: over.title,
    blurb: over.blurb ?? "",
    href: over.href ?? "/admin/x",
    icon: over.icon ?? "box",
    accent: over.accent ?? "slate",
    headline: over.headline ?? { label: "n", value: 0, format: "int" },
    trend: over.trend,
    health:
      over.health ?? { tone: over.tone, label: over.tone === "insufficient" ? "Unavailable" : over.tone },
    stats: over.stats ?? [],
  };
}

const board: CeoBoard = {
  vitals: [
    vital({ key: "mrr", label: "MRR", value: 5000, format: "gbp", trend: { pct: 4.2, direction: "up" } }),
    vital({ key: "arr", label: "ARR", value: 60000, format: "gbp" }),
    vital({ key: "learning", label: "Learnings", value: 0, format: "int", foundation: true }),
  ],
  departments: [
    dept({ key: "finance", title: "Finance", tone: "healthy" }),
    dept({ key: "support", title: "Support", tone: "attention" }),
    dept({ key: "pipeline", title: "Pipeline", tone: "attention" }),
    dept({ key: "research", title: "Research", tone: "foundation" }),
    dept({ key: "ai", title: "AI", tone: "insufficient" }),
  ],
};

describe("composeCeoBriefing — deterministic narrative from the real board", () => {
  it("leads the headline with MRR and the count of departments needing attention", () => {
    const b = composeCeoBriefing(board, NOW);
    expect(b.headline).toBe(
      "CEO briefing 2026-08-14 — MRR £5,000; 2 departments need attention; 1 signal unavailable.",
    );
  });

  it("narrates every vital and groups departments by honest health tone", () => {
    const b = composeCeoBriefing(board, NOW);
    expect(b.narrative).toContain("MRR: £5,000 (up 4.2%)");
    expect(b.narrative).toContain("Learnings: 0 [foundation]");
    expect(b.narrative).toContain("Needs attention: Support, Pipeline.");
    expect(b.narrative).toContain("Signal unavailable: AI.");
    expect(b.narrative).toContain("Healthy: Finance.");
  });

  it("captures a signal snapshot the narrative can be re-derived from", () => {
    const b = composeCeoBriefing(board, NOW);
    expect(b.signals.vitals[0]).toEqual({
      key: "mrr",
      label: "MRR",
      value: 5000,
      format: "gbp",
      trendPct: 4.2,
      trendDirection: "up",
      foundation: false,
    });
    expect(b.signals.departments.find((d) => d.key === "ai")).toEqual({
      key: "ai",
      title: "AI",
      healthTone: "insufficient",
      healthLabel: "Unavailable",
    });
  });

  it("is PURE — the same board yields an identical briefing", () => {
    expect(composeCeoBriefing(board, NOW)).toEqual(composeCeoBriefing(board, NOW));
  });

  it("is HONEST on an empty board — no fabricated all-clear", () => {
    const b = composeCeoBriefing({ vitals: [], departments: [] }, NOW);
    expect(b.headline).toContain("no departments flagged for attention");
    expect(b.narrative).toContain("Vitals unavailable");
    expect(b.narrative).toContain("No departments reported.");
  });
});

describe("composeAndRecordCeoBriefing — records once, best-effort, deterministic", () => {
  it("composes from the loaded board and records it, reporting the day + headline + source", async () => {
    const { composeAndRecordCeoBriefing } = await import("@/server/services/hq-ceo-briefing");
    const record = vi.fn().mockResolvedValue({ ok: true, id: 42 });
    const summary = await composeAndRecordCeoBriefing({
      now: NOW,
      loadBoard: async () => board,
      loadCompetitors: async () => ({ total: 0, notes: [] }),
      record,
    });
    expect(summary).toEqual({
      ok: true,
      briefingDate: "2026-08-14",
      id: 42,
      headline: expect.stringContaining("CEO briefing 2026-08-14"),
      source: "deterministic",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      briefingDate: "2026-08-14",
      briefing: { headline: expect.any(String), narrative: expect.any(String) },
    });
  });

  it("a failed record is returned, never thrown (best-effort)", async () => {
    const { composeAndRecordCeoBriefing } = await import("@/server/services/hq-ceo-briefing");
    const summary = await composeAndRecordCeoBriefing({
      now: NOW,
      loadBoard: async () => board,
      loadCompetitors: async () => ({ total: 0, notes: [] }),
      record: async () => ({ ok: false, error: "store_down" }),
    });
    expect(summary).toEqual({ ok: false, briefingDate: "2026-08-14", error: "store_down" });
  });

  it("a throwing board load degrades to an error summary, never throwing", async () => {
    const { composeAndRecordCeoBriefing } = await import("@/server/services/hq-ceo-briefing");
    const summary = await composeAndRecordCeoBriefing({
      now: NOW,
      loadBoard: async () => {
        throw new Error("board boom");
      },
      record: async () => ({ ok: true, id: 1 }),
    });
    expect(summary).toMatchObject({ ok: false, briefingDate: "2026-08-14", error: "board boom" });
  });
});
