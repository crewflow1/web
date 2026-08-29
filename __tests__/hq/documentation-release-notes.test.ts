import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  composeReleaseNotes,
  summariseRosterDocCoverage,
  type ReleaseActivityRow,
  type ReleaseDecisionRow,
  type ReleaseEventRow,
} from "@/lib/hq/roster-workers";

/**
 * HQ Documentation AI — the P10 contract (L9a).
 *
 *   A. composeReleaseNotes — a deterministic composition over the three real
 *      ledgers (admin activity, HQ events, decisions): grouped counts and
 *      stored titles only, honest insufficient over an empty window, and the
 *      null-by-construction generative leg.
 *   B. summariseRosterDocCoverage — roster ↔ Bible workforce file
 *      reconciliation, with the FS-unavailable runtime folded to an honest
 *      insufficient (never "all covered").
 *   C. The release_notes_draft handler — dark-seam wiring (seam + reads spied).
 */

const NOW = new Date("2026-08-26T12:00:00Z");

const act = (action: string, table: string): ReleaseActivityRow => ({
  action,
  target_table: table,
  created_at: "2026-08-20T00:00:00Z",
});
const evt = (verb: string, object: string, severity = "info"): ReleaseEventRow => ({
  verb,
  object_type: object,
  severity,
  ts: "2026-08-21T00:00:00Z",
});
const dec = (title: string, status: string): ReleaseDecisionRow => ({
  title,
  status,
  created_at: "2026-08-22T00:00:00Z",
});

describe("A. composeReleaseNotes — grouped counts and stored titles, nothing invented", () => {
  it("composes the three sections from real rows, grouped and counted exactly", () => {
    const r = composeReleaseNotes(
      [act("update", "organizations"), act("update", "organizations"), act("insert", "users")],
      [evt("completed", "task"), evt("failed", "task", "critical")],
      [dec("Enable weather pipeline", "open")],
      14,
      NOW,
    );
    expect(r.insufficient).toBe(false);
    expect(r.sections.map((s) => s.key)).toEqual([
      "operator_actions",
      "platform_events",
      "decisions",
    ]);
    // Largest group first, exact counts.
    expect(r.sections[0]!.entries[0]).toBe("2× update on organizations");
    expect(r.sections[0]!.entries[1]).toBe("1× insert on users");
    expect(r.sections[2]!.entries).toEqual(["Enable weather pipeline [open]"]);
    expect(r.signals).toEqual({
      activityRows: 3,
      eventRows: 2,
      decisionRows: 1,
      criticalEvents: 1,
    });
  });

  it("critical events lift the band to warning (worth a human's eye before publishing)", () => {
    const quiet = composeReleaseNotes([act("update", "t")], [evt("did", "x")], [], 14, NOW);
    expect(quiet.severity).toBe("ok");
    const loud = composeReleaseNotes([], [evt("failed", "x", "critical")], [], 14, NOW);
    expect(loud.severity).toBe("warning");
  });

  it("an empty window is honestly insufficient — no release notes from silence", () => {
    const r = composeReleaseNotes([], [], [], 14, NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.sections).toEqual([]);
  });

  it("the generative prose is null-by-construction with the dark note", () => {
    const r = composeReleaseNotes([act("a", "b")], [], [], 14, NOW);
    expect(r.generativeProse).toBeNull();
    expect(r.generativeNote).toContain("hq.doc_draft");
    expect(r.generativeNote).toContain("no model tier is bound");
  });

  it("names its real sources and requires approval", () => {
    const r = composeReleaseNotes([act("a", "b")], [], [], 14, NOW);
    expect(r.sources).toEqual(["admin_activity_log", "hq_events", "hq_decisions"]);
    expect(r.approvalRequired).toBe(true);
  });
});

describe("B. summariseRosterDocCoverage — roster ↔ Bible workforce reconciliation", () => {
  const roster = [{ slug: "cto-ai" }, { slug: "design-ai" }, { slug: "new-ai" }];

  it("reconciles NN-<slug>.md files against roster slugs, both directions", () => {
    const r = summariseRosterDocCoverage(
      roster,
      ["03-cto-ai.md", "21-design-ai.md", "99-retired-ai.md", "notes.txt"],
      NOW,
    );
    expect(r.insufficient).toBe(false);
    expect(r.signals.undocumentedSlugs).toEqual(["new-ai"]);
    expect(r.signals.orphanedDocs).toEqual(["99-retired-ai.md"]);
    expect(r.severity).toBe("warning");
  });

  it("full coverage over real data is a genuine all-clear", () => {
    const r = summariseRosterDocCoverage(
      [{ slug: "cto-ai" }],
      ["03-cto-ai.md"],
      NOW,
    );
    expect(r.severity).toBe("ok");
    expect(r.signals.undocumentedSlugs).toEqual([]);
    expect(r.signals.orphanedDocs).toEqual([]);
  });

  it("an unreadable docs directory is HONESTLY insufficient — never treated as covered", () => {
    const r = summariseRosterDocCoverage(roster, null, NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.signals.fsAvailable).toBe(false);
    expect(r.summary).toContain("could not be read in this runtime");
  });
});

// ---------------------------------------------------------------------------
// C. The release_notes_draft handler — dark-seam wiring (seam + reads spied).
// ---------------------------------------------------------------------------

const { generateDepartmentDraftMock, fetchAllRowsMock, listDecisionsMock } = vi.hoisted(() => ({
  generateDepartmentDraftMock: vi.fn(),
  fetchAllRowsMock: vi.fn(),
  listDecisionsMock: vi.fn(),
}));

vi.mock("@/server/services/hq-generative-seams", () => ({
  generateDepartmentDraft: generateDepartmentDraftMock,
}));
// The two append-only ledgers are read F-1 PAGED (fetchAllRows), and decisions
// come ONLY through the sanctioned decision service — both spied here.
vi.mock("@/lib/supabase/paginate", () => ({
  fetchAllRows: fetchAllRowsMock,
}));
vi.mock("@/server/services/hq-decisions", () => ({
  listDecisions: listDecisionsMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        gte: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }),
        order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
      }),
    }),
  }),
}));

function primeWindowReads(): void {
  // fetchAllRows is called twice, in order: activity, then events.
  fetchAllRowsMock
    .mockResolvedValueOnce({
      data: [{ action: "update", target_table: "organizations", created_at: "2026-08-20T00:00:00Z" }],
      error: null,
    })
    .mockResolvedValueOnce({
      data: [{ verb: "completed", object_type: "task", severity: "info", ts: "2026-08-21T00:00:00Z" }],
      error: null,
    });
  listDecisionsMock.mockResolvedValue([
    { title: "Decide X", status: "open", created_at: new Date().toISOString() },
    // An OLD decision outside the 14-day window — must be filtered out.
    { title: "Ancient", status: "decided", created_at: "2020-01-01T00:00:00Z" },
  ]);
}

describe("C. release_notes_draft handler — dark seam wiring", () => {
  beforeEach(() => {
    generateDepartmentDraftMock.mockReset();
    fetchAllRowsMock.mockReset();
    listDecisionsMock.mockReset();
  });

  it("completes with the composed sections and a NULL prose field while the seam is dark", async () => {
    primeWindowReads();
    generateDepartmentDraftMock.mockResolvedValue(null);
    const { releaseNotesHandler } = await import(
      "@/server/services/hq-documentation-runner"
    );
    const result = (await releaseNotesHandler({ identity: { employeeId: "emp-test-1", slug: "test-ai" } } as never)) as Record<string, unknown>;

    expect(result.kind).toBe("release_notes_draft");
    expect(result.insufficient).toBe(false);
    expect(result.generativeProse).toBeNull();
    expect(String(result.generativeNote)).toContain("hq.doc_draft");
    expect(generateDepartmentDraftMock).toHaveBeenCalledTimes(1);
    expect(generateDepartmentDraftMock.mock.calls[0]![0]).toBe("hq.doc_draft");
    // The ledgers are PAGED (twice: activity + events) and decisions came only
    // through the sanctioned decision service, window-filtered.
    expect(fetchAllRowsMock).toHaveBeenCalledTimes(2);
    expect(listDecisionsMock).toHaveBeenCalledTimes(1);
    const signals = result.signals as { decisionRows: number };
    expect(signals.decisionRows).toBe(1); // "Ancient" (2020) filtered out
  });

  it("attaches the governed prose when the seam yields it (armed future)", async () => {
    primeWindowReads();
    generateDepartmentDraftMock.mockResolvedValue("Release prose.");
    const { releaseNotesHandler } = await import(
      "@/server/services/hq-documentation-runner"
    );
    const result = (await releaseNotesHandler({ identity: { employeeId: "emp-test-1", slug: "test-ai" } } as never)) as Record<string, unknown>;
    expect(result.generativeProse).toBe("Release prose.");
    expect(String(result.generativeNote)).toContain("unreviewed draft");
  });
});
