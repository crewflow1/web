import { z } from "zod";

/**
 * Leads — customer-portal future-work requests (pure).
 *
 * A portal customer can ask their contractor for MORE work. That request is a
 * row in the EXISTING public.leads table (source = 'portal'), so staff triage
 * it in the pipeline they already use — zero new staff surface. This module is
 * the pure layer: input validation, the notes text the staff side reads, and
 * the customer-safe read-back projection.
 *
 * READ-BACK SCOPING PROOF: leads carries BOTH org_id and customer_id, so the
 * acknowledgement list is provably customer-scoped with existing columns —
 * `.eq(org_id, token-resolved org) .eq(customer_id, token-resolved customer)
 * .eq(source, 'portal')`. No name matching, no heuristics.
 *
 * READ-BACK PROJECTION: staff own the lead after submission. `notes` (staff
 * append internal commentary), `estimated_value`, `ai_summary`, `assigned_to`
 * and the raw pipeline `status` (a customer must never read "lost" about
 * themselves) are all pinned OUT — the view exposes a coarse stage word only.
 */

export const FUTURE_WORK_TIMINGS = [
  "asap",
  "within_1_month",
  "1_3_months",
  "3_6_months",
  "flexible",
] as const;
export type FutureWorkTiming = (typeof FUTURE_WORK_TIMINGS)[number];

export const FUTURE_WORK_TIMING_LABELS: Record<FutureWorkTiming, string> = {
  asap: "As soon as possible",
  within_1_month: "Within a month",
  "1_3_months": "In 1–3 months",
  "3_6_months": "In 3–6 months",
  flexible: "I'm flexible",
};

export const futureWorkRequestSchema = z.object({
  title: z.string().trim().min(3, "Give the request a short title").max(200),
  details: z
    .string()
    .trim()
    .min(10, "Tell us a little more about the work")
    .max(5000),
  timing: z.enum(FUTURE_WORK_TIMINGS),
});
export type FutureWorkRequestInput = z.infer<typeof futureWorkRequestSchema>;

/**
 * The lead's notes body. Prefixed so staff instantly see provenance; bounded
 * because both inputs are (200 + 5000 + fixed text < the 5000-cap staff forms
 * apply is irrelevant here — leads.notes is unbounded text, but we keep the
 * body under 5.5k regardless).
 */
export function buildFutureWorkNotes(input: FutureWorkRequestInput): string {
  return [
    "Future-work request submitted via the customer portal.",
    "",
    `Preferred timing: ${FUTURE_WORK_TIMING_LABELS[input.timing]}`,
    "",
    input.details,
  ].join("\n");
}

/** "ASAP" is a real urgency signal from the customer; everything else is normal. */
export function timingToUrgency(timing: FutureWorkTiming): "high" | "normal" {
  return timing === "asap" ? "high" : "normal";
}

/** Coarse, customer-safe stage words — never the raw pipeline status. */
export const PORTAL_REQUEST_STAGES = [
  "received",
  "in_review",
  "quoted",
  "booked",
  "closed",
] as const;
export type PortalRequestStage = (typeof PORTAL_REQUEST_STAGES)[number];

export const PORTAL_REQUEST_STAGE_LABELS: Record<PortalRequestStage, string> = {
  received: "Received",
  in_review: "Being reviewed",
  quoted: "Quote prepared",
  booked: "Booked in",
  closed: "Closed",
};

export function toPortalRequestStage(status: string): PortalRequestStage {
  switch (status) {
    case "new":
    case "contacted":
      return "received";
    case "qualified":
      return "in_review";
    case "quoted":
      return "quoted";
    case "won":
    case "job_booked":
      return "booked";
    case "lost":
      return "closed";
    default:
      // Unknown/legacy stages read as "received" — never echo a raw value.
      return "received";
  }
}

/** Declared, exhaustive read-back shape. */
export const FUTURE_WORK_PORTAL_KEYS = [
  "id",
  "title",
  "stage",
  "submitted_on",
] as const;

export type PortalFutureWorkView = {
  id: string;
  title: string;
  stage: PortalRequestStage;
  /** YYYY-MM-DD. */
  submitted_on: string;
};

export function buildPortalFutureWorkView(row: {
  id: string;
  service: string | null;
  status: string;
  created_at: string;
}): PortalFutureWorkView {
  return {
    id: row.id,
    title: row.service?.trim() || "Future work request",
    stage: toPortalRequestStage(row.status),
    submitted_on: row.created_at.slice(0, 10),
  };
}
