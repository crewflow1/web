import type { CertContent } from "@/lib/completion-certificates/schema";

/**
 * The frozen, customer-visible certificate snapshot (Phase 7).
 *
 * SECURITY BY CONSTRUCTION: this builder accepts ONLY customer-safe inputs, so
 * the snapshot it freezes can never contain internal commercial data (costs,
 * margin, supplier info, staff emails, other jobs). The portal + PDF render this
 * snapshot verbatim — never live job data — so a cert issued today reads
 * identically forever. A test asserts the snapshot's key set is exactly this shape.
 */

export type CertificateSnapshot = {
  certificate_number: string;
  completion_date: string;
  /** Defects Liability Period in months + the derived end date. */
  defects_liability_months: number;
  defects_liability_end: string;
  works_description: string;
  retention_note: string | null;
  handover_notes: string | null;
  statement: string | null;
  /** Contractor (the CrewFlow org) + customer — the two parties. */
  contractor_name: string;
  customer_name: string | null;
  job_reference: string | null;
  site_address: string | null;
  /** Who issued it, on behalf of the contractor — part of a signed document. */
  signatory_name: string | null;
  issued_on: string;
};

/** Add whole calendar months to YYYY-MM-DD, clamping to month end. */
export function addMonthsIso(dateIso: string, months: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d!, daysInTarget));
  return base.toISOString().slice(0, 10);
}

export function buildCertificateSnapshot(input: {
  certificateNumber: string;
  content: CertContent;
  contractorName: string;
  customerName: string | null;
  jobReference: string | null;
  siteAddress: string | null;
  issuedByName: string | null;
  issuedOn: string;
}): CertificateSnapshot {
  const c = input.content;
  const months = Math.max(0, Math.trunc(c.defects_liability_months ?? 12));
  return {
    certificate_number: input.certificateNumber,
    completion_date: c.completion_date,
    defects_liability_months: months,
    defects_liability_end: addMonthsIso(c.completion_date, months),
    works_description: c.works_description,
    retention_note: c.retention_note ?? null,
    handover_notes: c.handover_notes ?? null,
    statement: c.statement ?? null,
    contractor_name: input.contractorName,
    customer_name: input.customerName,
    job_reference: input.jobReference,
    site_address: input.siteAddress,
    signatory_name: c.signatory_name ?? input.issuedByName ?? null,
    issued_on: input.issuedOn,
  };
}

/** The exact key set a frozen snapshot must have — used by the security test. */
export const CERTIFICATE_SNAPSHOT_KEYS: ReadonlyArray<keyof CertificateSnapshot> = [
  "certificate_number", "completion_date", "defects_liability_months", "defects_liability_end",
  "works_description", "retention_note", "handover_notes", "statement",
  "contractor_name", "customer_name", "job_reference", "site_address", "signatory_name", "issued_on",
];
