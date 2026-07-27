import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday, isInvoiceOverdue } from "@/lib/invoices/overdue";
import type { ResolvedStage, StageStatus } from "./types";

/** The linked-invoice facts a stage needs to derive its status. */
export interface StageInvoiceView {
  status: string | null;
  due_date: string | null;
  total: number | string | null;
  /** Σ invoice_payments.amount for this invoice (the ledger, not the status). */
  paid: number;
}

/**
 * Derive a stage's status from its linked invoice (or null when un-invoiced).
 * "Overdue" goes through the one authority (lib/invoices/overdue), never re-derived.
 */
export function deriveStageStatus(
  inv: StageInvoiceView | null,
  todayIso: string = invoiceBusinessToday(),
): StageStatus {
  if (!inv) return "planned";
  const total = round2(toPounds(inv.total));
  const paid = round2(toPounds(inv.paid));
  if (total > 0 && paid >= total - 0.005) return "paid";
  if (isInvoiceOverdue({ status: inv.status, due_date: inv.due_date }, todayIso)) return "overdue";
  if (paid > 0) return "part_paid";
  return "invoiced";
}

/** Net + gross scheduled totals across resolved/stored stages. */
export function scheduledTotals(stages: Array<Pick<ResolvedStage, "amount" | "gross">>): {
  net: number;
  gross: number;
} {
  return {
    net: stages.reduce((acc, s) => round2(acc + toPounds(s.amount)), 0),
    gross: stages.reduce((acc, s) => round2(acc + toPounds(s.gross)), 0),
  };
}
