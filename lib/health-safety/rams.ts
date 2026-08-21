/**
 * Health & Safety — RAMS (Risk Assessment & Method Statement) pure domain logic.
 *
 * Deterministic, no DB, no I/O — the same rules the DB enforces (generated
 * risk_rating, status lifecycle, immutability-on-issue) expressed once so the UI,
 * server actions and tests share a single source of truth. The 5×5 matrix and its
 * bands follow the standard HSE construction risk-assessment convention.
 */

export const LIKELIHOOD_MIN = 1;
export const LIKELIHOOD_MAX = 5;
export const SEVERITY_MIN = 1;
export const SEVERITY_MAX = 5;

/** Risk score = likelihood × severity (mirrors the DB generated column). */
export function riskRating(likelihood: number, severity: number): number {
  return likelihood * severity;
}

export type RiskBand = "low" | "medium" | "high" | "critical";

/**
 * Band a 5×5 score (1 to 25). HSE-aligned construction convention:
 * 1 to 4 low · 5 to 9 medium · 10 to 15 high · 16 to 25 critical.
 */
export function riskBand(rating: number): RiskBand {
  if (rating <= 4) return "low";
  if (rating <= 9) return "medium";
  if (rating <= 15) return "high";
  return "critical";
}

/** UI affordance: a stable label + colour token per band (meaning is in the text). */
export const RISK_BAND_META: Record<RiskBand, { label: string; tone: string }> = {
  low: { label: "Low", tone: "emerald" },
  medium: { label: "Medium", tone: "amber" },
  high: { label: "High", tone: "orange" },
  critical: { label: "Critical", tone: "red" },
};

export const RA_STATUSES = ["draft", "issued", "superseded", "withdrawn"] as const;
export type RaStatus = (typeof RA_STATUSES)[number];

/** Only drafts are editable — once issued a RAMS is a frozen legal record. */
export function isEditable(status: RaStatus): boolean {
  return status === "draft";
}

/**
 * Allowed lifecycle transitions (mirrors the DB immutability trigger):
 *   draft → issued;  issued → superseded | withdrawn;  else terminal.
 */
export function canTransition(from: RaStatus, to: RaStatus): boolean {
  if (from === "draft") return to === "issued";
  if (from === "issued") return to === "superseded" || to === "withdrawn";
  return false;
}

function intInRange(v: unknown, lo: number, hi: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

export type HazardInput = {
  hazard: string;
  whoAtRisk?: string | null;
  likelihood: number;
  severity: number;
  controlMeasures: string;
  residualLikelihood?: number | null;
  residualSeverity?: number | null;
};

/** Validate a single hazard row. Returns human-readable problems (empty = valid). */
export function validateHazard(h: HazardInput): string[] {
  const errs: string[] = [];
  if (!h.hazard?.trim()) errs.push("Hazard is required.");
  if (!h.controlMeasures?.trim()) errs.push("At least one control measure is required.");
  if (!intInRange(h.likelihood, LIKELIHOOD_MIN, LIKELIHOOD_MAX)) errs.push("Likelihood must be 1 to 5.");
  if (!intInRange(h.severity, SEVERITY_MIN, SEVERITY_MAX)) errs.push("Severity must be 1 to 5.");
  const rl = h.residualLikelihood ?? null;
  const rs = h.residualSeverity ?? null;
  if ((rl === null) !== (rs === null)) {
    errs.push("Residual risk needs both a likelihood and a severity, or neither.");
  }
  if (rl !== null && !intInRange(rl, LIKELIHOOD_MIN, LIKELIHOOD_MAX)) errs.push("Residual likelihood must be 1 to 5.");
  if (rs !== null && !intInRange(rs, SEVERITY_MIN, SEVERITY_MAX)) errs.push("Residual severity must be 1 to 5.");
  // Controls should reduce risk, never increase it.
  if (rl !== null && rs !== null && riskRating(rl, rs) > riskRating(h.likelihood, h.severity)) {
    errs.push("Residual risk cannot be higher than the initial risk.");
  }
  return errs;
}

export type RaInput = {
  title: string;
  activity: string;
  location?: string | null;
  assessmentDate?: string | null;
  reviewDate?: string | null;
  ppe?: string[];
  methodStatement?: string | null;
};

/** Validate the RAMS header. */
export function validateRa(r: RaInput): string[] {
  const errs: string[] = [];
  if (!r.title?.trim()) errs.push("Title is required.");
  if (!r.activity?.trim()) errs.push("Activity is required.");
  if (r.assessmentDate && r.reviewDate && r.reviewDate < r.assessmentDate) {
    errs.push("Review date cannot be before the assessment date.");
  }
  return errs;
}

/**
 * Issue readiness — a RAMS may only be issued when it is a complete, usable safety
 * document: header valid, an assessor named, and at least one assessed hazard.
 */
export function canIssue(ra: {
  status: RaStatus;
  title: string;
  activity: string;
  assessorId?: string | null;
  hazardCount: number;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (ra.status !== "draft") reasons.push("Only a draft can be issued.");
  if (!ra.title?.trim()) reasons.push("A title is required.");
  if (!ra.activity?.trim()) reasons.push("An activity is required.");
  if (!ra.assessorId) reasons.push("An assessor must be named.");
  if (ra.hazardCount < 1) reasons.push("At least one hazard must be assessed.");
  return { ok: reasons.length === 0, reasons };
}

/** Highest residual (or initial, if no residual) band across a RAMS's hazards. */
export function overallRiskBand(
  hazards: Array<{ likelihood: number; severity: number; residualLikelihood?: number | null; residualSeverity?: number | null }>,
): RiskBand | null {
  if (hazards.length === 0) return null;
  let worst = 0;
  for (const h of hazards) {
    const rl = h.residualLikelihood ?? null;
    const rs = h.residualSeverity ?? null;
    const score = rl !== null && rs !== null ? riskRating(rl, rs) : riskRating(h.likelihood, h.severity);
    if (score > worst) worst = score;
  }
  return riskBand(worst);
}
