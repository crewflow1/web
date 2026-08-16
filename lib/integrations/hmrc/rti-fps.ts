import { isHmrcConnectable } from "./oauth";

/**
 * HMRC RTI — the Full Payment Submission (FPS) payload COMPOSER. DARK.
 *
 * Composes the FPS body an RTI submission would carry from CrewFlow's EXISTING
 * payroll authority: the frozen `payroll_lines` a finalised `payroll_runs` batch
 * already holds (computed once at finalisation by lib/payroll/compute.ts). It is
 * PURE — no network, no I/O, no `server-only` — and it computes NO PAYE and NO
 * NI: every money figure comes verbatim from the stored payroll line, so there is
 * one and only one payroll calculator in the product and this is not it. (Those
 * stored figures are CrewFlow's own ESTIMATES — standard tax code, no employer NI
 * relief, no pension — and the composer maps them honestly rather than dressing
 * them up as an exact bureau RTI calculation.)
 *
 * ── LEGAL BOUNDARY — COMPOSE, NEVER SUBMIT ──────────────────────────────────
 * This builds a payload; it does not send it. RTI filing requires HMRC to
 * RECOGNISE the software (a legal / commercial vendor-recognition gate + fraud-
 * prevention-header conformance), which is not in place. The substrate stops at
 * "prepared/held": the composed payload is stored in hmrc_submissions (status
 * prepared|held — there is no filed state) and never transmitted. This mirrors
 * the CIS300 / MTD-VAT composers exactly (lib/integrations/hmrc/cis-return.ts,
 * vat-return.ts) and the CIS_NO_FILING_NOTICE posture. See RTI_NO_FILING_NOTICE.
 *
 * ── REFUSE WHEN DARK (with one INTERNAL exception) ──────────────────────────
 * `composeFpsReturn` REFUSES (returns { ok:false, reason:'not_configured' })
 * unless HMRC is connectable (two-switch: client creds + feature flag). So while
 * dark not even the SUBMIT-bound payload is built.
 *
 * The SOLE exception is `opts.allowInternalPrepare`: preparing + HOLDING an
 * internal frozen record is pure composition over CrewFlow's OWN payroll figures.
 * It needs no HMRC OAuth connection, no token and no vendor recognition — it never
 * leaves CrewFlow. The prepare/hold path (server/services/hmrc-connections.ts)
 * passes `allowInternalPrepare: true` to build the frozen payload for storage in
 * hmrc_submissions while dark. This opens NO submit/network path — no code POSTs
 * the result to HMRC. The dark default is unchanged: a caller that omits the flag
 * still refuses while dark.
 *
 * ── THE DECLARATION ─────────────────────────────────────────────────────────
 * A real FPS can carry a "final submission for the year" declaration. It is NEVER
 * asserted here on the user's behalf: `finalSubmission` defaults false and must be
 * set by a human at submission (which this build never reaches). Inventing it
 * would be a fabricated statutory statement.
 *
 * ── WHAT IS AND IS NOT AN IDENTIFIER ────────────────────────────────────────
 * `employeeId` is CrewFlow's INTERNAL user id, NOT a statutory National Insurance
 * number. NI numbers live in the separately controlled `staff_secrets` table and
 * are deliberately NOT folded into this payload — a real recognised RTI filer
 * would join them at submission, which this build never reaches.
 */

/**
 * The sentence every RTI/FPS surface must carry. CrewFlow assembles figures; it
 * does not transmit them, and a user must never be able to infer otherwise from a
 * status badge or a button label. Mirrors CIS_NO_FILING_NOTICE.
 */
export const RTI_NO_FILING_NOTICE =
  "RTI filing requires HMRC recognition. CrewFlow prepares and holds your Full " +
  "Payment Submission (FPS) from your payroll figures — it does not file it with " +
  "HMRC. File these figures yourself through HMRC's Basic PAYE Tools or your " +
  "payroll software.";

/** The employer's RTI reference block (HMRC "employer" identity). */
export type FpsEmployer = {
  /** The employer PAYE reference (office number / reference). */
  employerPayeReference?: string | null;
  /** The Accounts Office reference. */
  accountsOfficeReference?: string | null;
  name?: string | null;
};

/** Year-to-date cumulatives an FPS carries for each employee. */
export type FpsYearToDate = {
  taxablePay: number;
  taxDeducted: number;
  employeeNic: number;
};

/** One employee's FPS line, in RTI field vocabulary, for a single pay run. */
export type FpsEmployeeLine = {
  /** CrewFlow's internal user id — NOT a National Insurance number (see module doc). */
  employeeId: string;
  name: string | null;
  hoursWorked: number;
  /** This pay period's taxable (gross) pay. */
  taxablePay: number;
  /** This pay period's PAYE income tax deducted. */
  taxDeducted: number;
  /** This pay period's employee National Insurance. */
  employeeNic: number;
  /** This pay period's net pay. */
  netPay: number;
  /** Cumulative figures for the tax year up to and including this pay date. */
  yearToDate: FpsYearToDate;
};

/** One employee's figures as fed to the composer (from a stored payroll line). */
export type FpsInputEmployee = {
  employeeId: string;
  name?: string | null;
  hoursWorked?: number | null;
  /** This period's gross pay (payroll_lines.gross_pay). */
  grossPay: number;
  /** This period's PAYE estimate (payroll_lines.paye_estimate). */
  payeDeducted: number;
  /** This period's employee NI estimate (payroll_lines.ni_estimate). */
  employeeNic: number;
  /** This period's net pay (payroll_lines.net_pay). */
  netPay: number;
  /**
   * Cumulative tax-year figures to this pay date. Absent members default to THIS
   * period's figures (a single-run YTD) — never invented from thin air.
   */
  yearToDate?: Partial<FpsYearToDate>;
};

export type FpsReturn = {
  /** UK tax year the pay date falls in, e.g. "2026-27". */
  taxYear: string;
  /** The pay date (HMRC's "payment date"), ISO yyyy-mm-dd. */
  payDate: string;
  /** Pay frequency — CrewFlow's payroll cycle. */
  paymentFrequency: "weekly" | "monthly";
  employer: FpsEmployer;
  employees: FpsEmployeeLine[];
  /** Run totals — the sum of the employee lines (a reconciliation aid, not a new figure). */
  totals: FpsYearToDate & { netPay: number };
  /**
   * "Final submission for the year" declaration. Defaults FALSE — never asserted
   * on the user's behalf (a deliberate human act at submission, never reached here).
   */
  finalSubmission: boolean;
};

export type ComposeFpsInput = {
  /** The pay date (run period end), ISO yyyy-mm-dd. */
  payDate: string;
  /** CrewFlow's payroll cycle for the run. */
  paymentFrequency: "weekly" | "monthly";
  /** One entry per paid employee in the run. */
  employees: FpsInputEmployee[];
  /** Employer identity (from the org's CIS/employer profile). Optional; unset ⇒ null. */
  employer?: FpsEmployer;
};

export type ComposeFpsResult =
  | { ok: true; period: string; payload: FpsReturn }
  | { ok: false; reason: "not_configured" | "invalid"; message: string };

/** Options for the composer. `allowInternalPrepare` is the internal prepare/hold seam. */
export type ComposeFpsOptions = {
  /**
   * Allow building the payload WITHOUT a live HMRC connection — for the internal
   * prepare/hold record only (server/services/hmrc-connections.ts). Never set this
   * on any submit/network path; it does not exist and stays recognition-gated.
   */
  allowInternalPrepare?: boolean;
};

/** RTI money is 2dp. */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Derive the UK tax year label "YYYY-YY" from a pay date. HMRC's tax year runs
 * 6 April → 5 April, so a date on/after 6 April belongs to that year; on/before
 * 5 April it belongs to the previous one. (A pure date label, not a tax
 * calculation — the same boundary the CIS composer uses.)
 */
function taxYearLabel(payDate: string): string {
  const d = new Date(`${payDate}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0 = Jan
  const day = d.getUTCDate();
  const startYear = m > 3 || (m === 3 && day >= 6) ? y : y - 1;
  const end = (startYear + 1) % 100;
  return `${startYear}-${String(end).padStart(2, "0")}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Compose the RTI Full Payment Submission payload from a finalised run's stored
 * payroll lines. REFUSES when HMRC is not connectable (dark) or the inputs are
 * unusable — UNLESS `opts.allowInternalPrepare` is set, the internal prepare/hold
 * seam, which needs no live connection. Pure — builds a value, sends nothing.
 * The "final submission" declaration is never asserted.
 */
export function composeFpsReturn(
  input: ComposeFpsInput,
  opts?: ComposeFpsOptions,
): ComposeFpsResult {
  // DARK GUARD FIRST — do not even assemble a submission payload while dark,
  // except for the internal prepare/hold path (CrewFlow's own figures, no token,
  // never transmitted).
  if (!opts?.allowInternalPrepare && !isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no FPS can be prepared.",
    };
  }

  const payDate = typeof input.payDate === "string" ? input.payDate.trim() : "";
  if (!ISO_DATE.test(payDate)) {
    return { ok: false, reason: "invalid", message: "A valid pay date (yyyy-mm-dd) is required." };
  }
  if (input.paymentFrequency !== "weekly" && input.paymentFrequency !== "monthly") {
    return { ok: false, reason: "invalid", message: "paymentFrequency must be 'weekly' or 'monthly'." };
  }
  const employeesIn = Array.isArray(input.employees) ? input.employees : [];
  if (employeesIn.length === 0) {
    // A nil pay period is reported to HMRC via an EPS, not an FPS. Refuse rather
    // than freeze an empty FPS that could be mistaken for a real return.
    return { ok: false, reason: "invalid", message: "An FPS must include at least one paid employee." };
  }

  const employees: FpsEmployeeLine[] = employeesIn.map((e) => {
    const taxablePay = round2(e.grossPay);
    const taxDeducted = round2(e.payeDeducted);
    const employeeNic = round2(e.employeeNic);
    const ytd = e.yearToDate ?? {};
    return {
      employeeId: e.employeeId,
      name: e.name ?? null,
      hoursWorked: round2(e.hoursWorked ?? 0),
      taxablePay,
      taxDeducted,
      employeeNic,
      netPay: round2(e.netPay),
      yearToDate: {
        // Absent YTD defaults to THIS period's figure — never invented.
        taxablePay: round2(ytd.taxablePay ?? taxablePay),
        taxDeducted: round2(ytd.taxDeducted ?? taxDeducted),
        employeeNic: round2(ytd.employeeNic ?? employeeNic),
      },
    };
  });

  const totals = employees.reduce(
    (acc, e) => ({
      taxablePay: round2(acc.taxablePay + e.taxablePay),
      taxDeducted: round2(acc.taxDeducted + e.taxDeducted),
      employeeNic: round2(acc.employeeNic + e.employeeNic),
      netPay: round2(acc.netPay + e.netPay),
    }),
    { taxablePay: 0, taxDeducted: 0, employeeNic: 0, netPay: 0 },
  );

  return {
    ok: true,
    period: payDate,
    payload: {
      taxYear: taxYearLabel(payDate),
      payDate,
      paymentFrequency: input.paymentFrequency,
      employer: input.employer ?? {
        employerPayeReference: null,
        accountsOfficeReference: null,
        name: null,
      },
      employees,
      totals,
      // NEVER asserted on the user's behalf.
      finalSubmission: false,
    },
  };
}
