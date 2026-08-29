/**
 * Variation-request intake — shared vocabulary + validation (roadmap G2).
 *
 * Server/client-safe — no server-only imports.
 *
 * A variation REQUEST is the structured ask that precedes the commercial
 * Variation Order ("the client wants the kitchen socket moved — someone needs
 * to price it"). Storage is public.variation_requests (20261221000000); the
 * money side stays in the EXISTING variation engine (quotes with
 * variation_number — createVariation), which stamps the request 'converted'
 * once a VO exists.
 *
 * THE TRANSITION MATRIX HERE MIRRORS THE DB TRIGGER
 * (tg_variation_requests_guard). The trigger is the enforcement; this module
 * is the shared vocabulary the UI and the pure tests read. Change them
 * together or the unit test in __tests__/variation-requests goes red against
 * the integration test.
 */

import { z } from "zod";

export const VARIATION_REQUEST_URGENCIES = ["low", "normal", "high"] as const;
export type VariationRequestUrgency =
  (typeof VARIATION_REQUEST_URGENCIES)[number];

export const VARIATION_REQUEST_URGENCY_LABELS: Record<
  VariationRequestUrgency,
  string
> = {
  low: "Low — whenever suits",
  normal: "Normal",
  high: "High — holding up work",
};

export const VARIATION_REQUEST_STATUSES = [
  "requested",
  "reviewing",
  "accepted",
  "rejected",
  "converted",
] as const;
export type VariationRequestStatus =
  (typeof VARIATION_REQUEST_STATUSES)[number];

export const VARIATION_REQUEST_STATUS_LABELS: Record<
  VariationRequestStatus,
  string
> = {
  requested: "Requested",
  reviewing: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
  converted: "Variation created",
};

export const VARIATION_REQUESTER_TYPES = [
  "staff",
  "customer",
  "worker_token",
] as const;
export type VariationRequesterType = (typeof VARIATION_REQUESTER_TYPES)[number];

export const VARIATION_REQUESTER_TYPE_LABELS: Record<
  VariationRequesterType,
  string
> = {
  staff: "Staff",
  customer: "Customer",
  worker_token: "Site worker",
};

/**
 * Forward-only state machine — the EXACT matrix tg_variation_requests_guard
 * enforces in Postgres:
 *
 *   requested → reviewing | accepted | rejected   (an admin may decide
 *   reviewing → accepted | rejected                without formally opening
 *   accepted  → converted                          a review first)
 *   rejected  → ∅   converted → ∅                 (terminal)
 */
export const VARIATION_REQUEST_TRANSITIONS: Record<
  VariationRequestStatus,
  readonly VariationRequestStatus[]
> = {
  requested: ["reviewing", "accepted", "rejected"],
  reviewing: ["accepted", "rejected"],
  accepted: ["converted"],
  rejected: [],
  converted: [],
};

export function canTransitionVariationRequest(
  from: VariationRequestStatus,
  to: VariationRequestStatus,
): boolean {
  return VARIATION_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Terminal states — nothing moves out of them (drives UI affordances). */
export function isTerminalVariationRequestStatus(
  status: VariationRequestStatus,
): boolean {
  return VARIATION_REQUEST_TRANSITIONS[status].length === 0;
}

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/**
 * STAFF intake (job workspace). requester identity comes from the session,
 * never from this form.
 */
export const variationRequestFormSchema = z.object({
  title: z.string().trim().min(3, "Give the request a short title").max(200),
  description: optionalString(5000),
  reason: optionalString(2000),
  urgency: z.enum(VARIATION_REQUEST_URGENCIES),
});
export type VariationRequestFormInput = z.infer<
  typeof variationRequestFormSchema
>;

/**
 * PORTAL intake (customer / worker). Same fields plus the job the change is
 * against — the ACTION re-verifies the job belongs to the token's own
 * customer + org before anything is written; this uuid check is shape only.
 */
export const portalVariationRequestSchema = variationRequestFormSchema.extend({
  job_id: z.string().uuid("Pick which job this is about"),
});
export type PortalVariationRequestInput = z.infer<
  typeof portalVariationRequestSchema
>;

/**
 * Management review. A rejection must say why — the requester (possibly a
 * customer) reads the outcome, and "rejected" with no reason is a support
 * call. Opening a review or accepting needs no note.
 */
export const variationRequestReviewSchema = z
  .object({
    request_id: z.string().uuid(),
    decision: z.enum(["reviewing", "accepted", "rejected"]),
    review_note: optionalString(2000),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && !v.review_note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_note"],
        message: "Add a short note explaining the rejection",
      });
    }
  });
export type VariationRequestReviewInput = z.infer<
  typeof variationRequestReviewSchema
>;
