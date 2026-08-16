# Employer cost of employment (verified against HMRC / GOV.UK / DWP)

This document records the **employer-side payroll rules CrewFlow implements**, each traced to an
authoritative source with the URL and the date it was retrieved. It is the companion to
[`docs/cis-domain.md`](./cis-domain.md) and follows the same house rule.

> **Rule of the house:** nothing in `lib/payroll/rates.ts` may encode a rate or threshold that is
> not written down here with a source. Where we could not verify a figure, or chose not to model a
> rule, this document says so explicitly and states the direction of the resulting error. We never
> silently invent tax semantics, and we never approximate a category we cannot do properly.

**Sources retrieved: 30 July 2026.** The GOV.UK employer rates page was last updated 5 June 2026.

---

## 0. Why this exists

Payroll computed gross pay, PAYE and **employee** NI, but no employer costs at all. Employer
secondary Class 1 NI and the automatic-enrolment employer pension contribution are real costs of
employing someone. Because they were missing from the `labour` cost bucket, **gross profit and
margin were overstated on every job with direct labour** — CrewFlow was telling contractors they
were more profitable than they are.

These figures are **estimates**, not a filed payroll. There is no RTI/FPS submission here.

---

## 1. Employer (secondary) Class 1 National Insurance

Employers pay secondary contributions on earnings above the **Secondary Threshold**. Unlike
employee NI there is **no upper limit** — the rate does not taper.

| Tax year | Rate | Secondary Threshold (annual) |
| --- | --- | --- |
| 2024-25 | **13.8%** | **£9,100** |
| 2025-26 | **15%** | **£5,000** |
| 2026-27 | **15%** | **£5,000** |

The 6 April 2025 step change (rate up, threshold sharply down) was announced at Autumn Budget 2024.
**It is the reason these rates live in a dated table rather than as inline constants** — a single
set of constants silently re-prices every historical payroll run each 6 April.

For 2026-27 the GOV.UK "Class 1 National Insurance thresholds" table gives the Secondary Threshold
as "£96 per week", "£417 per month", "£5,000 per year", and the secondary rate for category letters
A, B, C and J as 15%.

> ⚠️ **Trap for whoever updates this next.** An automated read of the GOV.UK employer-rates page
> conflated the **Primary** Threshold (£12,570 — the employee's) with the **Secondary** Threshold
> (£5,000 — the employer's). They are different numbers and the difference is worth **£1,135.50 per
> employee per year**. Read the threshold table row by row and check the row label.

- <https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027> — retrieved 2026-07-30 (page "Last updated: 5 June 2026")
- <https://taxscape.deloitte.com/uk-budget/autumn-budget-2024/measures-autumn-budget-2024/increase-to-employer-nic-rate-and-lowering-of-the-secondary-threshold.aspx> — retrieved 2026-07-30 (the April 2025 step change)

### 1.1 Category letters — NOT modelled

Categories **H** (apprentice under 25), **M** (under 21), **V** (veteran) and **Z** pay **0%**
employer NI up to the **Upper Secondary Threshold** of £50,270/year, then 15% above it. CrewFlow
applies the standard rate to everyone because the schema holds **no date of birth, no apprenticeship
flag and no veteran start date**.

**Effect: employer NI is OVERSTATED** for those staff, by up to 15% of earnings between the
secondary and upper secondary thresholds. Recorded in `rates.ts` as
`upper_secondary_threshold_annual` so the size of the un-modelled relief is computable, but never
applied.

### 1.2 Employment Allowance — NOT modelled

An eligible employer can offset up to **£10,500 per year** (2025-26 and 2026-27) of its employer NI
bill. It is an **org-level annual allowance** consumed across all employees, so it cannot be
apportioned to a single payroll line without org-wide cumulative year-to-date state that this
codebase does not have.

**Effect: employer NI is OVERSTATED by up to £10,500/year for an eligible org.** This is the single
largest omission here and the run page says so.

---

## 2. Automatic-enrolment employer pension

The statutory minimum total contribution is 8% of **qualifying earnings**, of which the **employer
minimum is 3%**.

"Qualifying earnings" is the **slice** of earnings between the lower and upper limits of the
qualifying earnings band — **not** total pay. Charging 3% of full pay would materially overstate the
cost (for £38,400 of pay: £1,152 rather than the correct £964.80).

| Tax year | Employer minimum | QE lower limit | QE upper limit | Earnings trigger |
| --- | --- | --- | --- | --- |
| 2024-25 | 3% | £6,240 | £50,270 | £10,000 |
| 2025-26 | 3% | £6,240 | £50,270 | £10,000 |
| 2026-27 | 3% | £6,240 | £50,270 | £10,000 |

All automatic-enrolment thresholds for 2026/27 were **maintained at their 2025/26 levels** by the
DWP annual review (written ministerial statement, 18 December 2025).

Below the **£10,000 earnings trigger** an employer has no automatic-enrolment duty, so CrewFlow
charges no employer pension cost. The trigger governs, not the band: someone on £9,999 is above the
£6,240 band floor but attracts nothing.

- <https://www.gov.uk/government/publications/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627/review-of-the-automatic-enrolment-earnings-trigger-and-qualifying-earnings-band-for-202627> — retrieved 2026-07-30
- <https://questions-statements.parliament.uk/written-statements/detail/2025-12-18/hcws1206> — retrieved 2026-07-30

### 2.1 Eligibility — PARTIALLY modelled

The **earnings** half of the eligibility test is modelled correctly (the £10,000 trigger). The
**age** half (eligible jobholders are aged 22 to State Pension age) is **not**, because there is no
date of birth in the schema. Opt-out, opt-in and postponement are not modelled either — no such
columns exist.

**Effect: employer pension is OVERSTATED** for opted-out staff and for those outside the age band;
and **UNDERSTATED** for a worker below the trigger who has opted in (the one omission that flatters
a margin).

### 2.2 Methodology note — pro-rated bands

DWP publishes rounded per-period bands (£120/£967 weekly, £520/£4,189 monthly). CrewFlow annualises
the period gross and divides the result back, which is how `lib/payroll/compute.ts` already handles
PAYE and employee NI. Introducing a second methodology for pension alone would be worse than the
sub-penny divergence this causes.

---

## 3. Frozen employee-side figures (context)

The 2026-27 GOV.UK table confirms these are unchanged from the values already in
`lib/payroll/compute.ts`, which is why the employee-side constants there did not need dating:

- Personal allowance £12,570; basic rate to £50,270; higher rate to £125,140.
- Employee (primary) Class 1: 8% between the £12,570 primary threshold and the £50,270 upper
  earnings limit, 2% above.

The docblock in that file previously said "2025-26"; it now records that these thresholds hold for
2024-25, 2025-26 and 2026-27 alike.

---

## 4. What the money means, and where it goes

| Figure | Paid to | In the HMRC monthly bill? | Deducted from the worker? |
| --- | --- | --- | --- |
| PAYE | HMRC | Yes | Yes |
| Employee NI | HMRC | Yes | Yes |
| **Employer NI** | **HMRC** | **Yes** | **No** |
| **Employer pension** | **Pension provider** | **No** | **No** |

Two consequences the code enforces:

1. **`net_pay` never changes.** It is gross − PAYE − employee NI. Deducting an employer cost from
   wages would be wrong and unlawful; a regression test pins this, and the worker's own `/me` view
   is asserted to read no employer field.
2. **`computePayeMonth` includes employer NI but excludes employer pension.** The monthly PAYE bill
   is a payment to HMRC; the pension is not.

---

## 5. Job costing — banding on the person, not the job

Employer NI is **banded**, and banding is not linear. It must be computed **once** on a worker's
whole-period earnings and then apportioned across their jobs by hours.

Computing it per job would hand every job its own £5,000 nil band. For a worker split 100h/60h
across two jobs at £20/h, the correct monthly on-cost is **£497.90**; per-job banding gives
**£419.80** — an understatement of **£78.10**, exactly one extra nil band
(15% × £5,000 + 3% × £6,240, monthly). `employerOnCostsFromTimeEntries` bands on the person and
apportions with `apportion` from `lib/money.ts`, so the per-job parts sum to the total to the penny.

Hours with no `job_id` count toward the band (they consume the threshold) but are charged to no job
— that share is overhead, not direct job cost.

---

## 6. CIS subcontractors are NOT employees

A CIS subcontractor attracts **no employer NI and no employer pension**. This is structurally
guaranteed, not merely intended:

- `cis_subcontractors` is keyed on `(org_id, supplier_id)` — **there is no `user_id` on it at all**.
- Employer on-costs are driven by `time_entries.user_id` joined to a membership hourly rate. A
  subcontractor is not a member, has no `users.hourly_pay`, and logs no time entries, so the rate
  lookup cannot resolve them and no on-cost row is produced.
- CIS spend is categorised `subcontractor`, which `mapToCostBucket` files under `subcontractors` —
  a different bucket from `labour`.

Tests in `__tests__/payroll/employer-costs.test.ts` prove all three, plus source-pinned assertions
that no CIS or supplier module imports the employer-cost API and that the employer-cost module has
no CIS dependency.

---

## 7. Persistence — why there is no migration

Employer cost is a **pure function of `(gross_pay, cycle, period_start)`**, and all three are
already persisted (`payroll_lines.gross_pay`, `payroll_runs.cycle`, `payroll_runs.period_start`).
So the figures are derived on read through the single helper `employerCostsForStoredLine`, and:

- **Historical runs are correct immediately**, with no backfill.
- **There is no second copy of the rate table in SQL.** Storing the columns would have required
  either a SQL backfill that duplicates the rate table (violating the one-source-of-truth rule) or
  leaving existing rows at a defaulted `0` — which would have preserved the very understatement this
  change fixes.
- Historical integrity is preserved by resolving rates from the run's **own** `period_start`, never
  from today, so a finalised run keeps the rates that applied when it ran.

There is **no pension opt-out, age, NI-category or salary-sacrifice column** anywhere in the schema,
which is what makes the derivation exact today. **If any of those are ever added, employer cost stops
being derivable from gross alone and the figures must then be persisted per line.** That is the
trigger to revisit this decision.

---

## 7a. Employee-side fidelity (opt-in inputs)

> **Sources retrieved: 16 August 2026.** These figures live in `lib/payroll/rates.ts` and are applied
> only when the corresponding per-employee input is supplied; with no input the base calculation
> (standard 1257L, rest-of-UK, no student loan, no employee pension) is reproduced to the penny.
> They refine the **employee's** deductions/take-home, not employer cost, and every result stays an
> **estimate** — HMRC Basic PAYE Tools remains the authority before RTI.

### Student-loan repayment thresholds

9% of earnings above the threshold for the income-contingent plans (1/2/4); 6% for the postgraduate
loan. No upper limit, no banding.

| Plan | 2024-25 threshold | 2025-26 threshold | Rate |
| --- | --- | --- | --- |
| Plan 1 | £24,990 | £26,065 | 9% |
| Plan 2 | £27,295 | £28,470 | 9% |
| Plan 4 (Scotland-domiciled) | £31,395 | £32,745 | 9% |
| Postgraduate Loan | £21,000 | £21,000 (frozen) | 6% |

Source: GOV.UK "Repaying your student loan — What you'll pay". **2026-27 thresholds had not been
published at the retrieval date**, so `rates.ts` carries the 2025-26 figures forward with a loud
`unconfirmed` comment; the postgraduate threshold is frozen regardless. Update on publication.

### Scottish income tax

Scotland sets its own non-savings-income bands (six vs the rest-of-UK three); the personal allowance
is UK-wide (£12,570). Applied only when an employee's tax region is Scotland (their code carries an
`S`). The personal-allowance taper above £100k is **not** modelled, matching the rest-of-UK path.

| Band | 2024-25 (income up to) | 2025-26 (income up to) | Rate |
| --- | --- | --- | --- |
| Starter | £14,876 | £15,397 | 19% |
| Basic | £26,561 | £27,491 | 20% |
| Intermediate | £43,662 | £43,662 | 21% |
| Higher | £75,000 | £75,000 | 42% |
| Advanced | £125,140 | £125,140 | 45% |
| Top | above | above | 48% |

Source: GOV.UK / Scottish Government "Scottish Income Tax" rates and bands. **2026-27 Scottish Budget
bands were not confirmed at the retrieval date**, so 2025-26 is carried forward (flagged).

### Employee pension + salary sacrifice

- **Employee pension** (`employeePensionRate`) is modelled as a **relief-at-source** deduction —
  rate × qualifying earnings, taken from take-home pay, **not** netted off PAYE/NI (the scheme
  reclaims basic-rate relief into the pot separately). Only **enrolled** employees have a deduction.
- **Salary sacrifice** (`salarySacrificeAnnual`) is pay given up **before** tax and NI, so it reduces
  PAYE, employee NI **and** employer NI, and take-home — the sacrificed amount goes to the pension
  instead. It is apportioned to the period and clamped to the period gross.

## 7b. Employment Allowance — now applied as an "up to" estimate

The allowance (§8 lists it as the largest unmodelled **employer**-cost item) is now surfaced on the
run page via `employmentAllowanceReliefForRun`: relief = min(run employer NI, annual allowance)
(**£5,000** for 2024-25, **£10,500** for 2025-26/2026-27). It is still **not silently netted into the
per-line employer NI**, because it is an **annual, org-level** offset and we track neither eligibility
nor year-to-date consumption. The page presents it conditionally ("if eligible and not yet used up"),
so §8's direction-of-error note stands for the raw employer-NI figure.

## 8. Summary of what is NOT modelled

The authoritative list lives in code as `NOT_MODELLED` in `lib/payroll/rates.ts`, so the UI and this
document cannot drift apart. Direction is stated on **employer cost** (job margin moves the opposite
way).

| Not modelled | Effect on employer cost |
| --- | --- |
| Employment Allowance (up to £10,500/yr) | **Overstates** — largest single omission |
| Under-21 / apprentice-under-25 / veteran categories | **Overstates** |
| Salary sacrifice | **Overstates** |
| Pension opt-out, age eligibility, postponement | **Overstates** |
| Opted-in workers below the £10,000 trigger | **Understates** — the only one that flatters margin |
| Directors' cumulative annual-basis NI | Either direction, badly for a lump-sum director |
| Non-statutory scheme definitions (basic/total pay) | Either direction |
| Apprenticeship Levy (0.5% above a £3m pay bill), Class 1A on benefits | **Understates** — nil for a typical small contractor |
| DWP pro-rated per-period bands | Either direction, sub-penny |

Net: for a typical small contractor with no Employment Allowance claim and an adult workforce, the
estimate is **close and slightly conservative** (cost a little high, margin a little pessimistic).
For an org claiming the Employment Allowance, employer NI is **materially overstated** — which is
why the run page names it.
