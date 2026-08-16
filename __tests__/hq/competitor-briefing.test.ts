import { describe, it, expect } from "vitest";
import {
  composeCeoBriefing,
  type CeoBriefingCompetitorIntel,
} from "@/lib/hq/ceo-briefing";
import type { CeoBoard } from "@/lib/hq/ceo";

/**
 * CrewFlow HQ — the CEO briefing's Competitor Intelligence section (the intel gap).
 *
 * The deterministic morning briefing (lib/hq/ceo-briefing.ts) now narrates the
 * operator-authored competitor intel store. These pin the two honest states:
 *   • POPULATED — every note is rendered verbatim (name, headline, facet, importance),
 *     and reflected in the headline + the re-derivable signals snapshot;
 *   • INSUFFICIENT — an empty store reports an honest "insufficient", never an all-clear
 *     conjured from absent data, and leaves the headline untouched.
 */

const NOW = new Date("2026-08-14T06:00:00.000Z");

// A minimal board — the competitor section is orthogonal to vitals/departments.
const board: CeoBoard = {
  vitals: [
    {
      key: "mrr",
      label: "MRR",
      value: 5000,
      format: "gbp",
      trend: { pct: 4.2, direction: "up" },
    },
  ],
  departments: [],
} as unknown as CeoBoard;

const intel: CeoBriefingCompetitorIntel = {
  total: 2,
  notes: [
    {
      name: "Acme Rivals",
      headline: "Launched a free tier",
      category: "pricing",
      importance: "high",
      capturedAt: "2026-08-13",
    },
    {
      name: "Beta Corp",
      headline: "Hiring a field-sales team",
      category: null,
      importance: "normal",
      capturedAt: "2026-08-12",
    },
  ],
};

describe("competitor briefing section — populated", () => {
  it("narrates each note verbatim, with facet + non-normal importance", () => {
    const b = composeCeoBriefing(board, NOW, intel);
    expect(b.narrative).toContain("Competitor intelligence:");
    expect(b.narrative).toContain("Acme Rivals: Launched a free tier [pricing] (high) — 2026-08-13");
    // A null category and normal importance render cleanly (no empty brackets / suffix).
    expect(b.narrative).toContain("Beta Corp: Hiring a field-sales team — 2026-08-12");
    expect(b.narrative).not.toContain("[]");
    expect(b.narrative).not.toContain("(normal)");
  });

  it("reflects the tracked count in the headline", () => {
    const b = composeCeoBriefing(board, NOW, intel);
    expect(b.headline).toContain("2 competitor notes tracked");
  });

  it("records a re-derivable competitor snapshot in signals", () => {
    const b = composeCeoBriefing(board, NOW, intel);
    expect(b.signals.competitors.total).toBe(2);
    expect(b.signals.competitors.notes).toEqual(intel.notes);
  });

  it("is deterministic — same board + intel → identical briefing", () => {
    expect(composeCeoBriefing(board, NOW, intel)).toEqual(composeCeoBriefing(board, NOW, intel));
  });

  it("shows an N-of-M line when the store has more notes than are shown", () => {
    const capped: CeoBriefingCompetitorIntel = { total: 9, notes: intel.notes };
    const b = composeCeoBriefing(board, NOW, capped);
    expect(b.narrative).toContain("Showing 2 of 9 active notes.");
  });
});

describe("competitor briefing section — insufficient", () => {
  const empty: CeoBriefingCompetitorIntel = { total: 0, notes: [] };

  it("reports an honest insufficient state when the store is empty", () => {
    const b = composeCeoBriefing(board, NOW, empty);
    expect(b.narrative).toContain("Competitor intelligence:");
    expect(b.narrative).toContain(
      "Insufficient — no competitor intelligence has been recorded.",
    );
  });

  it("does NOT add a competitor clause to the headline when empty", () => {
    const b = composeCeoBriefing(board, NOW, empty);
    expect(b.headline).not.toContain("competitor");
  });

  it("defaults to insufficient when no intel argument is supplied (back-compat)", () => {
    const b = composeCeoBriefing(board, NOW);
    expect(b.narrative).toContain(
      "Insufficient — no competitor intelligence has been recorded.",
    );
    expect(b.signals.competitors).toEqual({ total: 0, notes: [] });
  });
});
