/**
 * Staff qualifications / certifications — shared PURE model.
 *
 * Server- and client-safe: no server-only imports, no I/O, no clock read that
 * is not injected. This is the single source of truth for the qualification
 * TYPE vocabulary (mirrored EXACTLY by the CHECK constraint in
 * 20261149000000_staff_competencies.sql), the form schema the add-qualification
 * action validates against, and the deterministic expiry classifier the staff
 * page and the daily briefing both read — so "expiring soon" means one thing
 * across every surface.
 *
 * WHY THIS EXISTS. `app/(app)/staff/rota/generate` states plainly that CrewFlow
 * "stores no skills or certifications against a person", so the scheduler can
 * only ever pick who is FREE, never who is QUALIFIED. This module + its table is
 * the competency record that closes that gap; the scheduler's optional skill
 * match (lib/schedule/solver.ts) reads the non-expired types a member holds.
 */

import { z } from "zod";

/**
 * The qualification TYPE vocabulary. Kept deliberately small and UK-construction
 * shaped; `other` is the escape hatch (the free-text `title` carries the detail).
 *
 * MUST stay byte-identical to the `staff_qualifications_type_check` CHECK in the
 * migration — the security test pins both sides against this list, so a drift
 * fails CI rather than shipping a value the database will reject.
 */
export const QUALIFICATION_TYPES = [
  "cscs",
  "smsts",
  "sssts",
  "first_aid",
  "asbestos_awareness",
  "trade_ticket",
  "other",
] as const;
export type QualificationType = (typeof QUALIFICATION_TYPES)[number];

/** Human labels for the select + the briefing/skill-match sentences. */
export const QUALIFICATION_TYPE_LABELS: Record<QualificationType, string> = {
  cscs: "CSCS card",
  smsts: "SMSTS",
  sssts: "SSSTS",
  first_aid: "First aid",
  asbestos_awareness: "Asbestos awareness",
  trade_ticket: "Trade ticket",
  other: "Other",
};

export function isQualificationType(v: string): v is QualificationType {
  return (QUALIFICATION_TYPES as readonly string[]).includes(v);
}

export function qualificationTypeLabel(type: string): string {
  return isQualificationType(type) ? QUALIFICATION_TYPE_LABELS[type] : type;
}

/**
 * How soon before `expires_on` a qualification is called "expiring". 30 days,
 * the same window the compliance-document briefing signal uses, so the two
 * expiry lines feel consistent.
 */
export const QUALIFICATION_EXPIRY_WINDOW_DAYS = 30;

export type QualificationExpiryStatus = "expired" | "expiring" | "valid" | "no_expiry";

/**
 * Classify one qualification's expiry against a reference day. Pure and
 * date-injected (never reads a clock), so the staff page and the briefing agree
 * and every test is reproducible.
 *
 * `expiresOn` and `today` are `YYYY-MM-DD` calendar days; the comparison is
 * lexicographic, which is correct for ISO dates and carries no timezone of its
 * own. A qualification with no expiry never expires (`no_expiry`).
 */
export function qualificationExpiryStatus(
  expiresOn: string | null | undefined,
  today: string,
): QualificationExpiryStatus {
  const exp = (expiresOn ?? "").trim();
  if (exp === "") return "no_expiry";
  if (exp < today) return "expired";
  const cutoff = addDaysIso(today, QUALIFICATION_EXPIRY_WINDOW_DAYS);
  return exp <= cutoff ? "expiring" : "valid";
}

/** Whole days between two `YYYY-MM-DD` days (UTC calendar arithmetic). */
export function daysUntil(day: string, today: string): number | null {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** `today` + `days`, as a `YYYY-MM-DD` string. Pure UTC arithmetic. */
export function addDaysIso(today: string, days: number): string {
  const base = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(base)) return today;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

// ── The add-qualification form schema ────────────────────────────────────────

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker (YYYY-MM-DD).");

/**
 * Validated by the `addStaffQualification` server action. Dates are optional; a
 * blank string is normalised to `null` so an empty input never becomes an
 * invalid date. When both are present, `expires_on` must not precede
 * `issued_on` — the same rule the DB CHECK enforces, surfaced early to the user.
 */
export const staffQualificationFormSchema = z
  .object({
    qualification_type: z.enum(QUALIFICATION_TYPES),
    title: z.string().trim().min(1, "Enter a name.").max(200, "Keep the name under 200 characters."),
    reference_no: z
      .string()
      .trim()
      .max(120, "Keep the reference under 120 characters.")
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
    issued_on: isoDate.optional().or(z.literal("")).transform((v) => (v ? v : null)),
    expires_on: isoDate.optional().or(z.literal("")).transform((v) => (v ? v : null)),
    notes: z
      .string()
      .trim()
      .max(2000, "Keep notes under 2000 characters.")
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .refine(
    (v) => !(v.issued_on && v.expires_on) || v.expires_on >= v.issued_on,
    { path: ["expires_on"], message: "Expiry cannot be before the issue date." },
  );

export type StaffQualificationFormValues = z.infer<typeof staffQualificationFormSchema>;
