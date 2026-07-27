import { z } from "zod";

/**
 * Completion certificate — state machine + draft content schema (Phase 7).
 *
 * A shorter lifecycle than a site report: a cert is authored as a draft, ISSUED
 * once (freezing a customer-safe snapshot), and only ever SUPERSEDED (by a
 * corrected re-issue) or ARCHIVED. No review/approval gate — a Practical
 * Completion Certificate is a single contractual act by the contractor.
 */

export const CERT_STATUSES = ["draft", "issued", "superseded", "archived"] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const CERT_STATUS_LABELS: Record<CertStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  superseded: "Superseded",
  archived: "Archived",
};

export const CERT_STATUS_STYLES: Record<CertStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-emerald-100 text-emerald-700",
  superseded: "bg-amber-100 text-amber-700",
  archived: "bg-slate-100 text-slate-400",
};

const TRANSITIONS: Record<CertStatus, readonly CertStatus[]> = {
  draft: ["issued"],
  issued: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

export function canTransitionCert(from: CertStatus, to: CertStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertCertTransition(from: CertStatus, to: CertStatus): void {
  if (!canTransitionCert(from, to)) {
    throw new Error(`Illegal certificate transition ${from} → ${to}`);
  }
}

export const isCertEditable = (status: CertStatus): boolean => status === "draft";
export const isCertIssued = (status: CertStatus): boolean =>
  status === "issued" || status === "superseded" || status === "archived";

export const certIdSchema = z.string().uuid();

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/**
 * The draft content an operator authors. Every field is CUSTOMER-FACING by
 * design — there is deliberately no place here for cost, margin or internal
 * notes, so the frozen snapshot cannot leak them.
 */
export const certContentSchema = z.object({
  completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid completion date (YYYY-MM-DD)"),
  works_description: z.string().trim().min(1, "Describe the works completed").max(4000),
  defects_liability_months: z.coerce.number().int().min(0).max(120).default(12),
  retention_note: optionalText(1000),
  handover_notes: optionalText(4000),
  statement: optionalText(2000),
  signatory_name: optionalText(200),
});
export type CertContent = z.infer<typeof certContentSchema>;
