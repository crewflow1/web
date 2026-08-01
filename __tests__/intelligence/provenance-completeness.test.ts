import { describe, it, expect } from "vitest";
import { SIGNAL_KINDS, type LabelledMetric } from "@/lib/intelligence/provenance";
import { trailingDayWindow, trailingMonthsWindow } from "@/lib/intelligence/window";
import { computeUtilisation, utilisationMetric } from "@/lib/intelligence/utilisation";
import {
  computeCustomerConcentration,
  concentrationFlagMetric,
  concentrationSharesMetric,
} from "@/lib/intelligence/concentration";
import {
  computeProgressRollup,
  regressingMetric,
  stalledMetric,
} from "@/lib/intelligence/progress-rollup";
import {
  agedDebtMetric,
  computeAgedDebtSummary,
  computeRetentionExposure,
  retentionExposureMetric,
} from "@/lib/intelligence/exposure";
import { computeCvrRollup, cvrBandsMetric, cvrTotalMetric } from "@/lib/intelligence/cvr-rollup";
import {
  computeMaterialDemand,
  materialDemandMetric,
} from "@/lib/intelligence/material-demand";
import { computeSnagPatterns, snagPatternsMetric } from "@/lib/intelligence/snag-patterns";
import {
  computeSupplierPerformanceRollup,
  supplierReliabilityMetric,
  supplierRiskFlagsMetric,
} from "@/lib/intelligence/supplier-performance";

/**
 * PROVENANCE COMPLETENESS — the doctrine, swept.
 *
 * Every metric the intelligence layer can put on a card is built here from an
 * empty/minimal fixture and asserted to carry: a kind from the three-member
 * ladder, a non-empty plain-English basis, and at least one evidence link. A
 * metric that cannot label itself cannot ship — this suite is what turns that
 * sentence from a review note into a red build.
 */

const NOW = new Date("2026-07-31T23:30:00Z");

function allMetrics(): Array<[string, LabelledMetric<unknown>]> {
  const w30 = trailingDayWindow(NOW, 30);
  const w12 = trailingMonthsWindow(NOW, 12);

  const utilisation = computeUtilisation({
    members: [],
    rota: [],
    timeEntries: [],
    window: w30,
    nowMs: NOW.getTime(),
  });
  const concentration = computeCustomerConcentration({
    invoices: [],
    naming: { customerName: new Map(), jobCustomer: new Map() },
    window: w12,
  });
  const rollup = computeProgressRollup([], "2026-08-01");
  const exposure = computeRetentionExposure({
    accrued: 0,
    released: 0,
    held: 0,
    outstandingByState: { overdue: 0, due: 0, held: 0, awaiting_completion: 0, released: 0 },
    lineCountByState: { overdue: 0, due: 0, held: 0, awaiting_completion: 0, released: 0 },
    jobCount: 0,
    jobsHoldingCount: 0,
    jobsOverdueCount: 0,
  });
  const agedDebt = computeAgedDebtSummary({
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 },
    total: 0,
    pastDue: 0,
    itemCount: 0,
    partyCount: 0,
    undated: 0,
  });
  const cvr = computeCvrRollup([]);
  const demand = computeMaterialDemand({
    requests: [],
    lines: [],
    issued: [],
    stockModulePending: false,
    todayIso: "2026-08-01",
  });
  const snags = computeSnagPatterns({ snags: [], jobLabel: new Map(), todayIso: "2026-08-01" });
  const supplierRollup = computeSupplierPerformanceRollup([]);

  return [
    ["utilisation", utilisationMetric(utilisation)],
    ["concentration shares", concentrationSharesMetric(concentration)],
    ["concentration flag", concentrationFlagMetric(concentration)],
    ["stalled jobs", stalledMetric(rollup)],
    ["regressing jobs", regressingMetric(rollup)],
    ["retention exposure", retentionExposureMetric(exposure)],
    ["aged debt", agedDebtMetric(agedDebt)],
    ["cvr total", cvrTotalMetric(cvr)],
    ["cvr bands", cvrBandsMetric(cvr)],
    ["material demand", materialDemandMetric(demand)],
    ["snag patterns", snagPatternsMetric(snags)],
    ["supplier reliability", supplierReliabilityMetric(supplierRollup)],
    ["supplier risk flags", supplierRiskFlagsMetric(supplierRollup)],
  ];
}

describe("every exported metric labels itself", () => {
  for (const [name, metric] of allMetrics()) {
    it(`${name}: kind + basis + evidence`, () => {
      expect(SIGNAL_KINDS).toContain(metric.provenance.kind);
      expect(metric.provenance.basis.trim().length).toBeGreaterThan(20);
      expect(metric.provenance.computedFrom.length).toBeGreaterThan(0);
      for (const ref of metric.provenance.computedFrom) {
        expect(ref.label.length).toBeGreaterThan(0);
        expect(ref.href.startsWith("/")).toBe(true);
      }
    });
  }
});

describe("the kind split holds", () => {
  it("heuristics are exactly the judgement rules; nothing else claims the label", () => {
    const kinds = new Map(allMetrics().map(([name, m]) => [name, m.provenance.kind]));
    expect(kinds.get("concentration flag")).toBe("heuristic");
    expect(kinds.get("stalled jobs")).toBe("heuristic");
    expect(kinds.get("cvr bands")).toBe("heuristic");
    expect(kinds.get("supplier risk flags")).toBe("heuristic");
    // Everything else is derived (this train ships no bare facts and nothing
    // generative — see provenance.ts's header).
    const heuristics = ["concentration flag", "stalled jobs", "cvr bands", "supplier risk flags"];
    for (const [name, kind] of kinds) {
      if (!heuristics.includes(name)) {
        expect(kind, name).toBe("derived");
      }
    }
  });
});
