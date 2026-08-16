import { z } from "zod";
import { daysBetween } from "@/lib/fleet/compliance";

/**
 * Asset Management — P3W2: calibration certificate register (PURE).
 *
 * The domain constants, validation, expiry classification and error translation
 * for the calibration certificate register (20261145000001). Imported by the
 * server actions AND unit-tested directly.
 *
 * HONESTY STANCE: this module concerns RECORDING a certificate issued by an
 * external lab — `calibrated_by` is that lab/engineer. CrewFlow never issues a
 * calibration certificate (see lib/assets/inspection-template.ts). The
 * `result` values below are what a lab certificate states, not a CrewFlow
 * judgement.
 *
 * Expiry classification REUSES the deterministic `daysBetween` from
 * lib/fleet/compliance (UTC-anchored, returns null on unparseable — never a
 * silent 0) rather than duplicating date maths. A certificate is valid THROUGH
 * its next-due date — due on the day, expired only strictly after — the same
 * boundary the fleet-compliance classifier uses, so calibration expiries read
 * consistently with MOT / insurance expiries.
 */

export const CALIBRATION_RESULTS = [
  "pass",
  "pass_with_adjustment",
  "fail",
  "limited",
  "indicative",
] as const;
export type CalibrationResult = (typeof CALIBRATION_RESULTS)[number];

export const CALIBRATION_RESULT_LABELS: Record<CalibrationResult, string> = {
  pass: "Pass",
  pass_with_adjustment: "Pass (adjusted)",
  fail: "Fail",
  limited: "Limited / conditional",
  indicative: "Indicative only",
};

/** A failed or indicative calibration means the instrument is not fit as-certified. */
export function resultIsFit(result: CalibrationResult): boolean {
  return result === "pass" || result === "pass_with_adjustment";
}

export type CalibrationExpiryState = "no_expiry" | "valid" | "due_soon" | "expired";

export const CALIBRATION_EXPIRY_LABELS: Record<CalibrationExpiryState, string> = {
  no_expiry: "No expiry",
  valid: "In date",
  due_soon: "Due soon",
  expired: "Expired",
};

/**
 * Classify a certificate's next-due against today.
 *
 * BOUNDARY (matches fleet compliance): due ON the day is still "due_soon", not
 * expired; only strictly past its next-due is "expired". `leadDays` is the
 * booking window that turns "valid" into "due_soon".
 */
export function classifyCalibrationExpiry(
  nextDueIso: string | null,
  todayIso: string,
  leadDays = 30,
): { state: CalibrationExpiryState; daysUntilDue: number | null } {
  if (!nextDueIso) return { state: "no_expiry", daysUntilDue: null };
  const days = daysBetween(todayIso, nextDueIso);
  if (days == null) return { state: "no_expiry", daysUntilDue: null };
  const lead = Number.isFinite(leadDays) && leadDays > 0 ? Math.floor(leadDays) : 0;
  if (days < 0) return { state: "expired", daysUntilDue: days };
  if (days <= lead) return { state: "due_soon", daysUntilDue: days };
  return { state: "valid", daysUntilDue: days };
}

/**
 * Reduce a list of an asset's certificates to its CURRENT calibration status:
 * the certificate with the latest next-due decides. A recorded fail on the
 * latest certificate is surfaced explicitly (the instrument was found out of
 * tolerance) even if its next-due is in the future.
 */
export type CalibrationRecord = {
  calibration_date: string;
  next_due_date: string | null;
  result: CalibrationResult;
};

export function currentCalibrationStatus(
  certs: readonly CalibrationRecord[],
  todayIso: string,
  leadDays = 30,
): { state: CalibrationExpiryState; latestFailed: boolean; daysUntilDue: number | null } {
  if (certs.length === 0) return { state: "no_expiry", latestFailed: false, daysUntilDue: null };
  // The governing certificate is the one with the latest calibration date; ties
  // break on the later next-due so the most protective expiry wins.
  const latest = [...certs].sort((a, b) => {
    if (a.calibration_date !== b.calibration_date) {
      return a.calibration_date < b.calibration_date ? 1 : -1;
    }
    return (a.next_due_date ?? "") < (b.next_due_date ?? "") ? 1 : -1;
  })[0]!;
  const { state, daysUntilDue } = classifyCalibrationExpiry(latest.next_due_date, todayIso, leadDays);
  return { state, latestFailed: !resultIsFit(latest.result), daysUntilDue };
}

// ── Validation ────────────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = z.string().trim().regex(ISO_DATE_RE, "Use the date picker — format must be YYYY-MM-DD");
const optIso = z.preprocess(blankToUndefined, ISO.optional());

export const recordCalibrationSchema = z
  .object({
    asset_id: z.string().uuid(),
    schedule_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    certificate_number: z.string().trim().min(1, "Enter the certificate number").max(120),
    calibrated_by: z.string().trim().min(1, "Enter who calibrated it").max(200),
    calibration_date: ISO,
    next_due_date: optIso,
    result: z.enum(CALIBRATION_RESULTS),
    standard: optText(200),
    notes: optText(4000),
  })
  .superRefine((v, ctx) => {
    if (v.next_due_date && v.next_due_date < v.calibration_date) {
      ctx.addIssue({
        code: "custom",
        message: "Next-due can't be before the calibration date",
        path: ["next_due_date"],
      });
    }
  });
export type RecordCalibrationInput = z.infer<typeof recordCalibrationSchema>;

export function friendlyCalibrationError(code: string | undefined, message: string | undefined): string {
  if (code === "23505" || (message && /number_unique|duplicate key/.test(message ?? ""))) {
    return "A certificate with that number already exists for this asset.";
  }
  if (code === "23514" || code === "check_violation") {
    if (message && /due_after_cal/.test(message)) {
      return "Next-due can't be before the calibration date.";
    }
    if (message && /not a calibration schedule/.test(message)) {
      return "The linked schedule isn't a calibration schedule.";
    }
    if (message && /not for asset/.test(message)) {
      return "The linked schedule belongs to a different asset.";
    }
    if (message && /not in org/.test(message)) {
      return "The asset or schedule you chose isn't in your organisation.";
    }
    return "That certificate isn't allowed.";
  }
  return "Couldn't save the calibration certificate. Try again.";
}
