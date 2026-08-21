/**
 * H2-CASH — Billing Plans domain types.
 *
 * A billing plan is the layer ABOVE invoices: it carves a job's contract (net,
 * ex-VAT) into ordered stages (deposit / stage / balance). Each stage GENERATES
 * a normal invoice via the existing authority — the plan stores no money itself.
 * Amounts here are always NET (ex-VAT); VAT is added per stage on top.
 */

export type BillingStructure = "full" | "deposit_balance" | "staged" | "milestone" | "progress";
export type StageKind = "deposit" | "stage" | "balance";
export type StageBasis = "fixed" | "percent";

/** A stage as the operator defines it, before amounts are resolved. */
export interface StageDraft {
  name: string;
  kind: StageKind;
  basis: StageBasis;
  /** 0–100 when basis === "percent" (of the contract net); ignored for fixed. */
  percent?: number | null;
  /** Ex-VAT amount when basis === "fixed"; ignored for percent/balance. */
  amount?: number | null;
  /** 0 | 5 | 20; defaults to 20. */
  vatRate?: number;
  retentionApplies?: boolean;
  dueDate?: string | null;
  milestone?: string | null;
}

/** A stage with its resolved net amount + VAT. */
export interface ResolvedStage {
  sequence: number;
  name: string;
  kind: StageKind;
  basis: StageBasis;
  percent: number | null;
  /** Resolved ex-VAT amount. */
  amount: number;
  vatRate: number;
  /** round2(amount * vatRate / 100). */
  vatAmount: number;
  /** amount + vatAmount. */
  gross: number;
  retentionApplies: boolean;
  dueDate: string | null;
  milestone: string | null;
}

/**
 * A stage's status is DERIVED from its linked invoice, never stored:
 *   planned   — no invoice generated yet
 *   invoiced  — invoice exists, unpaid
 *   part_paid — invoice partially paid
 *   paid      — invoice settled
 *   overdue   — invoice past its due date and still owed
 */
export type StageStatus = "planned" | "invoiced" | "part_paid" | "paid" | "overdue";
