import {
  computeWarrantyClock,
  WARRANTY_KIND_LABELS,
  WARRANTY_STATUS_LABELS,
  type ServiceOccurrence,
  type WarrantyStatus,
} from "@/lib/warranties/schedule";

/**
 * The customer-safe warranty view (Phase 7).
 *
 * SECURITY BY CONSTRUCTION — the same discipline as `buildCertificateSnapshot`:
 * this builder takes NAMED, customer-safe arguments and returns a shape it
 * assembles FIELD BY FIELD. A `job_warranties` row is never spread, so a column
 * added to that table in a future migration cannot reach the portal by default;
 * somebody has to come here and add it on purpose.
 *
 * Never in this shape, and never read from the database by the portal loader:
 *   org_id, created_by, voided_by, portal_published_by  — internal identities
 *   void_reason                                          — internal commentary
 *   created_at / updated_at                              — internal timing
 * A voided warranty is not projected at all (the loader filters it out), so its
 * reason never has to be redacted.
 *
 * `WARRANTY_PORTAL_KEYS` is the exact key set, asserted by a security test that
 * serialises the result and checks sentinel secrets are ABSENT FROM THE JSON —
 * not merely unrendered.
 */

export type PortalWarrantyView = {
  id: string;
  title: string;
  kind: string;
  kind_label: string;
  cover: string;
  exclusions: string | null;
  provider: string | null;
  reference: string | null;
  period_months: number;
  /** Derived from the issued certificate; null when none has been issued. */
  start_date: string | null;
  expiry_date: string | null;
  days_remaining: number | null;
  status: WarrantyStatus;
  status_label: string;
  /** True when there is no issued certificate, so no honest start date exists. */
  awaiting_completion_certificate: boolean;
  service_interval_months: number | null;
  service_notes: string | null;
  next_service_due: string | null;
  service_schedule: ServiceOccurrence[];
};

export const WARRANTY_PORTAL_KEYS: ReadonlyArray<keyof PortalWarrantyView> = [
  "id",
  "title",
  "kind",
  "kind_label",
  "cover",
  "exclusions",
  "provider",
  "reference",
  "period_months",
  "start_date",
  "expiry_date",
  "days_remaining",
  "status",
  "status_label",
  "awaiting_completion_certificate",
  "service_interval_months",
  "service_notes",
  "next_service_due",
  "service_schedule",
];

/**
 * Build the customer view. `certificateCompletionDate` is the frozen
 * `completion_date` of the job's ISSUED completion certificate, or null.
 */
export function buildPortalWarrantyView(input: {
  id: string;
  title: string;
  kind: string;
  cover: string;
  exclusions: string | null;
  provider: string | null;
  reference: string | null;
  periodMonths: number;
  serviceIntervalMonths: number | null;
  serviceNotes: string | null;
  certificateCompletionDate: string | null;
  today?: string;
}): PortalWarrantyView {
  const clock = computeWarrantyClock({
    periodMonths: input.periodMonths,
    serviceIntervalMonths: input.serviceIntervalMonths,
    certificateCompletionDate: input.certificateCompletionDate,
    today: input.today,
  });

  return {
    id: input.id,
    title: input.title,
    kind: input.kind,
    kind_label: WARRANTY_KIND_LABELS[input.kind] ?? "Warranty",
    cover: input.cover,
    exclusions: input.exclusions,
    provider: input.provider,
    reference: input.reference,
    period_months: input.periodMonths,
    start_date: clock.start,
    expiry_date: clock.expiry,
    days_remaining: clock.daysRemaining,
    status: clock.status,
    status_label: WARRANTY_STATUS_LABELS[clock.status],
    awaiting_completion_certificate: clock.start === null,
    service_interval_months: input.serviceIntervalMonths,
    service_notes: input.serviceNotes,
    next_service_due: clock.nextService?.due ?? null,
    service_schedule: clock.serviceSchedule,
  };
}
