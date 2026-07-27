import { round2, toPounds } from "@/lib/money";
import type { StageStatus } from "@/lib/billing/types";

/**
 * Customer-safe payment schedule (H2-CASH M3) — PURE.
 *
 * The customer's view of the agreed payment journey: deposit → stages →
 * completion, each with its amount, status and date. Retention is shown as the
 * customer's own money held back and when it's due — nothing more.
 *
 * Customer-safety is STRUCTURAL: the input types expose only a stage's public
 * face (name, gross amount, planned date, derived status) and a retention
 * amount + release date. Costs, margins, the plan basis, percentages, internal
 * notes, other jobs and other customers are simply not representable here, so no
 * future edit can leak them. Mirrors the M2 `portal-payments.ts` pattern.
 */

export type PortalScheduleStatus = "paid" | "part_paid" | "due" | "overdue" | "upcoming";

/** One agreed payment stage as the customer sees it. */
export interface PortalScheduleStage {
  /** Customer-facing stage name (e.g. "Deposit", "First fix", "On completion"). */
  name: string;
  /** GROSS (inc-VAT) amount for this stage — matches how the portal shows money. */
  gross: number;
  status: PortalScheduleStatus;
  /** Planned or actual date (YYYY-MM-DD), or null. */
  dueDate: string | null;
}

/** The customer-safe retention line — their money, held back, with a release date. */
export interface PortalRetentionLine {
  /** Amount currently held (£). */
  held: number;
  /** When it's due back, or null if not yet schedulable. */
  releaseDate: string | null;
}

export interface PortalSchedule {
  stages: PortalScheduleStage[];
  retention: PortalRetentionLine | null;
  /** Σ stage gross — the agreed total across the schedule. */
  totalAgreed: number;
  hasSchedule: boolean;
}

/** A resolved stage the service passes in (status already derived by the authority). */
export interface PortalScheduleInput {
  name: string;
  /** ex-VAT amount. */
  amount: number | string | null;
  /** 0 | 5 | 20. */
  vatRate: number | string | null;
  dueDate: string | null;
  /** From deriveStageStatus (lib/billing/plan) — the one status authority. */
  status: StageStatus;
}

const STATUS_MAP: Record<StageStatus, PortalScheduleStatus> = {
  planned: "upcoming",
  invoiced: "due",
  part_paid: "part_paid",
  paid: "paid",
  overdue: "overdue",
};

function grossOf(amount: number | string | null, vatRate: number | string | null): number {
  const net = round2(Math.max(0, toPounds(amount)));
  const rate = toPounds(vatRate);
  const vat = round2((net * (rate === 5 || rate === 20 ? rate : rate === 0 ? 0 : 20)) / 100);
  return round2(net + vat);
}

/**
 * Build the customer schedule from resolved stages + an optional retention line.
 * Stages keep their operator sequence (the caller sorts). Zero-amount stages are
 * dropped (nothing to pay). Retention is included only when some is held.
 */
export function computePortalSchedule(input: {
  stages: PortalScheduleInput[];
  retention?: PortalRetentionLine | null;
}): PortalSchedule {
  const stages: PortalScheduleStage[] = input.stages
    .map((s) => ({ name: String(s.name ?? "").trim() || "Stage", gross: grossOf(s.amount, s.vatRate), status: STATUS_MAP[s.status] ?? "upcoming", dueDate: s.dueDate ?? null }))
    .filter((s) => s.gross > 0);

  const totalAgreed = stages.reduce((acc, s) => round2(acc + s.gross), 0);
  const retention = input.retention && round2(Math.max(0, toPounds(input.retention.held))) > 0
    ? { held: round2(toPounds(input.retention.held)), releaseDate: input.retention.releaseDate ?? null }
    : null;

  return { stages, retention, totalAgreed, hasSchedule: stages.length > 0 };
}
