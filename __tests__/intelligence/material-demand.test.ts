import { describe, it, expect } from "vitest";
import {
  computeMaterialDemand,
  materialDemandMetric,
  type DemandLine,
  type DemandRequest,
} from "@/lib/intelligence/material-demand";

/**
 * Material demand — quantities only, grouped by item, outstanding via the
 * fulfilment AUTHORITY (clamped per line), and the unknown-is-not-a-number
 * rule when the stock lane is unreachable.
 */

const TODAY = "2026-08-01";

function req(over: Partial<DemandRequest> & { id: string }): DemandRequest {
  return { status: "approved", needed_by: null, job_id: null, ...over };
}

function line(
  over: Partial<DemandLine> & { id: string; material_request_id: string },
): DemandLine {
  return { description: "Cement 25kg", qty: 10, unit: "bag", stock_item_id: null, ...over };
}

describe("aggregation by item", () => {
  it("merges the same free-text item across requests; outstanding is clamped per line", () => {
    const d = computeMaterialDemand({
      requests: [req({ id: "r1" }), req({ id: "r2", status: "partially_fulfilled" })],
      lines: [
        line({ id: "l1", material_request_id: "r1", qty: 10 }),
        line({ id: "l2", material_request_id: "r2", qty: 20 }),
      ],
      issued: [
        { material_request_line_id: "l1", qty: 4 }, // 6 outstanding
        { material_request_line_id: "l2", qty: 25 }, // over-issued → 0, never −5
      ],
      stockModulePending: false,
      todayIso: TODAY,
    });
    expect(d.items).toHaveLength(1);
    const cement = d.items[0]!;
    expect(cement.requested).toBe(30);
    expect(cement.outstanding).toBe(6); // 6 + 0 — the clamp is the authority's
    expect(cement.requestCount).toBe(2);
    expect(d.totalOutstanding).toBe(6);
  });

  it("does NOT merge the same description across different units", () => {
    const d = computeMaterialDemand({
      requests: [req({ id: "r1" })],
      lines: [
        line({ id: "l1", material_request_id: "r1", unit: "bag", qty: 10 }),
        line({ id: "l2", material_request_id: "r1", unit: "pallet", qty: 2 }),
      ],
      issued: [],
      stockModulePending: false,
      todayIso: TODAY,
    });
    expect(d.items).toHaveLength(2); // bags with pallets would be a made-up number
  });

  it("groups by stock_item_id when the catalogue link exists", () => {
    const d = computeMaterialDemand({
      requests: [req({ id: "r1" }), req({ id: "r2" })],
      lines: [
        line({ id: "l1", material_request_id: "r1", stock_item_id: "s-9", description: "Cement 25kg" }),
        line({ id: "l2", material_request_id: "r2", stock_item_id: "s-9", description: "cement bags" }),
      ],
      issued: [],
      stockModulePending: false,
      todayIso: TODAY,
    });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.stockItemId).toBe("s-9");
    expect(d.items[0]!.requested).toBe(20);
  });
});

describe("what counts as demand", () => {
  it("submitted requests are awaiting approval — counted apart, never in the pick list", () => {
    const d = computeMaterialDemand({
      requests: [req({ id: "r1", status: "submitted" }), req({ id: "r2", status: "approved" })],
      lines: [
        line({ id: "l1", material_request_id: "r1", qty: 99 }),
        line({ id: "l2", material_request_id: "r2", qty: 5 }),
      ],
      issued: [],
      stockModulePending: false,
      todayIso: TODAY,
    });
    expect(d.awaitingApprovalCount).toBe(1);
    expect(d.openRequestCount).toBe(1);
    expect(d.items[0]!.requested).toBe(5); // the 99 unapproved bags are absent
  });

  it("overdue counts open requests past needed_by (strictly before today)", () => {
    const d = computeMaterialDemand({
      requests: [
        req({ id: "r1", needed_by: "2026-07-31" }), // past → overdue
        req({ id: "r2", needed_by: "2026-08-01" }), // due today → not overdue
        req({ id: "r3", status: "submitted", needed_by: "2026-07-01" }), // open → overdue
      ],
      lines: [],
      issued: [],
      stockModulePending: false,
      todayIso: TODAY,
    });
    expect(d.overdueCount).toBe(2);
  });
});

describe("the stock lane being unreachable", () => {
  const d = computeMaterialDemand({
    requests: [req({ id: "r1" })],
    lines: [line({ id: "l1", material_request_id: "r1", qty: 10 })],
    issued: [],
    stockModulePending: true,
    todayIso: TODAY,
  });

  it("outstanding is NULL — unknown is not zero and not the requested amount", () => {
    expect(d.measurable).toBe(false);
    expect(d.items[0]!.outstanding).toBeNull();
    expect(d.items[0]!.requested).toBe(10); // the ask itself is still a fact
    expect(d.totalOutstanding).toBeNull();
  });
});

describe("the D1 boundary and provenance", () => {
  it("carries no money field anywhere in the output", () => {
    const d = computeMaterialDemand({
      requests: [req({ id: "r1" })],
      lines: [line({ id: "l1", material_request_id: "r1" })],
      issued: [],
      stockModulePending: false,
      todayIso: TODAY,
    });
    const flat = JSON.stringify(d).toLowerCase();
    for (const word of ["amount", "price", "cost", "value", "gbp", "£"]) {
      expect(flat).not.toContain(word);
    }
  });

  it("is derived and says quantities only", () => {
    const m = materialDemandMetric(
      computeMaterialDemand({
        requests: [],
        lines: [],
        issued: [],
        stockModulePending: false,
        todayIso: TODAY,
      }),
    );
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.basis).toContain("quantities only");
  });
});
