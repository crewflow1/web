import { describe, it, expect } from "vitest";
import {
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_TRANSITIONS,
  MATERIAL_REQUEST_DERIVED_STATUSES,
  canTransitionMaterialRequest,
  isTerminalMaterialRequest,
  isDerivedMaterialRequestStatus,
  materialRequestActions,
  materialRequestFormSchema,
  materialRequestRejectSchema,
  type MaterialRequestStatus,
} from "@/lib/material-requests/schema";
import {
  computeMaterialFulfilment,
  nextFulfilmentStatus,
  isMaterialRequestOverdue,
  formatMaterialQty,
} from "@/lib/material-requests/fulfilment";

/**
 * M4 — material requests: the pure layer.
 *
 * Two things are proved here, and they are the two that would hurt most:
 *   1. THE LIFECYCLE GRAPH — every legal edge is legal and every illegal one
 *      is refused, enumerated EXHAUSTIVELY rather than spot-checked. A graph
 *      tested by example silently grows an edge the day somebody adds a
 *      status.
 *   2. THE OUTSTANDING MATHS — including the over-issue clamp, which is the
 *      one calculation that can leave a site without materials if it is wrong
 *      in the generous direction.
 */

// ── The graph ───────────────────────────────────────────────────────────────

/**
 * THE EXPECTED GRAPH, written out longhand rather than derived from the module
 * under test — a test that computes its expectation from the implementation
 * proves only that the implementation equals itself.
 */
const EXPECTED: Record<MaterialRequestStatus, MaterialRequestStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "cancelled"],
  approved: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled", "cancelled"],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};

describe("material request lifecycle — the graph", () => {
  it("has exactly the seven statuses the database CHECK allows", () => {
    expect([...MATERIAL_REQUEST_STATUSES].sort()).toEqual(
      [
        "approved",
        "cancelled",
        "draft",
        "fulfilled",
        "partially_fulfilled",
        "rejected",
        "submitted",
      ].sort(),
    );
  });

  it("matches the expected edge set exactly", () => {
    for (const from of MATERIAL_REQUEST_STATUSES) {
      expect([...MATERIAL_REQUEST_TRANSITIONS[from]].sort(), `edges out of ${from}`).toEqual(
        [...EXPECTED[from]].sort(),
      );
    }
  });

  /**
   * EXHAUSTIVE: all 7 × 7 = 49 ordered pairs. Every pair not in EXPECTED must
   * be refused — including the self-transitions and, importantly, every route
   * BACK to 'draft' (an ask the office has already seen must not be editable
   * in place; the correction path is cancel-and-raise-a-new-one).
   */
  it("refuses every pair that is not an edge (all 49 checked)", () => {
    const illegal: string[] = [];
    let checked = 0;
    for (const from of MATERIAL_REQUEST_STATUSES) {
      for (const to of MATERIAL_REQUEST_STATUSES) {
        checked++;
        const allowed = EXPECTED[from].includes(to);
        if (canTransitionMaterialRequest(from, to) !== allowed) {
          illegal.push(`${from} → ${to} (expected ${allowed ? "legal" : "illegal"})`);
        }
      }
    }
    expect(checked).toBe(49);
    expect(illegal).toEqual([]);
  });

  it("nothing leaves a terminal state", () => {
    for (const s of ["fulfilled", "rejected", "cancelled"] as const) {
      expect(isTerminalMaterialRequest(s), s).toBe(true);
      expect(MATERIAL_REQUEST_TRANSITIONS[s]).toEqual([]);
    }
    for (const s of ["draft", "submitted", "approved", "partially_fulfilled"] as const) {
      expect(isTerminalMaterialRequest(s), s).toBe(false);
    }
  });

  it("no edge leads back to draft", () => {
    for (const from of MATERIAL_REQUEST_STATUSES) {
      expect(MATERIAL_REQUEST_TRANSITIONS[from], `${from} → draft must not exist`).not.toContain(
        "draft",
      );
    }
  });

  it("the two derived statuses are reachable only from approved / partially_fulfilled", () => {
    for (const derived of MATERIAL_REQUEST_DERIVED_STATUSES) {
      const sources = MATERIAL_REQUEST_STATUSES.filter((s) =>
        MATERIAL_REQUEST_TRANSITIONS[s].includes(derived),
      );
      expect(sources.sort(), `sources of ${derived}`).toEqual(
        derived === "partially_fulfilled"
          ? ["approved"]
          : ["approved", "partially_fulfilled"],
      );
    }
    expect(isDerivedMaterialRequestStatus("fulfilled")).toBe(true);
    expect(isDerivedMaterialRequestStatus("partially_fulfilled")).toBe(true);
    expect(isDerivedMaterialRequestStatus("approved")).toBe(false);
  });
});

// ── Who may click what ──────────────────────────────────────────────────────

describe("material request actions — the buttons a human may see", () => {
  const admin = { isAdmin: true, isOwnRequest: false };
  const adminOwner = { isAdmin: true, isOwnRequest: true };
  const staffOwner = { isAdmin: false, isOwnRequest: true };
  const stranger = { isAdmin: false, isOwnRequest: false };

  it("NEVER offers a derived status, from any state, to anybody", () => {
    for (const status of MATERIAL_REQUEST_STATUSES) {
      for (const viewer of [admin, adminOwner, staffOwner, stranger]) {
        const offered = materialRequestActions(status, viewer);
        for (const derived of MATERIAL_REQUEST_DERIVED_STATUSES) {
          expect(offered, `${status} / ${JSON.stringify(viewer)}`).not.toContain(derived);
        }
      }
    }
  });

  it("only an admin may approve or reject a submitted request", () => {
    expect(materialRequestActions("submitted", admin)).toContain("approved");
    expect(materialRequestActions("submitted", admin)).toContain("rejected");
    expect(materialRequestActions("submitted", staffOwner)).not.toContain("approved");
    expect(materialRequestActions("submitted", staffOwner)).not.toContain("rejected");
    expect(materialRequestActions("submitted", stranger)).toEqual([]);
  });

  it("a requester may submit and withdraw their OWN request, pre-approval", () => {
    expect(materialRequestActions("draft", staffOwner)).toEqual(["submitted", "cancelled"]);
    expect(materialRequestActions("submitted", staffOwner)).toEqual(["cancelled"]);
    // ...but not somebody else's.
    expect(materialRequestActions("draft", stranger)).toEqual([]);
  });

  it("post-approval, cancelling is admin-only", () => {
    expect(materialRequestActions("approved", staffOwner)).toEqual([]);
    expect(materialRequestActions("partially_fulfilled", staffOwner)).toEqual([]);
    expect(materialRequestActions("approved", admin)).toEqual(["cancelled"]);
    expect(materialRequestActions("partially_fulfilled", admin)).toEqual(["cancelled"]);
  });

  it("offers nothing at all on a terminal request, even to an owner", () => {
    for (const s of ["fulfilled", "rejected", "cancelled"] as const) {
      expect(materialRequestActions(s, adminOwner), s).toEqual([]);
    }
  });

  it("every action offered is a real edge in the graph", () => {
    for (const status of MATERIAL_REQUEST_STATUSES) {
      for (const viewer of [admin, adminOwner, staffOwner, stranger]) {
        for (const action of materialRequestActions(status, viewer)) {
          expect(
            canTransitionMaterialRequest(status, action),
            `${status} → ${action} is offered but is not an edge`,
          ).toBe(true);
        }
      }
    }
  });
});

// ── Outstanding maths ───────────────────────────────────────────────────────

const line = (id: string, qty: number, unit = "bag") => ({
  id,
  description: `Material ${id}`,
  qty,
  unit,
});

describe("fulfilment maths — requested vs issued vs outstanding", () => {
  it("nothing issued reads as 'none' with everything outstanding", () => {
    const p = computeMaterialFulfilment({ lines: [line("a", 20), line("b", 5)], issued: [] });
    expect(p.state).toBe("none");
    expect(p.totalRequested).toBe(25);
    expect(p.totalFulfilled).toBe(0);
    expect(p.totalOutstanding).toBe(25);
    expect(p.pct).toBe(0);
    expect(p.outstandingCount).toBe(2);
  });

  it("SUMS multiple issues against the same line before comparing", () => {
    // Two storemen, two days, one line. Ten plus ten is a complete line — not
    // "ten", which is what per-issue clamping would produce.
    const p = computeMaterialFulfilment({
      lines: [line("a", 20)],
      issued: [
        { material_request_line_id: "a", qty: 10 },
        { material_request_line_id: "a", qty: 10 },
      ],
    });
    expect(p.lines[0]!.fulfilled).toBe(20);
    expect(p.lines[0]!.outstanding).toBe(0);
    expect(p.state).toBe("full");
  });

  it("one line complete and one short is PARTIAL, never full", () => {
    // The headline correctness rule: a total that happens to add up is not
    // enough. 100 of A and 0 of B is still a part fulfilment.
    const p = computeMaterialFulfilment({
      lines: [line("a", 20), line("b", 5)],
      issued: [{ material_request_line_id: "a", qty: 20 }],
    });
    expect(p.state).toBe("partial");
    expect(p.totalOutstanding).toBe(5);
    expect(p.outstandingCount).toBe(1);
  });

  it("handles decimal quantities without a rounding fork (12.5 m³ of concrete)", () => {
    const p = computeMaterialFulfilment({
      lines: [line("a", 12.5, "m3")],
      issued: [
        { material_request_line_id: "a", qty: 6.25 },
        { material_request_line_id: "a", qty: 6.25 },
      ],
    });
    expect(p.lines[0]!.fulfilled).toBe(12.5);
    expect(p.lines[0]!.complete).toBe(true);
    expect(p.state).toBe("full");
  });

  it("string quantities (the numeric(12,2) wire format) behave as numbers", () => {
    const p = computeMaterialFulfilment({
      lines: [{ id: "a", description: "Cement", qty: "20.00", unit: "bag" }],
      issued: [{ material_request_line_id: "a", qty: "20.00" }],
    });
    expect(p.state).toBe("full");
    expect(p.totalOutstanding).toBe(0);
  });

  describe("OVER-ISSUE — the clamp", () => {
    it("clamps the DISPLAY figure so fulfilled never exceeds requested", () => {
      const p = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [{ material_request_line_id: "a", qty: 25 }],
      });
      expect(p.lines[0]!.fulfilled, "display figure is clamped").toBe(20);
      expect(p.lines[0]!.issued, "the raw truth is preserved").toBe(25);
      expect(p.lines[0]!.outstanding).toBe(0);
      expect(p.totalFulfilled).toBe(20);
      expect(p.pct, "a bar past 100% reads as a bug").toBe(100);
    });

    it("FLAGS the surplus rather than swallowing it", () => {
      const p = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [{ material_request_line_id: "a", qty: 25 }],
      });
      expect(p.hasOverIssue).toBe(true);
      expect(p.lines[0]!.over).toBe(true);
      expect(p.lines[0]!.overBy).toBe(5);
    });

    it("an over-issue on ONE line cannot paper over a short line", () => {
      // Without the clamp, 500 + 0 against 20 + 5 would total past 25 and any
      // sum-based rule would call the whole request fulfilled while line B has
      // had nothing. This is the failure mode that leaves a site short.
      const p = computeMaterialFulfilment({
        lines: [line("a", 20), line("b", 5)],
        issued: [{ material_request_line_id: "a", qty: 500 }],
      });
      expect(p.state).toBe("partial");
      expect(p.totalFulfilled).toBe(20);
      expect(p.totalOutstanding).toBe(5);
      expect(p.hasOverIssue).toBe(true);
    });

    it("negative issue quantities are floored at zero, never credited", () => {
      const p = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [
          { material_request_line_id: "a", qty: 20 },
          { material_request_line_id: "a", qty: -5 },
        ],
      });
      expect(p.lines[0]!.fulfilled).toBe(20);
      expect(p.state).toBe("full");
    });

    it("an issue against an unknown line id is ignored, not counted", () => {
      const p = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [{ material_request_line_id: "ghost", qty: 999 }],
      });
      expect(p.state).toBe("none");
      expect(p.totalFulfilled).toBe(0);
    });
  });

  describe("stock module pending", () => {
    it("is a DIFFERENT claim from 'nothing issued'", () => {
      const pending = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [],
        stockModulePending: true,
      });
      const measured = computeMaterialFulfilment({ lines: [line("a", 20)], issued: [] });
      expect(pending.stockModulePending).toBe(true);
      expect(measured.stockModulePending).toBe(false);
      // Both read zero — which is exactly why the flag has to exist for the UI
      // to tell "we cannot see" apart from "nothing happened".
      expect(pending.totalFulfilled).toBe(measured.totalFulfilled);
    });

    it("NEVER advances a status — an absent measurement must not move anything", () => {
      const pending = computeMaterialFulfilment({
        lines: [line("a", 20)],
        issued: [{ material_request_line_id: "a", qty: 20 }],
        stockModulePending: true,
      });
      expect(nextFulfilmentStatus("approved", pending)).toBeNull();
      expect(nextFulfilmentStatus("partially_fulfilled", pending)).toBeNull();
    });
  });

  it("an empty request is 'none', not vacuously 'full'", () => {
    const p = computeMaterialFulfilment({ lines: [], issued: [] });
    expect(p.state).toBe("none");
    expect(p.pct).toBe(0);
  });
});

// ── Status advance ──────────────────────────────────────────────────────────

describe("nextFulfilmentStatus — when the app bothers to call the RPC", () => {
  const partial = computeMaterialFulfilment({
    lines: [line("a", 20), line("b", 5)],
    issued: [{ material_request_line_id: "a", qty: 20 }],
  });
  const full = computeMaterialFulfilment({
    lines: [line("a", 20)],
    issued: [{ material_request_line_id: "a", qty: 20 }],
  });
  const none = computeMaterialFulfilment({ lines: [line("a", 20)], issued: [] });

  it("approved + partial issues → partially_fulfilled", () => {
    expect(nextFulfilmentStatus("approved", partial)).toBe("partially_fulfilled");
  });

  it("approved + everything issued → fulfilled", () => {
    expect(nextFulfilmentStatus("approved", full)).toBe("fulfilled");
  });

  it("partially_fulfilled + everything issued → fulfilled", () => {
    expect(nextFulfilmentStatus("partially_fulfilled", full)).toBe("fulfilled");
  });

  it("never walks BACKWARDS from partially_fulfilled to approved", () => {
    // A stock correction is the other lane's reversal movement; it must not
    // make this request pretend nothing was ever issued.
    expect(nextFulfilmentStatus("partially_fulfilled", none)).toBeNull();
  });

  // ── the walk-back (20261071) ────────────────────────────────────────────────
  /**
   * `status` is a CACHE of a derivation, and before 20261071 it could only move
   * one way — so a request whose issues were all reversed went on reading
   * `fulfilled` for ever. That column drives the office queue's filters and
   * `isMaterialRequestOverdue` treats `fulfilled` as "nobody is waiting", so the
   * site that lost its cement dropped off the radar.
   *
   * THE INVARIANT: status = 'fulfilled' ⟹ the derived position is 'full'. These
   * mirror advance_material_request_fulfilment exactly; a drift between the two
   * is the hazard this whole module is built to avoid.
   */
  it("walks BACK off fulfilled when the derivation drops to partial", () => {
    expect(nextFulfilmentStatus("fulfilled", partial)).toBe("partially_fulfilled");
  });

  it("walks BACK off fulfilled even when the derivation drops all the way to none", () => {
    // 'none' does NOT become 'approved': the request is open and something did
    // happen here, which is what `partially_fulfilled` means. Landing on
    // 'approved' would also contradict the never-walk-back-to-approved rule.
    expect(nextFulfilmentStatus("fulfilled", none)).toBe("partially_fulfilled");
  });

  it("leaves a genuinely fulfilled request alone (no pointless round trip)", () => {
    expect(nextFulfilmentStatus("fulfilled", full)).toBeNull();
  });

  it("an UNMEASURED position still moves nothing, from any status", () => {
    // The one case where staleness is the correct answer: we cannot see, so we
    // must not claim. A false walk-back would reopen a satisfied request.
    const pending = computeMaterialFulfilment({
      lines: [line("a", 20)],
      issued: [],
      stockModulePending: true,
    });
    for (const s of ["approved", "partially_fulfilled", "fulfilled"] as const) {
      expect(nextFulfilmentStatus(s, pending), s).toBeNull();
    }
  });

  it("returns null when nothing would move (no pointless round trip)", () => {
    expect(nextFulfilmentStatus("approved", none)).toBeNull();
    expect(nextFulfilmentStatus("partially_fulfilled", partial)).toBeNull();
  });

  it("refuses to advance a request that has no fulfilment position", () => {
    // `fulfilled` is deliberately NOT in this list any more. Since 20261071 it
    // HAS a position — it is a cache of one — and its no-op case is covered
    // above by "leaves a genuinely fulfilled request alone". These five have no
    // position at all: two have not been decided, three are human-terminal.
    for (const s of ["draft", "submitted", "rejected", "cancelled"] as const) {
      expect(nextFulfilmentStatus(s, full), s).toBeNull();
      expect(nextFulfilmentStatus(s, partial), s).toBeNull();
      expect(nextFulfilmentStatus(s, none), s).toBeNull();
    }
  });
});

// ── Overdue ─────────────────────────────────────────────────────────────────

describe("overdue", () => {
  it("is true for a live request past its needed-by", () => {
    expect(
      isMaterialRequestOverdue({ status: "submitted", needed_by: "2026-07-01" }, "2026-07-29"),
    ).toBe(true);
    expect(
      isMaterialRequestOverdue({ status: "approved", needed_by: "2026-07-01" }, "2026-07-29"),
    ).toBe(true);
  });

  it("is false once nobody is waiting on it", () => {
    for (const status of ["fulfilled", "rejected", "cancelled"]) {
      expect(
        isMaterialRequestOverdue({ status, needed_by: "2026-07-01" }, "2026-07-29"),
        status,
      ).toBe(false);
    }
  });

  it("is false with no needed-by, and false on the day itself", () => {
    expect(isMaterialRequestOverdue({ status: "submitted", needed_by: null }, "2026-07-29")).toBe(
      false,
    );
    expect(
      isMaterialRequestOverdue({ status: "submitted", needed_by: "2026-07-29" }, "2026-07-29"),
    ).toBe(false);
  });
});

// ── Form schemas ────────────────────────────────────────────────────────────

describe("form validation", () => {
  it("accepts a FREE-TEXT line with no catalogue item (the primary path)", () => {
    const parsed = materialRequestFormSchema.safeParse({
      priority: "normal",
      lines: [{ description: "Odd-size lintel 1200mm", qty: 2, unit: "ea" }],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("refuses a request with no lines", () => {
    const parsed = materialRequestFormSchema.safeParse({ priority: "normal", lines: [] });
    expect(parsed.success).toBe(false);
  });

  it("refuses zero and negative quantities (the DB CHECK is qty > 0)", () => {
    for (const qty of [0, -1]) {
      const parsed = materialRequestFormSchema.safeParse({
        priority: "normal",
        lines: [{ description: "Cement", qty, unit: "bag" }],
      });
      expect(parsed.success, `qty ${qty}`).toBe(false);
    }
  });

  it("refuses a blank description", () => {
    const parsed = materialRequestFormSchema.safeParse({
      priority: "normal",
      lines: [{ description: "   ", qty: 1, unit: "ea" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults the unit to 'ea' rather than leaving it empty", () => {
    const parsed = materialRequestFormSchema.parse({
      priority: "normal",
      lines: [{ description: "Cement", qty: 1, unit: "" }],
    });
    expect(parsed.lines[0]!.unit).toBe("ea");
  });

  it("refuses a priority outside the DB CHECK", () => {
    expect(
      materialRequestFormSchema.safeParse({
        priority: "high",
        lines: [{ description: "Cement", qty: 1, unit: "bag" }],
      }).success,
    ).toBe(false);
  });

  it("requires a reason on reject (mirrors the DB CHECK constraint)", () => {
    expect(materialRequestRejectSchema.safeParse({ rejection_reason: "" }).success).toBe(false);
    expect(materialRequestRejectSchema.safeParse({ rejection_reason: "   " }).success).toBe(false);
    expect(
      materialRequestRejectSchema.safeParse({ rejection_reason: "We have 30 in the yard" }).success,
    ).toBe(true);
  });
});

describe("formatMaterialQty", () => {
  it("trims 2dp noise but keeps real decimals", () => {
    expect(formatMaterialQty(20)).toBe("20");
    expect(formatMaterialQty("20.00")).toBe("20");
    expect(formatMaterialQty(12.5)).toBe("12.50");
    expect(formatMaterialQty(null)).toBe("0");
  });
});
