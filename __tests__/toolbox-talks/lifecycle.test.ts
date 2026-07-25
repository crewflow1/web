import { describe, it, expect } from "vitest";
import {
  TOOLBOX_TALK_STATUSES,
  toolboxStatusLabel,
  isEditable,
  isTerminal,
  canTransition,
  canIssue,
  parseTbtNumber,
  revisionReference,
  currentRevision,
  isCurrentRevision,
  type ToolboxTalkStatus,
} from "@/lib/health-safety/toolbox-talks";

describe("toolbox talk — lifecycle", () => {
  it("issued reads as 'Delivered' in the UI, drafts stay 'Draft'", () => {
    expect(toolboxStatusLabel("issued")).toBe("Delivered");
    expect(toolboxStatusLabel("draft")).toBe("Draft");
    expect(toolboxStatusLabel("superseded")).toBe("Superseded");
    expect(toolboxStatusLabel("withdrawn")).toBe("Withdrawn");
  });

  it("only a draft is editable; delivered/terminal are frozen", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ["issued", "superseded", "withdrawn"] as ToolboxTalkStatus[]) {
      expect(isEditable(s)).toBe(false);
    }
    expect(isTerminal("superseded")).toBe(true);
    expect(isTerminal("withdrawn")).toBe(true);
    expect(isTerminal("draft")).toBe(false);
    expect(isTerminal("issued")).toBe(false);
  });

  it("allows only draft->issued and issued->superseded/withdrawn; nothing backwards", () => {
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("issued", "superseded")).toBe(true);
    expect(canTransition("issued", "withdrawn")).toBe(true);
    // invalid
    expect(canTransition("draft", "superseded")).toBe(false);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("superseded", "issued")).toBe(false);
    expect(canTransition("withdrawn", "issued")).toBe(false);
    expect(canTransition("draft", "draft")).toBe(false);
  });

  it("all four statuses are exhaustively covered", () => {
    expect([...TOOLBOX_TALK_STATUSES]).toEqual(["draft", "issued", "superseded", "withdrawn"]);
  });
});

describe("toolbox talk — issue gate (mirrors the DB tg_tt_a_lifecycle)", () => {
  it("requires a draft with a topic and key points", () => {
    expect(canIssue({ status: "draft", topic: "Working at height", key_points: "Edge protection + harness" }).ok).toBe(true);
    expect(canIssue({ status: "draft", topic: "", key_points: "x" }).reasons).toContain("Give the talk a topic.");
    expect(canIssue({ status: "draft", topic: "x", key_points: "  " }).reasons).toContain("Add the key points that were briefed.");
    expect(canIssue({ status: "issued", topic: "x", key_points: "y" }).ok).toBe(false);
  });
});

describe("toolbox talk — reference + revision helpers", () => {
  it("parses TBT-NNNN and TBT-NNNN-R0n", () => {
    expect(parseTbtNumber("TBT-0007")).toEqual({ series: 7, revision: 1 });
    expect(parseTbtNumber("TBT-0007-R02")).toEqual({ series: 7, revision: 2 });
    expect(parseTbtNumber("RA-0001")).toBeNull();
    expect(parseTbtNumber(null)).toBeNull();
  });

  it("derives a revision reference by appending -R0n (idempotent on an already-suffixed base)", () => {
    expect(revisionReference("TBT-0007", 1)).toBe("TBT-0007");
    expect(revisionReference("TBT-0007", 2)).toBe("TBT-0007-R02");
    expect(revisionReference("TBT-0007-R02", 3)).toBe("TBT-0007-R03");
  });

  it("identifies the single current (issued) revision of a series", () => {
    const series = [
      { id: "a", status: "superseded" as ToolboxTalkStatus, revision_number: 1 },
      { id: "b", status: "issued" as ToolboxTalkStatus, revision_number: 2 },
      { id: "c", status: "draft" as ToolboxTalkStatus, revision_number: 3 },
    ];
    expect(currentRevision(series)?.id).toBe("b");
    expect(isCurrentRevision({ id: "b", status: "issued" }, series)).toBe(true);
    expect(isCurrentRevision({ id: "a", status: "superseded" }, series)).toBe(false);
    expect(currentRevision([{ id: "x", status: "draft" as ToolboxTalkStatus, revision_number: 1 }])).toBeNull();
  });
});
