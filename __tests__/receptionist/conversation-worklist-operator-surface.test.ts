import { describe, it, expect } from "vitest";
import {
  WORKLIST_PAGE_SIZE,
  WORKLIST_VIEW_TABS,
  parseWorklistViewParam,
  parseOffsetParam,
  nextOffset,
  previousOffset,
  worklistPath,
} from "@/app/admin/ai-receptionist/worklist/navigation";

/**
 * Conversation Worklist OPERATOR SURFACE — navigation unit tests (the AI Receptionist Programme, R44:
 * READ-ONLY WORKLIST OPERATOR SURFACE).
 *
 * The surface itself is a React server component that binds an R43 view model to pixels — its rendering is
 * pinned by the production build (it compiles + type-checks) and its consumption of ONLY the view model by
 * the security tier. What is unit-testable in isolation is the surface's PURE navigation arithmetic: which
 * views it offers as tabs, how it normalises the URL's `?view=` / `?offset=` into a safe view + page window,
 * and the hrefs it builds. This suite pins exactly that — total, deterministic, dependency-free.
 */

describe("worklist operator surface — the view tabs", () => {
  it("offers exactly the four worklists, prioritised first, each with a label", () => {
    expect(WORKLIST_VIEW_TABS.map((t) => t.view)).toEqual([
      "prioritised",
      "human_review",
      "recovery",
      "escalation",
    ]);
    for (const tab of WORKLIST_VIEW_TABS) {
      expect(tab.label.length, `${tab.view} has a label`).toBeGreaterThan(0);
    }
  });

  it("requests a fixed, sensible page size", () => {
    expect(Number.isInteger(WORKLIST_PAGE_SIZE)).toBe(true);
    expect(WORKLIST_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("worklist operator surface — parseWorklistViewParam", () => {
  it("passes through each known view verbatim", () => {
    for (const { view } of WORKLIST_VIEW_TABS) {
      expect(parseWorklistViewParam(view)).toBe(view);
    }
  });

  it("defaults an absent view to the prioritised backlog", () => {
    expect(parseWorklistViewParam(undefined)).toBe("prioritised");
  });

  it("defaults an unknown or malformed view to the prioritised backlog", () => {
    expect(parseWorklistViewParam("")).toBe("prioritised");
    expect(parseWorklistViewParam("nonsense")).toBe("prioritised");
    expect(parseWorklistViewParam("Prioritised")).toBe("prioritised"); // case-sensitive — not an exact token
    expect(parseWorklistViewParam("human-review")).toBe("prioritised"); // hyphen, not underscore
  });
});

describe("worklist operator surface — parseOffsetParam", () => {
  it("defaults an absent offset to the first page", () => {
    expect(parseOffsetParam(undefined)).toBe(0);
  });

  it("accepts a non-negative integer", () => {
    expect(parseOffsetParam("0")).toBe(0);
    expect(parseOffsetParam("25")).toBe(25);
    expect(parseOffsetParam("100")).toBe(100);
  });

  it("collapses a negative, fractional or non-numeric offset to the first page", () => {
    expect(parseOffsetParam("-5")).toBe(0);
    expect(parseOffsetParam("2.5")).toBe(0);
    expect(parseOffsetParam("abc")).toBe(0);
    expect(parseOffsetParam("")).toBe(0);
    expect(parseOffsetParam("NaN")).toBe(0);
  });
});

describe("worklist operator surface — page arithmetic", () => {
  it("steps forward by one whole page", () => {
    expect(nextOffset(0, 25)).toBe(25);
    expect(nextOffset(25, 25)).toBe(50);
    expect(nextOffset(50, 10)).toBe(60);
  });

  it("steps back by one whole page, clamped at the first page", () => {
    expect(previousOffset(50, 25)).toBe(25);
    expect(previousOffset(25, 25)).toBe(0);
    expect(previousOffset(0, 25)).toBe(0);
    expect(previousOffset(10, 25)).toBe(0); // clamp — never negative
  });
});

describe("worklist operator surface — worklistPath", () => {
  it("anchors every href under the surface path and names the view", () => {
    expect(worklistPath("prioritised", 0)).toBe(
      "/admin/ai-receptionist/worklist?view=prioritised",
    );
    expect(worklistPath("escalation", 0)).toBe(
      "/admin/ai-receptionist/worklist?view=escalation",
    );
  });

  it("omits offset 0 for a clean first-page URL, and includes a non-zero offset", () => {
    expect(worklistPath("recovery", 0)).toBe("/admin/ai-receptionist/worklist?view=recovery");
    expect(worklistPath("recovery", 25)).toBe(
      "/admin/ai-receptionist/worklist?view=recovery&offset=25",
    );
    expect(worklistPath("human_review", 50)).toBe(
      "/admin/ai-receptionist/worklist?view=human_review&offset=50",
    );
  });
});
