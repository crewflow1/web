import { describe, it, expect } from "vitest";
import { apportion, round2 } from "@/lib/money";
import { resolveStages, equalSplit } from "@/lib/billing/schedule-math";
import type { StageDraft } from "@/lib/billing/types";

const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));

describe("apportion (penny-exact largest-remainder)", () => {
  it("splits 33.33/33.33/33.34 of £10,000 to exactly £10,000", () => {
    const parts = apportion(10_000, [33.33, 33.33, 33.34]);
    expect(parts).toEqual([3333, 3333, 3334]);
    expect(sum(parts)).toBe(10_000);
  });

  it("splits into three equal thirds with no lost penny", () => {
    const parts = apportion(10_000, [1, 1, 1]);
    expect(sum(parts)).toBe(10_000);
    expect(parts).toEqual([3333.34, 3333.33, 3333.33]);
  });

  it("handles awkward amounts (£100 / 3) exactly", () => {
    const parts = apportion(100, [1, 1, 1]);
    expect(sum(parts)).toBe(100);
  });

  it("returns all-zero for zero total or zero weights", () => {
    expect(apportion(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(apportion(1000, [0, 0])).toEqual([0, 0]);
  });

  it("weights need not sum to 100 — proportional to Σweights", () => {
    const parts = apportion(1000, [1, 3]); // 25% / 75%
    expect(parts).toEqual([250, 750]);
  });
});

describe("resolveStages", () => {
  const draft = (o: Partial<StageDraft>): StageDraft => ({
    name: o.name ?? "Stage",
    kind: o.kind ?? "stage",
    basis: o.basis ?? "fixed",
    percent: o.percent ?? null,
    amount: o.amount ?? null,
    vatRate: o.vatRate,
    ...o,
  });

  it("deposit (%) + balance sum to exactly the contract", () => {
    const r = resolveStages(10_000, [
      draft({ name: "Deposit", kind: "deposit", basis: "percent", percent: 10 }),
      draft({ name: "Balance", kind: "balance", basis: "fixed" }),
    ]);
    expect(r.stages[0]!.amount).toBe(1000);
    expect(r.stages[1]!.amount).toBe(9000);
    expect(r.scheduledNet).toBe(10_000);
    expect(r.remainingToSchedule).toBe(0);
    expect(r.overBasis).toBe(false);
  });

  it("percent stages read as exactly that % of the contract; balance absorbs the rest", () => {
    const r = resolveStages(20_000, [
      draft({ name: "A", basis: "percent", percent: 30 }),
      draft({ name: "B", basis: "percent", percent: 30 }),
      draft({ name: "Final", kind: "balance", basis: "fixed" }),
    ]);
    expect(r.stages.map((s) => s.amount)).toEqual([6000, 6000, 8000]);
    expect(r.scheduledNet).toBe(20_000);
  });

  it("adds VAT per stage on top (never inside the %)", () => {
    const r = resolveStages(0, [draft({ name: "X", basis: "fixed", amount: 1000, vatRate: 20 })]);
    const s = r.stages[0]!;
    expect(s.amount).toBe(1000);
    expect(s.vatAmount).toBe(200);
    expect(s.gross).toBe(1200);
  });

  it("flags over-carving the contract", () => {
    const r = resolveStages(10_000, [
      draft({ name: "A", basis: "fixed", amount: 6000 }),
      draft({ name: "B", basis: "fixed", amount: 6000 }),
    ]);
    expect(r.scheduledNet).toBe(12_000);
    expect(r.overBasis).toBe(true);
  });

  it("basis 0 = no ceiling; balance resolves to 0, never negative", () => {
    const r = resolveStages(0, [
      draft({ name: "Progress 1", basis: "fixed", amount: 5000 }),
      draft({ name: "Balance", kind: "balance", basis: "fixed" }),
    ]);
    expect(r.stages[1]!.amount).toBe(0);
    expect(r.overBasis).toBe(false);
  });
});

describe("equalSplit", () => {
  it("splits penny-exact", () => {
    expect(sum(equalSplit(10_000, 3))).toBe(10_000);
    expect(equalSplit(1000, 4)).toEqual([250, 250, 250, 250]);
    expect(equalSplit(1000, 0)).toEqual([]);
  });
});
