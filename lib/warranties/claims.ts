import { z } from "zod";

/**
 * Warranty claims — pure layer (P3 portal completeness).
 *
 * A warranty claim is a customer reporting an issue against cover they were
 * given. The claim becomes a row in the EXISTING public.support_tickets table
 * (category 'warranty_claim', warranty_id set), so staff triage it in the
 * support pipeline they already run and the customer can talk about it on the
 * portal messages thread that already exists. This module is the pure layer:
 * input validation, the ticket subject/body text staff read, and the
 * customer-safe status read-back projection.
 *
 * READ-BACK SCOPING PROOF: support_tickets carries org_id AND customer_id AND
 * warranty_id, so a claim read-back filters on all three — another customer's
 * or another org's claims are unreachable by construction, and only tickets
 * actually linked to the customer's own warranty appear.
 *
 * READ-BACK PROJECTION: staff own the ticket after submission. The internal
 * assignee, priority, HQ notes and the raw five-state ticket status never
 * round-trip; the view exposes a coarse claim-status word only (a customer must
 * never read a bare internal state about their own claim).
 */

export const warrantyClaimSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(3, "Give the issue a short summary")
    .max(200),
  details: z
    .string()
    .trim()
    .min(10, "Tell us a little more about the issue")
    .max(5000),
});
export type WarrantyClaimInput = z.infer<typeof warrantyClaimSchema>;

/**
 * The ticket subject. Prefixed so staff instantly see it is a warranty claim and
 * which warranty it concerns; bounded to the 200-char support_tickets.subject cap.
 */
export function buildClaimSubject(
  warrantyTitle: string,
  summary: string,
): string {
  const prefix = `Warranty claim — ${warrantyTitle}: `;
  const room = 200 - prefix.length;
  const tail = summary.length > room ? summary.slice(0, Math.max(0, room - 1)) + "…" : summary;
  return (prefix + tail).slice(0, 200);
}

/** The first support message body — provenance + the customer's description. */
export function buildClaimMessageBody(input: {
  customerName: string;
  warrantyTitle: string;
  jobReference: string;
  details: string;
}): string {
  return [
    `[Warranty claim from ${input.customerName} via the customer portal]`,
    "",
    `Warranty: ${input.warrantyTitle} (job ${input.jobReference})`,
    "",
    input.details,
  ].join("\n");
}

/** Coarse, customer-safe claim-status words — never the raw ticket status. */
export const CLAIM_STAGES = [
  "submitted",
  "in_review",
  "awaiting_you",
  "resolved",
  "closed",
] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

export const CLAIM_STAGE_LABELS: Record<ClaimStage, string> = {
  submitted: "Submitted",
  in_review: "Being reviewed",
  awaiting_you: "Awaiting your reply",
  resolved: "Resolved",
  closed: "Closed",
};

export const CLAIM_STAGE_STYLES: Record<ClaimStage, string> = {
  submitted: "bg-blue-100 text-blue-700",
  in_review: "bg-indigo-100 text-indigo-700",
  awaiting_you: "bg-amber-100 text-amber-800",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-slate-100 text-slate-600",
};

/** Map the raw support_tickets.status to a coarse, customer-safe claim stage. */
export function toClaimStage(status: string): ClaimStage {
  switch (status) {
    case "open":
      return "submitted";
    case "in_progress":
      return "in_review";
    case "waiting_on_customer":
      return "awaiting_you";
    case "resolved":
      return "resolved";
    case "closed":
      return "closed";
    default:
      // Unknown/legacy → the safest coarse word, never echo a raw value.
      return "submitted";
  }
}

/** Declared, exhaustive read-back shape. */
export const WARRANTY_CLAIM_PORTAL_KEYS = [
  "id",
  "ticket_number",
  "warranty_id",
  "summary",
  "stage",
  "submitted_on",
] as const;

export type PortalWarrantyClaimView = {
  id: string;
  ticket_number: number;
  warranty_id: string;
  summary: string;
  stage: ClaimStage;
  /** YYYY-MM-DD. */
  submitted_on: string;
};

export function buildPortalWarrantyClaimView(row: {
  id: string;
  ticket_number: number;
  warranty_id: string;
  subject: string;
  status: string;
  created_at: string;
}): PortalWarrantyClaimView {
  return {
    id: row.id,
    ticket_number: row.ticket_number,
    warranty_id: row.warranty_id,
    summary: row.subject?.trim() || "Warranty claim",
    stage: toClaimStage(row.status),
    submitted_on: row.created_at.slice(0, 10),
  };
}
