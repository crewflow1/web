/**
 * Employer-cost rate tables — DATED, SOURCED, and the only place these numbers live.
 *
 * PURE. No Supabase, no `server-only`, no clock reads, no I/O — the caller supplies
 * the date, so behaviour is deterministic and testable. Mirrors the house rule set by
 * `lib/cis/verification.ts` + `docs/cis-domain.md`: nothing here may encode a tax rule
 * that is not written down in `docs/payroll-employer-costs.md` with a source URL and
 * the date it was retrieved.
 *
 * ── WHY A TABLE AND NOT CONSTANTS ────────────────────────────────────────────
 * UK employer rates change every April, and they HAVE changed inside the window this
 * app already covers: the secondary (employer) NI rate went 13.8% → 15% and the
 * secondary threshold £9,100 → £5,000 on 6 April 2025. A single set of inline
 * constants is therefore a bug with a delivery date — it silently re-prices every
 * historical payroll run each 6 April. Rates are keyed by UK tax year and resolved
 * from the payroll period's OWN start date, so a finalised run keeps the figures that
 * were in force when it ran, forever.
 *
 * This file ESTABLISHES that precedent. There was none: `lib/payroll/compute.ts` and
 * `lib/tax/compute.ts` both held undated inline constants (see the report), and
 * `lib/cis/**` needed no dating because CIS deduction rates are not annual.
 *
 * ── ESTIMATES, NOT A FILED PAYROLL ──────────────────────────────────────────
 * Every figure derived from this table is an ESTIMATE of the cost of employment. It
 * is not an RTI/FPS submission and not a payroll filing. The `_estimate` suffix on
 * every consuming field is deliberate and load-bearing — see `lib/payroll/compute.ts`.
 */

/** A UK tax year, `YYYY-YY`, starting 6 April of the first year. e.g. `2026-27`. */
export type TaxYear = string;

export type EmployerNiRates = {
  /**
   * Secondary Class 1 rate, as a fraction. Applies to category letters A, B, C and J
   * (the standard cases). Reduced-rate categories are NOT modelled — see
   * `NOT_MODELLED` below.
   */
  rate: number;
  /** Annual Secondary Threshold — employer NI is due on earnings ABOVE this. */
  secondary_threshold_annual: number;
  /**
   * Annual Upper Secondary Threshold for under-21s, apprentices under 25 and
   * veterans: below it their employer rate is 0%. Recorded for documentation and to
   * make the size of the un-modelled relief computable — NEVER applied, because the
   * schema carries no date of birth, apprentice flag or veteran flag.
   */
  upper_secondary_threshold_annual: number;
  /**
   * Annual Employment Allowance — an ORG-LEVEL annual offset against the employer NI
   * bill, not a per-employee one. Recorded, NEVER applied: applying it needs
   * org-wide cumulative year-to-date state that this codebase does not have.
   */
  employment_allowance_annual: number;
};

export type EmployerPensionRates = {
  /** Statutory minimum EMPLOYER contribution, as a fraction of qualifying earnings. */
  minimum_employer_rate: number;
  /** Lower limit of the qualifying earnings band (annual). */
  qualifying_earnings_lower_annual: number;
  /** Upper limit of the qualifying earnings band (annual). */
  qualifying_earnings_upper_annual: number;
  /**
   * Annual automatic-enrolment earnings trigger. Below this an employer has no
   * automatic-enrolment DUTY, so we charge no employer pension cost.
   */
  earnings_trigger_annual: number;
};

/**
 * Which income-tax regime an employee's non-savings income is taxed under.
 *
 * The UK personal allowance and the whole of NI are UK-wide, but INCOME TAX bands
 * and rates diverge: Scotland sets its own (six bands vs England/Wales/NI's three).
 * Which one applies is a per-employee fact (their tax code carries an `S` prefix),
 * so it is an INPUT, never a rule baked into the calculator.
 */
export type TaxRegion = "rest_of_uk" | "scotland";

/**
 * A UK student-loan repayment plan. Each has its OWN annual threshold and, for the
 * postgraduate loan, its own rate. A borrower can be on a main plan AND the
 * postgraduate loan at once in real life; we model a single selected plan per
 * employee, which is the common case and all the schema could ever carry.
 *
 * Plan 5 is the post-2023 undergraduate plan for English/Welsh students who started
 * their course on or after 1 August 2023; repayments began on 6 April 2026 (the
 * 2026-27 tax year) at 9% above a £25,000 threshold.
 */
export type StudentLoanPlan =
  | "plan_1"
  | "plan_2"
  | "plan_4"
  | "plan_5"
  | "postgraduate";

export type StudentLoanPlanRate = {
  /** Annual repayment threshold — 9% (or 6% postgrad) is due on earnings ABOVE this. */
  threshold_annual: number;
  /** Repayment rate as a fraction of earnings above the threshold. */
  rate: number;
};

/** All four plans for one tax year. */
export type StudentLoanRates = Record<StudentLoanPlan, StudentLoanPlanRate>;

/**
 * One slice of the Scottish income-tax scale. `upto` is the CUMULATIVE annual
 * income at which the band ends (not the band width); the last band uses
 * `Number.POSITIVE_INFINITY`. Rates apply to income ABOVE the personal allowance.
 */
export type ScottishBand = {
  /** Cumulative annual income at the top of this band. Infinity for the top band. */
  upto: number;
  /** Marginal rate for income in this band, as a fraction. */
  rate: number;
};

export type ScottishIncomeTaxRates = {
  /** UK-wide personal allowance (Scotland uses the same PA, only the bands differ). */
  personal_allowance: number;
  /** Bands from the personal allowance upward, lowest first. */
  bands: readonly ScottishBand[];
};

export type EmploymentCostRates = {
  tax_year: TaxYear;
  employer_ni: EmployerNiRates;
  employer_pension: EmployerPensionRates;
  /** Employee student-loan repayment thresholds/rates by plan. */
  student_loan: StudentLoanRates;
  /** Scottish income-tax scale (applied only when an employee's region is Scotland). */
  scottish_income_tax: ScottishIncomeTaxRates;
};

/**
 * The rate tables.
 *
 * Sources are recorded in `docs/payroll-employer-costs.md` with retrieval dates. The
 * per-year comments below cite the tax year each figure applies to, as required.
 *
 * NOTE the 2024-25 → 2025-26 step change: it is the reason this file is a dated table
 * rather than a set of constants, and the regression test pins it.
 */
const RATE_TABLES: Readonly<Record<TaxYear, EmploymentCostRates>> = {
  // ── Tax year 2024-25 (6 Apr 2024 – 5 Apr 2025) ────────────────────────────
  // Employer NI: 13.8% above a £9,100 Secondary Threshold — the PRE-April-2025
  // regime. Retained so a back-dated period is priced with the rates that actually
  // applied, and so the step change to 2025-26 is visible and tested.
  "2024-25": {
    tax_year: "2024-25",
    employer_ni: {
      rate: 0.138, // 13.8% — secondary Class 1, tax year 2024-25
      secondary_threshold_annual: 9_100, // tax year 2024-25
      upper_secondary_threshold_annual: 50_270, // under-21/apprentice/veteran, 2024-25
      employment_allowance_annual: 5_000, // tax year 2024-25 (pre-Autumn-Budget-2024)
    },
    employer_pension: {
      minimum_employer_rate: 0.03, // 3% employer minimum, tax year 2024-25
      qualifying_earnings_lower_annual: 6_240, // tax year 2024-25
      qualifying_earnings_upper_annual: 50_270, // tax year 2024-25
      earnings_trigger_annual: 10_000, // tax year 2024-25
    },
    // Student-loan repayment thresholds, tax year 2024-25. Rate is 9% for the
    // income-contingent plans (1/2/4) and 6% for the postgraduate loan, on
    // earnings above the plan threshold. See docs/payroll-employer-costs.md.
    student_loan: {
      plan_1: { threshold_annual: 24_990, rate: 0.09 }, // 2024-25
      plan_2: { threshold_annual: 27_295, rate: 0.09 }, // 2024-25
      plan_4: { threshold_annual: 31_395, rate: 0.09 }, // 2024-25 (Scotland-domiciled)
      // Plan 5 repayments did NOT start until 6 Apr 2026; carried at its statutory
      // £25,000 threshold for type completeness — no Plan 5 borrower repays in 2024-25.
      plan_5: { threshold_annual: 25_000, rate: 0.09 }, // 2024-25 (not yet in force)
      postgraduate: { threshold_annual: 21_000, rate: 0.06 }, // 2024-25
    },
    // Scottish income-tax scale, tax year 2024-25 (same £12,570 PA as rUK; six
    // bands where rUK has three). Applied only for employees whose region is
    // Scotland. See docs/payroll-employer-costs.md.
    scottish_income_tax: {
      personal_allowance: 12_570, // 2024-25 (UK-wide PA)
      bands: [
        { upto: 14_876, rate: 0.19 }, // starter, 2024-25
        { upto: 26_561, rate: 0.2 }, // basic, 2024-25
        { upto: 43_662, rate: 0.21 }, // intermediate, 2024-25
        { upto: 75_000, rate: 0.42 }, // higher, 2024-25
        { upto: 125_140, rate: 0.45 }, // advanced, 2024-25
        { upto: Number.POSITIVE_INFINITY, rate: 0.48 }, // top, 2024-25
      ],
    },
  },

  // ── Tax year 2025-26 (6 Apr 2025 – 5 Apr 2026) ────────────────────────────
  // Autumn Budget 2024 took the secondary rate to 15% and CUT the Secondary
  // Threshold to £5,000 from 6 April 2025 — employer NI rose sharply on low pay.
  "2025-26": {
    tax_year: "2025-26",
    employer_ni: {
      rate: 0.15, // 15% — secondary Class 1, tax year 2025-26
      secondary_threshold_annual: 5_000, // tax year 2025-26 (cut from £9,100)
      upper_secondary_threshold_annual: 50_270, // under-21/apprentice/veteran, 2025-26
      employment_allowance_annual: 10_500, // tax year 2025-26 (raised from £5,000)
    },
    employer_pension: {
      minimum_employer_rate: 0.03, // 3% employer minimum, tax year 2025-26
      qualifying_earnings_lower_annual: 6_240, // tax year 2025-26 (frozen)
      qualifying_earnings_upper_annual: 50_270, // tax year 2025-26 (frozen)
      earnings_trigger_annual: 10_000, // tax year 2025-26 (frozen)
    },
    // Student-loan repayment thresholds, tax year 2025-26 (all raised from 2024-25;
    // postgraduate threshold frozen at £21,000). See docs/payroll-employer-costs.md.
    student_loan: {
      plan_1: { threshold_annual: 26_065, rate: 0.09 }, // 2025-26
      plan_2: { threshold_annual: 28_470, rate: 0.09 }, // 2025-26
      plan_4: { threshold_annual: 32_745, rate: 0.09 }, // 2025-26 (Scotland-domiciled)
      // Plan 5 repayments start 6 Apr 2026; carried at £25,000 for type completeness
      // — no Plan 5 borrower repays in 2025-26.
      plan_5: { threshold_annual: 25_000, rate: 0.09 }, // 2025-26 (not yet in force)
      postgraduate: { threshold_annual: 21_000, rate: 0.06 }, // 2025-26 (frozen)
    },
    // Scottish income-tax scale, tax year 2025-26 (starter/basic band tops raised;
    // rates unchanged from 2024-25). See docs/payroll-employer-costs.md.
    scottish_income_tax: {
      personal_allowance: 12_570, // 2025-26 (UK-wide PA)
      bands: [
        { upto: 15_397, rate: 0.19 }, // starter, 2025-26
        { upto: 27_491, rate: 0.2 }, // basic, 2025-26
        { upto: 43_662, rate: 0.21 }, // intermediate, 2025-26
        { upto: 75_000, rate: 0.42 }, // higher, 2025-26
        { upto: 125_140, rate: 0.45 }, // advanced, 2025-26
        { upto: Number.POSITIVE_INFINITY, rate: 0.48 }, // top, 2025-26
      ],
    },
  },

  // ── Tax year 2026-27 (6 Apr 2026 – 5 Apr 2027) — CURRENT ──────────────────
  // Employer NI unchanged from 2025-26: 15% above £5,000. Thresholds are frozen.
  // Auto-enrolment thresholds confirmed unchanged for 2026-27 by the DWP review.
  // CAUTION for whoever updates this next: an automated read of the GOV.UK
  // employer-rates page conflated the PRIMARY threshold (£12,570) with the
  // SECONDARY threshold (£5,000). They are different numbers and the difference is
  // worth £1,135.50 per employee per year. Read the threshold TABLE row by row.
  "2026-27": {
    tax_year: "2026-27",
    employer_ni: {
      rate: 0.15, // 15% — secondary Class 1, tax year 2026-27
      secondary_threshold_annual: 5_000, // tax year 2026-27 (£96/wk, £417/mo)
      upper_secondary_threshold_annual: 50_270, // under-21/apprentice/veteran, 2026-27
      employment_allowance_annual: 10_500, // tax year 2026-27
    },
    employer_pension: {
      minimum_employer_rate: 0.03, // 3% employer minimum, tax year 2026-27
      qualifying_earnings_lower_annual: 6_240, // tax year 2026-27 (frozen)
      qualifying_earnings_upper_annual: 50_270, // tax year 2026-27 (frozen)
      earnings_trigger_annual: 10_000, // tax year 2026-27 (frozen)
    },
    // Student loan, tax year 2026-27. CAUTION: at the source-retrieval date HMRC had
    // NOT yet published 2026-27 student-loan thresholds, so the 2025-26 figures are
    // CARRIED FORWARD unchanged (postgraduate is frozen regardless). This is a
    // deliberate, flagged carry-forward, not a verified figure — update the moment
    // the 2026-27 thresholds are confirmed. The estimate label covers the gap.
    student_loan: {
      plan_1: { threshold_annual: 26_065, rate: 0.09 }, // 2026-27 (carried from 2025-26 — unconfirmed)
      plan_2: { threshold_annual: 28_470, rate: 0.09 }, // 2026-27 (carried from 2025-26 — unconfirmed)
      plan_4: { threshold_annual: 32_745, rate: 0.09 }, // 2026-27 (carried from 2025-26 — unconfirmed)
      // Plan 5 — LIVE from 6 Apr 2026 (this tax year): 9% above £25,000. See
      // docs/payroll-employer-costs.md.
      plan_5: { threshold_annual: 25_000, rate: 0.09 }, // 2026-27 (first repayments)
      postgraduate: { threshold_annual: 21_000, rate: 0.06 }, // 2026-27 (frozen)
    },
    // Scottish income tax, tax year 2026-27. CAUTION: the 2026-27 Scottish Budget
    // bands were not confirmed at the source-retrieval date, so 2025-26 bands are
    // CARRIED FORWARD. Flagged, not verified — update once the Scottish Budget lands.
    scottish_income_tax: {
      personal_allowance: 12_570, // 2026-27 (UK-wide PA, frozen)
      bands: [
        { upto: 15_397, rate: 0.19 }, // starter, 2026-27 (carried from 2025-26)
        { upto: 27_491, rate: 0.2 }, // basic, 2026-27 (carried from 2025-26)
        { upto: 43_662, rate: 0.21 }, // intermediate, 2026-27 (carried from 2025-26)
        { upto: 75_000, rate: 0.42 }, // higher, 2026-27 (carried from 2025-26)
        { upto: 125_140, rate: 0.45 }, // advanced, 2026-27 (carried from 2025-26)
        { upto: Number.POSITIVE_INFINITY, rate: 0.48 }, // top, 2026-27 (carried from 2025-26)
      ],
    },
  },
} as const;

/** Every tax year we hold a published table for, oldest first. */
export const PUBLISHED_TAX_YEARS: readonly TaxYear[] = Object.keys(RATE_TABLES).sort();

/** The newest tax year we hold a published table for. */
export const LATEST_PUBLISHED_TAX_YEAR: TaxYear =
  PUBLISHED_TAX_YEARS[PUBLISHED_TAX_YEARS.length - 1] as TaxYear;

/**
 * The UK tax year containing `iso` (a `YYYY-MM-DD` date).
 *
 * The UK tax year runs 6 April → 5 April, so 2026-04-05 is still `2025-26` while
 * 2026-04-06 is `2026-27`. Parsed by string, not `Date`, so a host timezone can
 * never shift the boundary by a day.
 */
export function taxYearForDate(iso: string): TaxYear {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return LATEST_PUBLISHED_TAX_YEAR;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Before 6 April the date belongs to the tax year that began the previous April.
  const startYear = month < 4 || (month === 4 && day < 6) ? year - 1 : year;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export type ResolvedEmploymentCostRates = {
  rates: EmploymentCostRates;
  /** The tax year whose table was actually APPLIED. */
  applied_tax_year: TaxYear;
  /** The tax year the caller's date fell in — differs from applied when extrapolated. */
  requested_tax_year: TaxYear;
  /**
   * True when we had no published table for `requested_tax_year` and fell back to the
   * nearest one. The figures are then a projection, not published rates, and the UI
   * must say so. We deliberately do NOT throw: refusing would break payroll every
   * 6 April until someone ships a table, and a flagged estimate beats no payroll.
   * Silent staleness is the one outcome that is never acceptable.
   */
  extrapolated: boolean;
};

/**
 * Resolve the employer-cost rates in force for a payroll period.
 *
 * `periodStartIso` is the period's OWN start date — never "today" — so a finalised
 * run is always re-derivable at the rates that applied when it ran. Omitting it uses
 * the latest published table; real callers always pass the date, and the omission is
 * a convenience for pure-arithmetic unit tests.
 */
export function resolveEmploymentCostRates(
  periodStartIso?: string,
): ResolvedEmploymentCostRates {
  if (!periodStartIso) {
    const latest = RATE_TABLES[LATEST_PUBLISHED_TAX_YEAR] as EmploymentCostRates;
    return {
      rates: latest,
      applied_tax_year: LATEST_PUBLISHED_TAX_YEAR,
      requested_tax_year: LATEST_PUBLISHED_TAX_YEAR,
      extrapolated: false,
    };
  }
  const requested = taxYearForDate(periodStartIso);
  const exact = RATE_TABLES[requested];
  if (exact) {
    return {
      rates: exact,
      applied_tax_year: requested,
      requested_tax_year: requested,
      extrapolated: false,
    };
  }
  // No published table. Clamp to the nearest edge of what we do hold: a future year
  // uses the latest table, a pre-history date uses the earliest.
  const applied =
    requested > LATEST_PUBLISHED_TAX_YEAR
      ? LATEST_PUBLISHED_TAX_YEAR
      : (PUBLISHED_TAX_YEARS[0] as TaxYear);
  return {
    rates: RATE_TABLES[applied] as EmploymentCostRates,
    applied_tax_year: applied,
    requested_tax_year: requested,
    extrapolated: true,
  };
}

/**
 * What this estimator deliberately does NOT model, and which way each omission
 * pushes the error. Exported so the UI and the report speak from ONE list rather
 * than drifting copies. Each entry names the direction of the resulting error on
 * EMPLOYER COST (and therefore the opposite direction on job margin).
 *
 * Nothing here is approximated. Every item is omitted outright, because the inputs
 * it needs (date of birth, opt-out status, scheme definition, org-level cumulatives)
 * do not exist in the schema. A guessed category would be worse than a loud gap.
 */
export const NOT_MODELLED: readonly {
  item: string;
  needs: string;
  effect: "overstates_employer_cost" | "understates_employer_cost" | "either_direction";
  detail: string;
}[] = [
  {
    item: "Employment Allowance",
    needs: "org-level cumulative year-to-date employer NI, and an eligibility flag",
    effect: "overstates_employer_cost",
    detail:
      "An eligible employer offsets up to £10,500 of employer NI per YEAR (2025-26 and 2026-27). It is an org-level allowance consumed across all employees, so it cannot be apportioned to one line. Employer NI is therefore overstated by up to £10,500/year for an eligible org — the largest single omission here.",
  },
  {
    item: "Under-21, apprentice-under-25 and veteran NI categories (only when the letter is NOT recorded)",
    needs: "the NI category letter recorded on the employee's payroll tax profile",
    effect: "overstates_employer_cost",
    detail:
      "Categories H, M, V and Z pay 0% employer NI up to the Upper Secondary Threshold (£50,270). CrewFlow NOW applies this whenever the category letter is recorded on the employee's tax profile (via annualEmployerNiForCategory). It is only overstated for a qualifying employee whose letter has NOT been set — the default is 'A' (standard rate), so employer NI is overstated by up to the standard rate on earnings between the secondary and upper secondary thresholds until the correct letter is recorded.",
  },
  {
    item: "Directors' cumulative (annual-basis) NI",
    needs: "a director flag and year-to-date cumulative earnings",
    effect: "either_direction",
    detail:
      "Directors are assessed on an annual cumulative basis, not per pay period. Annualising a single irregular period misprices them in either direction — badly, for a director paid in one lump.",
  },
  {
    item: "Salary sacrifice",
    needs: "a sacrifice amount per employee",
    effect: "overstates_employer_cost",
    detail:
      "Sacrificed pay is outside both NI and the pension basis. With none modelled, employer NI is overstated for anyone actually sacrificing (and their pension basis is misstated).",
  },
  {
    item: "Pension opt-out, age eligibility and postponement",
    needs: "date of birth, opt-out state, postponement dates",
    effect: "overstates_employer_cost",
    detail:
      "Automatic enrolment applies to eligible jobholders aged 22 to State Pension age. We charge the 3% employer minimum to everyone over the earnings trigger, so pension cost is overstated for opted-out staff and for those outside the age band.",
  },
  {
    item: "Opted-in workers below the earnings trigger",
    needs: "opt-in state per employee",
    effect: "understates_employer_cost",
    detail:
      "A non-eligible jobholder earning under £10,000 who opts IN must still receive employer contributions. We charge nothing below the trigger, so cost is understated for them. This is the ONE omission that understates.",
  },
  {
    item: "Scheme definitions other than statutory qualifying earnings",
    needs: "the employer's scheme basis",
    effect: "either_direction",
    detail:
      "Many schemes certify on basic pay or total earnings rather than the £6,240–£50,270 qualifying-earnings band. A scheme contributing 3% of FULL pay costs more than modelled; a banded scheme matches.",
  },
  {
    item: "Statutory payments, Apprenticeship Levy, Class 1A on benefits",
    needs: "SMP/SSP records, an annual pay bill, a P11D benefit set",
    effect: "understates_employer_cost",
    detail:
      "The Apprenticeship Levy (0.5% above a £3m pay bill) and Class 1A NI on benefits in kind are real employer costs not modelled. Both are nil for a typical small contractor, which is why they are omitted rather than approximated.",
  },
  {
    item: "Pro-rated qualifying-earnings bands published by DWP",
    needs: "nothing — a deliberate methodology choice",
    effect: "either_direction",
    detail:
      "DWP publishes rounded per-period bands (£120/£967 weekly, £520/£4,189 monthly). We annualise and divide back, matching how this file already handles PAYE and employee NI, rather than introducing a second methodology. The divergence is sub-penny per period.",
  },
] as const;
