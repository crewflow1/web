/**
 * Payroll calculations — pure, server/client-safe.
 *
 * UK PAYE, employee NI, and the EMPLOYER-SIDE cost of employment. ESTIMATES ONLY.
 *
 * Income tax (standard 1257L code, no allowance restrictions modelled). These
 * thresholds are frozen and hold for 2024-25, 2025-26 and 2026-27 alike:
 *   £0       – £12,570    0%      (personal allowance)
 *   £12,570  – £50,270    20%     (basic rate)
 *   £50,270  – £125,140   40%     (higher rate)
 *   £125,140 +            45%     (additional rate)
 *
 * NI Class 1 EMPLOYEE (primary) contributions — also frozen across those years:
 *   £0       – £12,570    0%      (below primary threshold)
 *   £12,570  – £50,270    8%      (main rate)
 *   £50,270  +            2%      (upper rate)
 *
 * ── EMPLOYER COSTS (the correctness fix) ────────────────────────────────────
 * Employer secondary Class 1 NI and the automatic-enrolment employer pension
 * contribution are REAL COSTS OF EMPLOYING SOMEONE. They were absent here, so
 * labour cost — and therefore gross profit and margin on every job with direct
 * labour — was overstated. They are now computed alongside the employee figures.
 *
 * Unlike the frozen employee bands above, employer rates MOVE: the secondary rate
 * went 13.8% → 15% and the secondary threshold £9,100 → £5,000 on 6 April 2025.
 * They therefore live in a dated, sourced table (`./rates`) resolved from the
 * payroll period's own start date — never from "today" — so a finalised run keeps
 * the rates that applied when it ran. See `docs/payroll-employer-costs.md`.
 *
 * ── EMPLOYER COST IS NOT AN EMPLOYEE DEDUCTION ─────────────────────────────
 * `net_pay` is gross − PAYE − EMPLOYEE NI, and nothing else. Employer NI and
 * employer pension are costs to the BUSINESS; deducting them from the worker's pay
 * would be both wrong and unlawful. A regression test pins net_pay against this.
 *
 * ── EMPLOYEE-SIDE FIDELITY (opt-in, backward compatible) ────────────────────
 * The base per-line figures above assume a standard 1257L code, rest-of-UK bands,
 * no student loan, no employee pension, no salary sacrifice — which is what every
 * existing stored line was computed with. `computeEmployeeDeductionsForStoredLine`
 * layers the following on top WHEN (and only when) the corresponding input is
 * supplied, so an absent input reproduces the base figures to the penny:
 *   - Scottish income tax bands (by a per-employee tax-region flag)
 *   - Student loan deductions (Plan 1 / 2 / 4 / postgraduate)
 *   - Employee pension contribution (relief-at-source estimate)
 *   - Salary sacrifice (reduces the tax + NI base, and so employer NI too)
 *
 * Still NOT modelled on the employee side: marriage allowance, blind person's
 * allowance, the personal-allowance taper above £100k (also unmodelled in the base
 * rest-of-UK path), and the K-code / week-1-month-1 mechanics of a real RTI engine.
 *
 * Org-level EMPLOYMENT ALLOWANCE relief is provided by
 * `employmentAllowanceReliefForRun` — an annual offset against the org's employer NI
 * bill, presented as an "up to" estimate because YTD consumption is not tracked.
 *
 * Every result carries a `note` flag pushing owners to confirm with their
 * accountant or HMRC's official calculator.
 */

import { csvEscape } from "@/lib/csv";
import { apportion, round2 } from "@/lib/money";

import {
  resolveEmploymentCostRates,
  type EmployerNiRates,
  type EmployerPensionRates,
  type ScottishIncomeTaxRates,
  type StudentLoanPlan,
  type StudentLoanRates,
  type TaxRegion,
  type TaxYear,
} from "./rates";

const PERSONAL_ALLOWANCE = 12_570;
const HIGHER_RATE_THRESHOLD = 50_270;
const ADDITIONAL_RATE_THRESHOLD = 125_140;

const BASIC_RATE = 0.20;
const HIGHER_RATE = 0.40;
const ADDITIONAL_RATE = 0.45;

const NI_PRIMARY_THRESHOLD = 12_570;
const NI_UPPER_LIMIT = 50_270;
const NI_MAIN_RATE = 0.08;
const NI_UPPER_RATE = 0.02;

/**
 * Annualise a periodic gross pay so we can apply annual tax bands, then
 * scale the tax back to the period. This is the same approach HMRC uses
 * for non-cumulative codes — it's an estimate, not a payroll engine.
 */
function periodsPerYear(cycle: "weekly" | "monthly"): number {
  return cycle === "weekly" ? 52 : 12;
}

export function annualIncomeTax(annualGross: number): number {
  if (annualGross <= PERSONAL_ALLOWANCE) return 0;
  let tax = 0;
  const basicTaxable = Math.min(annualGross, HIGHER_RATE_THRESHOLD) - PERSONAL_ALLOWANCE;
  tax += basicTaxable * BASIC_RATE;
  if (annualGross > HIGHER_RATE_THRESHOLD) {
    const higherTaxable =
      Math.min(annualGross, ADDITIONAL_RATE_THRESHOLD) - HIGHER_RATE_THRESHOLD;
    tax += higherTaxable * HIGHER_RATE;
  }
  if (annualGross > ADDITIONAL_RATE_THRESHOLD) {
    tax += (annualGross - ADDITIONAL_RATE_THRESHOLD) * ADDITIONAL_RATE;
  }
  return tax;
}

export function annualEmployeeNi(annualGross: number): number {
  if (annualGross <= NI_PRIMARY_THRESHOLD) return 0;
  let ni = 0;
  const mainBand = Math.min(annualGross, NI_UPPER_LIMIT) - NI_PRIMARY_THRESHOLD;
  ni += mainBand * NI_MAIN_RATE;
  if (annualGross > NI_UPPER_LIMIT) {
    ni += (annualGross - NI_UPPER_LIMIT) * NI_UPPER_RATE;
  }
  return ni;
}

/**
 * Scottish income tax on an annual gross.
 *
 * Same shape as {@link annualIncomeTax} but banded on the Scottish scale (six bands
 * vs three). The personal allowance is UK-wide, so a Scottish taxpayer on a low wage
 * pays the SAME as a rest-of-UK one up to the starter band, then diverges. Applied
 * only when an employee's tax region is Scotland; the region is an INPUT (their tax
 * code carries an `S`), never inferred.
 *
 * Like the rest-of-UK path, the personal-allowance taper above £100k is NOT modelled
 * — deliberately, to stay consistent with `annualIncomeTax`.
 */
export function annualScottishIncomeTax(
  annualGross: number,
  rates: ScottishIncomeTaxRates,
): number {
  if (annualGross <= rates.personal_allowance) return 0;
  let tax = 0;
  let lower = rates.personal_allowance;
  for (const band of rates.bands) {
    if (annualGross <= lower) break;
    const upper = Math.min(annualGross, band.upto);
    if (upper > lower) tax += (upper - lower) * band.rate;
    lower = band.upto;
  }
  return tax;
}

/**
 * Student-loan repayment on an annual gross for a given plan.
 *
 * A flat percentage (9% for Plans 1/2/4, 6% for the postgraduate loan) of earnings
 * ABOVE the plan's annual threshold — there is no upper limit and no banding. The
 * base is earnings, so salary sacrifice reduces it (the caller passes the
 * post-sacrifice gross); relief-at-source pension does not.
 */
export function annualStudentLoan(
  annualGross: number,
  plan: StudentLoanPlan,
  rates: StudentLoanRates,
): number {
  const p = rates[plan];
  if (!p || annualGross <= p.threshold_annual) return 0;
  return (annualGross - p.threshold_annual) * p.rate;
}

/**
 * Employer (secondary) Class 1 NI on an annual gross.
 *
 * `rate` × earnings above the Secondary Threshold. Unlike employee NI there is NO
 * upper limit — the employer pays on everything above the threshold.
 *
 * Standard category letters (A, B, C, J) only. The 0%-up-to-UST categories for
 * under-21s, apprentices under 25 and veterans are NOT applied — we hold no date of
 * birth or apprentice/veteran flag, so applying them would be a guess. That omission
 * OVERSTATES employer NI for those staff; see `NOT_MODELLED` in `./rates`.
 *
 * The Employment Allowance is likewise not netted off here — it is an org-level
 * annual offset, not a per-employee one.
 */
export function annualEmployerNi(annualGross: number, rates: EmployerNiRates): number {
  if (annualGross <= rates.secondary_threshold_annual) return 0;
  return (annualGross - rates.secondary_threshold_annual) * rates.rate;
}

/**
 * Employer automatic-enrolment pension contribution on an annual gross.
 *
 * The statutory minimum is 3% of QUALIFYING EARNINGS — the slice of pay between the
 * lower and upper limits of the qualifying earnings band (£6,240–£50,270), NOT 3% of
 * full pay. Charging 3% of everything would overstate the cost for low earners and
 * for anyone above the upper limit, so the band is modelled properly.
 *
 * Below the automatic-enrolment earnings trigger (£10,000/yr) the employer has no
 * enrolment duty and we charge nothing. Age eligibility (22 → State Pension age) and
 * opt-out state are NOT modelled — no date of birth, no opt-out column.
 */
export function annualEmployerPension(
  annualGross: number,
  rates: EmployerPensionRates,
): number {
  // No automatic-enrolment duty below the earnings trigger.
  if (annualGross < rates.earnings_trigger_annual) return 0;
  const qualifying =
    Math.min(annualGross, rates.qualifying_earnings_upper_annual) -
    rates.qualifying_earnings_lower_annual;
  if (qualifying <= 0) return 0;
  return qualifying * rates.minimum_employer_rate;
}

export type PayrollLineCompute = {
  hours: number;
  hourly_pay: number;
  gross_pay: number;
  paye_estimate: number;
  ni_estimate: number;
  net_pay: number;
  /**
   * Employer secondary Class 1 NI for the period — a cost to the BUSINESS, payable
   * to HMRC on top of the worker's gross. Never deducted from `net_pay`.
   */
  employer_ni_estimate: number;
  /** Employer automatic-enrolment pension contribution for the period. */
  employer_pension_estimate: number;
  /**
   * TOTAL cost of employing this person for the period:
   * gross + employer NI + employer pension. THIS is the figure job costing must use
   * as labour cost — `gross_pay` alone understates it and overstates margin.
   */
  employment_cost_estimate: number;
  /** The tax year whose published rate table produced the employer figures. */
  employer_rates_tax_year: TaxYear;
  /**
   * True when the period falls in a tax year we hold no published table for and the
   * employer figures are a projection. The UI must disclose it.
   */
  employer_rates_extrapolated: boolean;
};

/**
 * Compute one staff member's line for a payroll run.
 *
 * `hours` is the net (after-break) hours from time_entries. We annualise
 * the period gross at the appropriate cadence, compute tax + NI on the
 * annual figure, then divide back.
 */
export function computePayrollLine(
  hours: number,
  hourlyPay: number,
  cycle: "weekly" | "monthly",
  /**
   * The payroll period's OWN start date (`YYYY-MM-DD`), used to pick the employer
   * rate table in force for that period. Pass it — omitting it falls back to the
   * latest published table, which is only appropriate for pure-arithmetic tests.
   */
  periodStartIso?: string,
): PayrollLineCompute {
  const safeHours = Math.max(0, hours);
  const safeRate = Math.max(0, hourlyPay);
  const grossPay = round2(safeHours * safeRate);
  const periods = periodsPerYear(cycle);
  const annualised = grossPay * periods;
  const annualTax = annualIncomeTax(annualised);
  const annualNi = annualEmployeeNi(annualised);
  const payeEstimate = round2(annualTax / periods);
  const niEstimate = round2(annualNi / periods);
  // Employee deductions ONLY. Employer costs never touch net pay.
  const netPay = round2(grossPay - payeEstimate - niEstimate);

  const resolved = resolveEmploymentCostRates(periodStartIso);
  const employerNi = round2(
    annualEmployerNi(annualised, resolved.rates.employer_ni) / periods,
  );
  const employerPension = round2(
    annualEmployerPension(annualised, resolved.rates.employer_pension) / periods,
  );
  return {
    hours: round2(safeHours),
    hourly_pay: round2(safeRate),
    gross_pay: grossPay,
    paye_estimate: payeEstimate,
    ni_estimate: niEstimate,
    net_pay: netPay,
    employer_ni_estimate: employerNi,
    employer_pension_estimate: employerPension,
    employment_cost_estimate: round2(grossPay + employerNi + employerPension),
    employer_rates_tax_year: resolved.applied_tax_year,
    employer_rates_extrapolated: resolved.extrapolated,
  };
}

export type EmployerCostEstimate = {
  employer_ni_estimate: number;
  employer_pension_estimate: number;
  employment_cost_estimate: number;
  employer_rates_tax_year: TaxYear;
  employer_rates_extrapolated: boolean;
};

/**
 * Per-employee auto-enrolment state, as tracked in `pension_enrolments` — the
 * subset the employer-cost estimate needs.
 */
export type PensionEnrolmentInput = {
  status: "not_enrolled" | "enrolled" | "opted_out" | "postponed";
  /** Employer contribution as a FRACTION of qualifying earnings (e.g. 0.03). */
  employer_contribution_rate: number;
};

/**
 * Employer pension for an employee whose auto-enrolment state is TRACKED.
 *
 * With the person's real status and their scheme's employer rate we price the
 * contribution precisely instead of assuming the statutory 3% for everyone:
 *   - not_enrolled / opted_out / postponed → £0 (no employer contribution due)
 *   - enrolled → employer_contribution_rate × qualifying earnings
 *
 * An ENROLLED jobholder is charged even below the automatic-enrolment earnings
 * trigger: an opted-in worker below the trigger must still receive employer
 * contributions. That is the single NOT_MODELLED omission that UNDERSTATES cost
 * in the untracked (blanket-3%) path; tracking the enrolment closes it.
 *
 * The qualifying-earnings band comes from the dated rate table (`./rates`), so
 * there is no rate literal here — the only per-employee input is the scheme
 * rate, which is data, not a rule.
 */
export function annualEmployerPensionForEnrolment(
  annualGross: number,
  rates: EmployerPensionRates,
  enrolment: PensionEnrolmentInput,
): number {
  if (enrolment.status !== "enrolled") return 0;
  const rate = Math.max(0, enrolment.employer_contribution_rate);
  const qualifying =
    Math.min(annualGross, rates.qualifying_earnings_upper_annual) -
    rates.qualifying_earnings_lower_annual;
  if (qualifying <= 0) return 0;
  return qualifying * rate;
}

/**
 * Employer costs for a payroll line that is ALREADY STORED.
 *
 * `payroll_lines` persists `gross_pay`, and its parent run persists `cycle` and
 * `period_start` — which is everything employer cost depends on. So this is a pure
 * derivation, and it is the SINGLE function every read site (CSV export, payslip,
 * run detail, the HMRC liability tile) goes through. Deriving rather than storing
 * means historical runs are correct the moment this ships, with no backfill and no
 * second copy of the rate table in SQL.
 *
 * It takes the stored `gross_pay` rather than re-deriving from hours × rate, so the
 * employer figures are always consistent with the gross that was actually banked.
 *
 * `periodStartIso` MUST be the run's own `period_start`, never today's date — that
 * is what keeps a finalised run priced at the rates in force when it ran.
 */
export function employerCostsForStoredLine(
  grossPay: number | string | null | undefined,
  cycle: "weekly" | "monthly",
  periodStartIso: string,
): EmployerCostEstimate {
  const gross = round2(Math.max(0, Number(grossPay ?? 0) || 0));
  const periods = periodsPerYear(cycle);
  const annualised = gross * periods;
  const resolved = resolveEmploymentCostRates(periodStartIso);
  const employerNi = round2(
    annualEmployerNi(annualised, resolved.rates.employer_ni) / periods,
  );
  const employerPension = round2(
    annualEmployerPension(annualised, resolved.rates.employer_pension) / periods,
  );
  return {
    employer_ni_estimate: employerNi,
    employer_pension_estimate: employerPension,
    employment_cost_estimate: round2(gross + employerNi + employerPension),
    employer_rates_tax_year: resolved.applied_tax_year,
    employer_rates_extrapolated: resolved.extrapolated,
  };
}

/**
 * Employer costs for a stored line, honouring the employee's TRACKED pension
 * enrolment where one exists.
 *
 * IDENTICAL to `employerCostsForStoredLine` when `enrolment` is undefined — the
 * statutory-minimum estimate — so every existing, untracked line is unchanged
 * to the penny. When an enrolment row IS supplied the pension figure uses the
 * person's real status and scheme rate; employer NI is unaffected (NI does not
 * depend on pension state). Still an ESTIMATE — filing to a provider/HMRC is
 * external and out of scope.
 */
export function employerCostsForStoredLineWithPension(
  grossPay: number | string | null | undefined,
  cycle: "weekly" | "monthly",
  periodStartIso: string,
  enrolment?: PensionEnrolmentInput,
): EmployerCostEstimate {
  const gross = round2(Math.max(0, Number(grossPay ?? 0) || 0));
  const periods = periodsPerYear(cycle);
  const annualised = gross * periods;
  const resolved = resolveEmploymentCostRates(periodStartIso);
  const employerNi = round2(
    annualEmployerNi(annualised, resolved.rates.employer_ni) / periods,
  );
  const annualPension = enrolment
    ? annualEmployerPensionForEnrolment(
        annualised,
        resolved.rates.employer_pension,
        enrolment,
      )
    : annualEmployerPension(annualised, resolved.rates.employer_pension);
  const employerPension = round2(annualPension / periods);
  return {
    employer_ni_estimate: employerNi,
    employer_pension_estimate: employerPension,
    employment_cost_estimate: round2(gross + employerNi + employerPension),
    employer_rates_tax_year: resolved.applied_tax_year,
    employer_rates_extrapolated: resolved.extrapolated,
  };
}

// ---------------------------------------------------------------------------
// Employee-side fidelity — Scottish bands, student loan, pension, sacrifice
// ---------------------------------------------------------------------------

/**
 * The per-employee facts that refine an employee's deductions beyond the standard
 * 1257L / rest-of-UK / no-student-loan / no-pension base. Every field is OPTIONAL:
 * an absent field means "not applicable", and an entirely empty object reproduces
 * the base per-line figures exactly (see {@link computeEmployeeDeductionsForStoredLine}).
 */
export type EmployeeDeductionsInput = {
  /** Tax region. Absent ⇒ rest of UK (unchanged from the base calculation). */
  taxRegion?: TaxRegion;
  /** Student-loan plan. Absent ⇒ no student-loan deduction. */
  studentLoanPlan?: StudentLoanPlan;
  /**
   * Employee pension contribution rate as a FRACTION of qualifying earnings, e.g.
   * 0.05 for the statutory-minimum 5%. Modelled as a RELIEF-AT-SOURCE deduction:
   * taken from take-home pay, and NOT netted off taxable/NIable pay (the scheme
   * reclaims basic-rate relief into the pot separately). Absent/0 ⇒ no deduction.
   * For a NET-PAY-ARRANGEMENT or salary-sacrifice scheme, use `salarySacrificeAnnual`
   * instead, which reduces the tax/NI base.
   */
  employeePensionRate?: number;
  /**
   * Annual salary-sacrifice amount (£). Sacrificed pay is outside income tax AND NI,
   * so it reduces PAYE, employee NI, employer NI and take-home alike. Given as an
   * annual figure and apportioned to the period; clamped to the period gross.
   * Absent/0 ⇒ no sacrifice.
   */
  salarySacrificeAnnual?: number;
};

export type EmployeeDeductionsEstimate = {
  gross_pay: number;
  /** Salary sacrificed this period (already removed from the tax/NI base below). */
  salary_sacrifice: number;
  /** Pay subject to tax/NI this period — gross minus salary sacrifice. */
  taxable_pay: number;
  /** PAYE for the period, recomputed with the region + salary sacrifice applied. */
  paye_estimate: number;
  /** Employee NI for the period, recomputed with salary sacrifice applied. */
  ni_estimate: number;
  /** Student-loan repayment for the period (0 when no plan supplied). */
  student_loan_estimate: number;
  /** Employee pension contribution for the period (0 when no rate supplied). */
  employee_pension_estimate: number;
  /**
   * Take-home pay after ALL employee deductions:
   * gross − salary sacrifice − PAYE − employee NI − student loan − employee pension.
   */
  net_pay: number;
  /** The region actually applied (defaults to rest_of_uk). */
  tax_region: TaxRegion;
  /** The student-loan plan applied, or null. */
  student_loan_plan: StudentLoanPlan | null;
  /** The tax year whose published table produced these figures. */
  rates_tax_year: TaxYear;
  /** True when the period's tax year had no published table and rates were projected. */
  rates_extrapolated: boolean;
};

/**
 * Employee deductions for a payroll line that is ALREADY STORED, refined by the
 * employee's per-employee facts.
 *
 * The companion to {@link employerCostsForStoredLine} on the EMPLOYEE side: a pure
 * derivation from the stored `gross_pay` + the run's `cycle`/`period_start`, so it
 * is the single place every read site goes through and no second figure is persisted.
 *
 * BACKWARD COMPATIBLE BY CONSTRUCTION: with an empty `inputs` the region is
 * rest-of-UK, there is no student loan, no pension and no sacrifice, so `paye_estimate`,
 * `ni_estimate` and `net_pay` equal exactly what `computePayrollLine` stored. A
 * regression test pins this.
 *
 * `periodStartIso` MUST be the run's own `period_start` — never today — so a finalised
 * run stays priced at the rates in force when it ran.
 */
export function computeEmployeeDeductionsForStoredLine(
  grossPay: number | string | null | undefined,
  cycle: "weekly" | "monthly",
  periodStartIso: string,
  inputs: EmployeeDeductionsInput = {},
): EmployeeDeductionsEstimate {
  const gross = round2(Math.max(0, Number(grossPay ?? 0) || 0));
  const periods = periodsPerYear(cycle);
  const resolved = resolveEmploymentCostRates(periodStartIso);

  const region: TaxRegion = inputs.taxRegion ?? "rest_of_uk";
  const plan = inputs.studentLoanPlan ?? null;

  // Salary sacrifice: annual → period, clamped to [0, gross]. Sacrificed pay leaves
  // the tax/NI base entirely.
  const sacrificeAnnual = Math.max(0, Number(inputs.salarySacrificeAnnual ?? 0) || 0);
  const sacrificePeriod = round2(Math.min(gross, sacrificeAnnual / periods));
  const taxablePeriod = round2(Math.max(0, gross - sacrificePeriod));
  const annualBase = taxablePeriod * periods;

  const annualTax =
    region === "scotland"
      ? annualScottishIncomeTax(annualBase, resolved.rates.scottish_income_tax)
      : annualIncomeTax(annualBase);
  const payeEstimate = round2(annualTax / periods);
  const niEstimate = round2(annualEmployeeNi(annualBase) / periods);

  const studentLoan = plan
    ? round2(annualStudentLoan(annualBase, plan, resolved.rates.student_loan) / periods)
    : 0;

  // Employee pension (relief at source): rate × qualifying earnings, from take-home.
  const pensionRate = Math.max(0, Number(inputs.employeePensionRate ?? 0) || 0);
  let employeePension = 0;
  if (pensionRate > 0) {
    const pr = resolved.rates.employer_pension;
    const qualifying =
      Math.min(annualBase, pr.qualifying_earnings_upper_annual) -
      pr.qualifying_earnings_lower_annual;
    if (qualifying > 0) employeePension = round2((qualifying * pensionRate) / periods);
  }

  const netPay = round2(
    gross - sacrificePeriod - payeEstimate - niEstimate - studentLoan - employeePension,
  );

  return {
    gross_pay: gross,
    salary_sacrifice: sacrificePeriod,
    taxable_pay: taxablePeriod,
    paye_estimate: payeEstimate,
    ni_estimate: niEstimate,
    student_loan_estimate: studentLoan,
    employee_pension_estimate: employeePension,
    net_pay: netPay,
    tax_region: region,
    student_loan_plan: plan,
    rates_tax_year: resolved.applied_tax_year,
    rates_extrapolated: resolved.extrapolated,
  };
}

/**
 * A stored `payroll_tax_profiles` row (or the subset we read), as it comes back from
 * the DB — text/numeric fields possibly string-encoded.
 */
export type StoredPayrollTaxProfile = {
  tax_region?: string | null;
  student_loan_plan?: string | null;
  salary_sacrifice_annual_pence?: number | string | null;
};

/**
 * Translate a stored per-employee tax profile into calculator inputs.
 *
 * The single mapping point from persisted config → {@link EmployeeDeductionsInput}, so
 * the page and the tests apply exactly the same rules. Defaults collapse to an EMPTY
 * input (rest-of-UK, no plan, no sacrifice) so an absent/defaulted profile reproduces
 * the base figures — the whole point of the backward-compatibility guarantee. Salary
 * sacrifice is stored as annual PENCE and converted to the £ amount the calculator
 * expects.
 */
export function employeeInputFromStoredProfile(
  profile: StoredPayrollTaxProfile | null | undefined,
): EmployeeDeductionsInput {
  if (!profile) return {};
  const input: EmployeeDeductionsInput = {};
  if (profile.tax_region === "scotland") input.taxRegion = "scotland";
  const plan = profile.student_loan_plan;
  if (
    plan === "plan_1" ||
    plan === "plan_2" ||
    plan === "plan_4" ||
    plan === "postgraduate"
  ) {
    input.studentLoanPlan = plan;
  }
  const pence = Math.max(0, Number(profile.salary_sacrifice_annual_pence ?? 0) || 0);
  if (pence > 0) input.salarySacrificeAnnual = pence / 100;
  return input;
}

// ---------------------------------------------------------------------------
// Employment Allowance — org-level employer-NI offset
// ---------------------------------------------------------------------------

export type EmploymentAllowanceRelief = {
  /** Employer NI for the run BEFORE any allowance. */
  employer_ni_before: number;
  /** The published annual Employment Allowance cap for the period's tax year. */
  allowance_annual: number;
  /**
   * Relief available against THIS run — min(employer NI this run, annual cap). An
   * "up to" figure: the allowance is an ANNUAL org-level offset and we do not track
   * year-to-date consumption, so a later run in the same year may find it exhausted.
   */
  relief_this_run: number;
  /** Employer NI for the run AFTER the (up-to) relief. */
  employer_ni_after: number;
  rates_tax_year: TaxYear;
  rates_extrapolated: boolean;
};

/**
 * Employment Allowance relief against a run's employer NI.
 *
 * The allowance is an ORG-LEVEL annual offset (up to £10,500 for 2025-26/2026-27)
 * available to eligible employers against their secondary Class 1 NI bill. It cannot
 * be apportioned to a single line, and we do not hold the org's YTD employer-NI
 * consumption, so this returns an "up to" estimate for the run: it caps relief at the
 * lesser of the run's employer NI and the annual allowance. The UI presents it
 * conditionally ("if your org is eligible and the allowance is not yet used up").
 */
export function employmentAllowanceReliefForRun(
  runEmployerNi: number,
  periodStartIso: string,
): EmploymentAllowanceRelief {
  const before = round2(Math.max(0, runEmployerNi));
  const resolved = resolveEmploymentCostRates(periodStartIso);
  const cap = resolved.rates.employer_ni.employment_allowance_annual;
  const relief = round2(Math.min(before, cap));
  return {
    employer_ni_before: before,
    allowance_annual: cap,
    relief_this_run: relief,
    employer_ni_after: round2(before - relief),
    rates_tax_year: resolved.applied_tax_year,
    rates_extrapolated: resolved.extrapolated,
  };
}

// ---------------------------------------------------------------------------
// Job costing — employer on-costs as labour
// ---------------------------------------------------------------------------

/** A (user, job, hours) slice of time, the same shape job costing already uses. */
export type LabourOnCostEntry = {
  job_id: string | null;
  user_id: string;
  hours: number;
};

/**
 * A finance-row-shaped employer on-cost. `category: "labour"` is what makes
 * `mapToCostBucket` drop it into the labour bucket with no bespoke wiring.
 */
export type LabourOnCostRow = {
  job_id: string;
  amount: number;
  category: "labour";
};

/**
 * Employer on-costs (employer NI + employer pension) attributed to jobs, so the
 * `labour` cost bucket reflects the TRUE cost of employment rather than gross pay.
 *
 * This is the companion to `labourCostsFromTimeEntries` (`@/lib/profitability`),
 * which contributes the GROSS half. Emitting separate rows tagged `labour` — rather
 * than inflating the gross rows — keeps the gross figure honest and auditable while
 * the bucket total becomes correct.
 *
 * ── WHY THIS CANNOT BE DONE PER JOB ────────────────────────────────────────
 * Employer NI is BANDED: nil up to the Secondary Threshold, then 15%. Banding is not
 * linear, so it must be computed ONCE on the worker's whole-period earnings and then
 * split across their jobs. Computing it per job would hand every job its own £5,000
 * threshold — a worker split across three jobs would appear to attract almost no
 * employer NI at all, understating labour cost by the full 15% of three thresholds.
 * So: band on the total, then apportion by hours.
 *
 * Hours with no `job_id` still count toward the banding total (they are real
 * earnings that consume the threshold) but receive no attribution — that share is
 * overhead, not direct job cost, and is simply not charged to any job.
 *
 * The split uses `apportion` from `@/lib/money`, so the per-job amounts sum to
 * EXACTLY the on-cost charged to jobs — no lost or invented pennies.
 */
export function employerOnCostsFromTimeEntries(
  entries: LabourOnCostEntry[],
  hourlyRateByUser: Map<string, number>,
  cycle: "weekly" | "monthly",
  /** The period's own start date, so the correct dated rate table is applied. */
  periodStartIso?: string,
): LabourOnCostRow[] {
  // Group by worker: employer NI bands on the person, not on the job.
  const byUser = new Map<string, { jobHours: Map<string, number>; unattributed: number }>();
  for (const e of entries) {
    if (!Number.isFinite(e.hours) || e.hours <= 0) continue;
    let bucket = byUser.get(e.user_id);
    if (!bucket) {
      bucket = { jobHours: new Map(), unattributed: 0 };
      byUser.set(e.user_id, bucket);
    }
    if (e.job_id) {
      bucket.jobHours.set(e.job_id, (bucket.jobHours.get(e.job_id) ?? 0) + e.hours);
    } else {
      bucket.unattributed += e.hours;
    }
  }

  const out: LabourOnCostRow[] = [];
  for (const [userId, bucket] of byUser) {
    const rate = hourlyRateByUser.get(userId) ?? 0;
    if (rate <= 0) continue;
    const jobIds = Array.from(bucket.jobHours.keys());
    if (jobIds.length === 0) continue; // nothing to attribute
    const jobHourValues = jobIds.map((id) => bucket.jobHours.get(id) ?? 0);
    const totalHours =
      jobHourValues.reduce((a, b) => a + b, 0) + bucket.unattributed;
    if (totalHours <= 0) continue;

    const line = computePayrollLine(totalHours, rate, cycle, periodStartIso);
    const onCost = round2(line.employer_ni_estimate + line.employer_pension_estimate);
    if (onCost <= 0) continue;

    // Apportion across job hours PLUS the unattributed remainder, then drop the
    // remainder — penny-exact for the part that reaches jobs.
    const weights = [...jobHourValues, bucket.unattributed];
    const parts = apportion(onCost, weights);
    for (let i = 0; i < jobIds.length; i++) {
      const amount = parts[i] ?? 0;
      if (amount <= 0) continue;
      out.push({ job_id: jobIds[i] as string, amount, category: "labour" });
    }
  }
  return out;
}

/** Default period start/end for a given cycle and date. */
export function defaultPeriod(
  cycle: "weekly" | "monthly",
  now: Date = new Date(),
): { period_start: string; period_end: string } {
  if (cycle === "weekly") {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const day = d.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - offset);
    const start = d.toISOString().slice(0, 10);
    const endD = new Date(d.getTime());
    endD.setUTCDate(endD.getUTCDate() + 6);
    return { period_start: start, period_end: endD.toISOString().slice(0, 10) };
  }
  // Monthly — current calendar month.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

/**
 * Renders a payroll-line array as a CSV (HMRC-friendly column order).
 *
 * Every field is quoted through the shared `csvEscape` (`@/lib/csv`) — the
 * one authoritative CSV escaper — so a comma-bearing name (or any other
 * value) can never break the column layout, and payroll carries no escaper
 * of its own.
 */
export function payrollCsv(
  rows: Array<{
    full_name: string;
    ni_number: string | null;
    hours: number;
    hourly_pay: number;
    gross_pay: number;
    paye_estimate: number;
    ni_estimate: number;
    net_pay: number;
    /**
     * Employer-side costs. REQUIRED, not optional: an accountant reading this file
     * must never be handed a payroll export whose employer NI silently defaulted to
     * zero, so the call site is forced to supply it via
     * `employerCostsForStoredLine`.
     */
    employer_ni_estimate: number;
    employer_pension_estimate: number;
    employment_cost_estimate: number;
  }>,
  period: { period_start: string; period_end: string; cycle: string },
): string {
  const header = [
    "Period start",
    "Period end",
    "Cycle",
    "Name",
    "NI number",
    "Hours",
    "Hourly pay",
    "Gross pay",
    "PAYE est",
    "Employee NI est",
    "Net pay",
    "Employer NI est",
    "Employer pension est",
    "Total employment cost est",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        period.period_start,
        period.period_end,
        period.cycle,
        r.full_name,
        r.ni_number ?? "",
        r.hours.toFixed(2),
        r.hourly_pay.toFixed(2),
        r.gross_pay.toFixed(2),
        r.paye_estimate.toFixed(2),
        r.ni_estimate.toFixed(2),
        r.net_pay.toFixed(2),
        r.employer_ni_estimate.toFixed(2),
        r.employer_pension_estimate.toFixed(2),
        r.employment_cost_estimate.toFixed(2),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}
