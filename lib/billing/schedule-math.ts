import { apportion, round2, toPounds } from "@/lib/money";
import type { ResolvedStage, StageDraft } from "./types";

/**
 * PURE billing-schedule maths.
 *
 * Resolves each stage's NET amount against the contract basis, penny-exact:
 *   - fixed   → the given ex-VAT amount;
 *   - percent → percent% of the contract basis (each stage independently, so
 *               "30%" always reads as exactly 30% of the contract);
 *   - balance → absorbs the remainder (basis − Σ others), so a deposit+balance or
 *               staged plan sums to EXACTLY the contract with no stray penny.
 *
 * VAT is added per stage on top at its rate — never folded into a percentage.
 */

const TOL = 0.005;

export interface ResolveResult {
  stages: ResolvedStage[];
  /** Σ resolved net amounts. */
  scheduledNet: number;
  /** Σ resolved gross (net + VAT). */
  scheduledGross: number;
  /** basis − scheduledNet, floored at 0 (only meaningful when basis > 0). */
  remainingToSchedule: number;
  /** scheduledNet exceeds the basis (over-carved the contract). */
  overBasis: boolean;
}

function vatRateOf(d: StageDraft): number {
  const r = d.vatRate ?? 20;
  return r === 0 || r === 5 || r === 20 ? r : 20;
}

/**
 * Resolve a set of stage drafts against a contract basis (net, ex-VAT).
 * `basis` of 0 means "no ceiling" — balance stages then resolve to 0.
 */
export function resolveStages(basis: number, drafts: StageDraft[]): ResolveResult {
  const b = round2(toPounds(basis));

  // Pass 1: fixed + percent resolve in order; balance is deferred. A percent
  // stage is CAPPED at the running remainder so k independently-rounded percent
  // stages can never overshoot the basis by k half-pennies — the last stage
  // absorbs the rounding, keeping Σ penny-exact ≤ basis (a fixed stage is NOT
  // capped: an explicit over-carve is surfaced via `overBasis`).
  let used = 0;
  const interim = drafts.map((d) => {
    if (d.kind === "balance") return { draft: d, amount: null as number | null };
    let amount: number;
    if (d.basis === "percent") {
      if (b <= 0) {
        amount = 0;
      } else {
        const nominal = round2((b * toPounds(d.percent)) / 100);
        const remaining = round2(Math.max(0, b - used));
        amount = Math.min(nominal, remaining);
      }
    } else {
      amount = round2(toPounds(d.amount));
    }
    used = round2(used + amount);
    return { draft: d, amount };
  });

  // Pass 2: split the remainder across balance stages (usually one).
  const fixedSum = interim.reduce((acc, x) => (x.amount == null ? acc : round2(acc + x.amount)), 0);
  const balanceIdxs = interim.map((x, i) => (x.amount == null ? i : -1)).filter((i) => i >= 0);
  if (balanceIdxs.length > 0) {
    const remainder = b > 0 ? round2(b - fixedSum) : 0;
    const parts = apportion(Math.max(0, remainder), balanceIdxs.map(() => 1));
    balanceIdxs.forEach((idx, k) => {
      interim[idx]!.amount = parts[k] ?? 0;
    });
  }

  const stages: ResolvedStage[] = interim.map((x, i) => {
    const amount = round2(x.amount ?? 0);
    const vatRate = vatRateOf(x.draft);
    const vatAmount = round2((amount * vatRate) / 100);
    return {
      sequence: i,
      name: x.draft.name,
      kind: x.draft.kind,
      basis: x.draft.basis,
      percent: x.draft.percent ?? null,
      amount,
      vatRate,
      vatAmount,
      gross: round2(amount + vatAmount),
      retentionApplies: x.draft.retentionApplies ?? true,
      dueDate: x.draft.dueDate ?? null,
      milestone: x.draft.milestone ?? null,
    };
  });

  const scheduledNet = stages.reduce((acc, s) => round2(acc + s.amount), 0);
  const scheduledGross = stages.reduce((acc, s) => round2(acc + s.gross), 0);
  return {
    stages,
    scheduledNet,
    scheduledGross,
    remainingToSchedule: b > 0 ? round2(Math.max(0, b - scheduledNet)) : 0,
    overBasis: b > 0 && scheduledNet > b + TOL,
  };
}

/**
 * Convenience: split a contract into N equal stages, penny-exact (the last
 * stages absorb the rounding remainder so Σ === round2(basis)).
 */
export function equalSplit(basis: number, n: number): number[] {
  if (n <= 0) return [];
  return apportion(basis, new Array<number>(n).fill(1));
}
