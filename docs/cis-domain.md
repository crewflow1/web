# CIS domain rules (verified against HMRC / GOV.UK)

This document records the **tax rules CrewFlow's CIS engine implements**, each one traced to an
authoritative HMRC / GOV.UK source with the URL and the date it was retrieved.

> **Rule of the house:** nothing in the CIS engine may encode a tax rule that is not written down
> here with a source. Where HMRC guidance is ambiguous or we could not verify it, this document says
> so explicitly and states the **conservative** interpretation we chose. We never silently invent tax
> semantics.

**All sources retrieved: 27 July 2026.**

---

## 1. Deduction rates and gross payment status

| Status | Rate | CrewFlow `cis_status` (M1) |
| --- | --- | --- |
| Registered subcontractor (verified, standard) | **20%** | `standard_20` |
| Unregistered / unmatched subcontractor (higher) | **30%** | `higher_30` |
| Gross payment status | **0%** | `gross` |

Verbatim, GOV.UK *"What you must do as a CIS contractor — Make deductions and pay subcontractors"*:

> "20% for registered subcontractors" | "30% for unregistered subcontractors" | "0% if the
> subcontractor has 'gross payment' status"

Corroborated by CIS340 §2.17:

> "There are 2 rates of deduction: standard rate — which must be applied to payments made to those
> subcontractors that are registered with us to be paid under deduction; higher rate — which must be
> applied to payments made to subcontractors where we are unable to identify the subcontractor"

Gross payment status is described at CIS340 §1.9 (paid without deductions).

- <https://www.gov.uk/what-you-must-do-as-a-cis-contractor/make-deductions-and-pay-subcontractors> — retrieved 2026-07-27
- <https://www.gov.uk/government/publications/construction-industry-scheme-cis-340/construction-industry-scheme-a-guide-for-contractors-and-subcontractors-cis-340> — retrieved 2026-07-27 (page "Last updated: 8 July 2026")

CrewFlow's M1 states `unverified`, `verification_required` and `failed` are **not** HMRC statuses —
they are workflow states meaning *"we have not established a rate"*. See §7 for how we treat them.

---

## 2. What is excluded from the deduction basis

CIS340 §3.12 — the contractor works out the deduction basis by taking the gross payment and removing
the **actual amounts the subcontractor paid** for:

> "materials (read paragraph 3.13); consumable stores; fuel (except fuel for travelling); plant hire
> (read paragraph 3.14); the cost of manufacture or prefabrication of materials"

GOV.UK contractor guidance states the same list, adding VAT explicitly:

> "Take away the amount the subcontractor has paid for:
> - VAT
> - equipment which is now unusable ('consumable stores')
> - fuel used, except for travelling
> - equipment hired for this job ('plant hire')
> - manufacturing or prefabricating materials
> - materials (only if they paid for them directly)"

**So the arithmetic is:**

```
deduction basis (labour) = gross payment (ex-VAT, ex-CITB levy) − qualifying materials
CIS deduction            = deduction basis × rate
```

`bill total × rate` is **wrong** and is never done anywhere in this codebase.

Note the words *"only if they paid for them directly"* and *"the actual amounts the subcontractor
paid"*: materials supplied **by the contractor** are not a subcontractor materials cost and do not
reduce the basis. CrewFlow therefore captures the materials figure as an explicit, contractor-entered
"materials paid for by the subcontractor" amount rather than deriving it from anything.

### 2.1 Fuel

"Fuel used, **except for travelling**" — fuel for travelling to site is **not** deductible from the
basis; fuel consumed in plant/operations is. CrewFlow does not attempt to split this automatically;
it is part of the single contractor-entered materials figure, and the UI labels it accordingly. This
is a deliberate judgement call, recorded in §8.

### 2.2 CITB levy

HMRC CISR15110:

> "This deduction should be excluded from the 'Gross amount of payment' shown on a monthly return."

Worked example from the same page:

> "Where the agreed contract price is £1,000 (plus VAT) and the CITB levy is, say £7, the sum that
> should be shown on the monthly return as the gross amount of the payment will be £993."

**This is subtly different from materials.** The CITB levy reduces the *gross amount of payment*
itself (£1,000 → £993), it is not subtracted as a materials cost. CrewFlow models it as a separate
`citb_levy_amount` that reduces gross **before** materials are removed, exactly matching the example.

- <https://www.gov.uk/hmrc-internal-manuals/construction-industry-scheme-reform/cisr15110> — retrieved 2026-07-27 (page "Last updated: 4 June 2026")

---

## 3. Is VAT ever part of the CIS deduction basis?

**No.** CIS340 §3.12:

> "Work out the gross amount from which a deduction will be made by excluding VAT charged by the
> subcontractor if the subcontractor is registered for VAT"

CrewFlow's CIS basis is computed from **net (ex-VAT) amounts only**. This is enforced in the
database, not just the app: a CHECK constraint ties the CIS basis to net figures, and the VAT amount
never appears in any basis expression.

This holds under the domestic reverse charge too — under reverse charge the subcontractor charges no
VAT at all, so there is nothing to exclude, but the basis is unchanged either way. Reverse charge
does **not** change the CIS calculation.

---

## 4. CIS tax month boundaries

CIS340 §§3.15 and 4.2:

> "A tax month runs from the sixth of one month to the fifth of the next month"

GOV.UK *"File your monthly returns"* corroborates with the worked example "the tax month of 6 May to
5 June", and states the filing deadline:

> "by the 19th of every month following the last tax month"

Payment deadline, GOV.UK *"Pay deductions to HMRC"*:

> "Pay HMRC every month by the 22nd (or the 19th if you're paying by post)."

**CIS tax months are NOT calendar months.** A payment dated 3 June falls in the *6 May – 5 June* tax
month; a payment dated 7 June falls in *6 June – 5 July*. This is centralised **once** in
`lib/cis/tax-month.ts` (M4 depends on it) and is computed in **UTC** to avoid a BST/GMT boundary
shifting a payment into the wrong month.

- <https://www.gov.uk/what-you-must-do-as-a-cis-contractor/file-your-monthly-returns> — retrieved 2026-07-27
- <https://www.gov.uk/what-you-must-do-as-a-cis-contractor/pay-deductions-to-hmrc> — retrieved 2026-07-27

---

## 5. Payment and deduction statement contents

CIS340 §3.15 — a payment and deduction statement must show:

> "contractor's own name and employer tax reference; end date of the tax month; subcontractor name
> and UTR; personal verification number if applicable; gross amount of payments; cost of materials;
> amount of deduction"

M3 **freezes every one of these figures** into the payment's immutable snapshot at posting time, so a
statement produced months later reproduces the same numbers even if the subcontractor's verification
status, rate, UTR or supplier record have since changed. Rendering the statement document itself is
M4 — see §8.

---

## 6. VAT domestic reverse charge for building and construction services

### 6.1 When it applies

GOV.UK guidance — the charge applies to

> "supplies of building and construction services"

made

> "for businesses who are registered for VAT in the UK"

and

> "reported within the Construction Industry Scheme"

It does **not** apply to services supplied independently such as

> "professional work of architects or surveyors"

and, per the technical guide, it does not apply where:

- the customer is an **end user** — *"the customer must tell the supplier or building contractor in
  writing that they are an end user"*. End users are defined as businesses that are *"VAT and
  Construction Industry Scheme registered [and] do not make onward supplies of the building and
  construction services that you receive."*
- the customer is an **intermediary supplier** — *"VAT and Construction Industry Scheme registered
  businesses that are connected or linked to end users"* — again on written notification.
- the **5% disregard** applies: *"If the reverse charge part of the supply is 5% or less of the whole
  supply value this can be disregarded."*
- the supply is zero-rated: *"The reverse charge does not apply to standard-rated items which are
  included in a zero-rated supply."*

### 6.2 What the invoice must state

Technical guide, verbatim:

> "VAT Act 1994 Section 55A applies" / "S55A VATA 94 applies" / "Customer to pay the VAT to HMRC"

and

> "clearly state how much VAT is due under the reverse charge, or if this amount cannot be shown,
> state the rate of VAT, but do not include the VAT in the amount charged to the customer."

**This is why reverse charge is not `vat = 0`.** The VAT rate and the VAT amount the customer must
account for are still *real, required, printed facts*. CrewFlow therefore stores the reverse-charge
VAT rate and the resulting notional VAT amount alongside the treatment, and prints the statutory
legend. The amount *charged* is the net value only.

### 6.3 How each party reports it

Technical guide, verbatim:

> "Suppliers must not enter any output tax on sales under the reverse charge. The supplier only needs
> to enter the net value of the sale."

> "If you buy services subject to the reverse charge, you must add the VAT charged to the output tax
> total on your VAT Return."

The customer then recovers it as input tax subject to the normal rules.

**Unverified:** HMRC's published guidance on these pages does **not** state VAT return box numbers
for the reverse charge. We checked the technical guide specifically for box 1 / 4 / 6 / 7 references
and found none. CrewFlow therefore models the **semantics** (supplier: net value only, no output tax;
customer: output tax raised and input tax recovered) and does **not** hardcode box numbers anywhere.

### 6.4 Materials supplied with services

Technical guide, verbatim:

> "If goods are supplied with construction services this is a single supply for VAT purposes. The
> reverse charge applies to the full value of the invoice."

Important consequence, and CrewFlow implements it this way: **the VAT treatment applies to the whole
invoice including materials, but the CIS deduction basis still excludes materials.** These are two
independent axes and must not be conflated.

- <https://www.gov.uk/guidance/vat-domestic-reverse-charge-for-building-and-construction-services> — retrieved 2026-07-27 (page "Last updated: 24 September 2020")
- <https://www.gov.uk/guidance/vat-reverse-charge-technical-guide> — retrieved 2026-07-27 (page "Last updated: 18 September 2024")

---

## 7. Conservative interpretations we chose

Where guidance left a judgement to us, we took the option that cannot under-deduct.

| Situation | Ambiguity | Our conservative choice |
| --- | --- | --- |
| `cis_status` is `unverified` / `verification_required` / `failed` | Not HMRC statuses. HMRC says higher rate applies "where we are unable to identify the subcontractor". | **Refuse to post.** We do not silently apply 30% and we do not apply 0%. The user must resolve verification first. Refusing is safer than guessing either way. |
| Supplier has no CIS record at all | Is this a CIS payment? | Treated as **non-CIS**: rate 0, no basis, no snapshot. A supplier with no CIS extension row is by construction not a subcontractor in CrewFlow. |
| Materials figure exceeds the net gross payment | HMRC does not describe a negative basis. | **Rejected** by CHECK constraint. Basis can be zero but never negative; deduction can never be negative. |
| Rounding direction | HMRC does not prescribe a rounding rule for the deduction. | `round2` half-up on the deduction, applied to a **cumulative** figure across partial payments so the total across all payments of a bill is penny-exact against a single-payment calculation. See §9. |
| Fuel for travelling | Must be excluded from the deductible materials figure. | Not auto-split. Contractor enters one materials figure; the UI states the exclusion. Recorded as a known simplification (§8). |
| End user / intermediary status | Determined by a written notification we do not hold. | Reverse charge is **never** inferred. It is an explicit per-bill choice by the user, defaulting to normal VAT. |

---

## 8. What we deliberately did NOT implement

These are out of scope for M3. None of them is silently approximated — where the feature is absent,
the system declines to act rather than guessing.

1. **HMRC verification API.** M1's `cis_status` is set by a human. We do not call HMRC's subcontractor
   verification service, so we cannot obtain a verification number automatically. The snapshot stores
   whatever verification reference M1 holds.
2. **CIS monthly return (CIS300) filing.** No return is generated or submitted. The tax-month helper
   exists so M4 can build it; M3 does not file anything.
3. **Payment and deduction statement PDF.** The figures are frozen (§5) but the document is M4.
4. **Automatic fuel-for-travelling split** (§7).
5. **Automatic end-user / intermediary determination.** Reverse charge is never inferred from data
   (§7); it is always an explicit choice, and we do not store or validate the written notification.
6. **The 5% disregard.** We do not automatically disregard a small reverse-charge element of a mixed
   supply. The user chooses the treatment for the bill as a whole.
7. **Mixed-treatment invoices.** One bill has one VAT treatment. We do not support part-reverse-charge,
   part-normal on a single bill.
8. **Deemed contractor / mainstream contractor determination**, CIS registration of the *user's own*
   business, and the £3m rolling threshold. Out of scope.
9. **Materials-cost reasonableness challenge.** CIS340 §3.13 expects a contractor to satisfy itself the
   materials cost is genuine. We record the figure and require it to be non-negative and not to exceed
   the net payment; we do not police whether it is commercially plausible.
10. **Deduction of the CITB levy itself.** We record `citb_levy_amount` so the reported gross is right
    (§2.2); we do not administer, calculate or collect the levy.
11. **VAT return box mapping** (§6.3) — not published in the guidance we could verify.
12. **Northern Ireland / cross-border and reverse charge interaction beyond the above.** Not modelled.

---

## 9. Partial payments — the arithmetic contract

A bill may be paid over several payments. The requirement is that **the sum of the deductions across
all payments of a bill equals the deduction that a single full payment would have produced**, to the
penny, with no material allowance applied twice.

CrewFlow uses a **cumulative** method, never a per-payment independent one:

```
for each allocation of a payment against a bill:
  prior            = Σ allocated amount of all NON-VOID earlier allocations against this bill
  cumulative       = prior + this allocation amount
  cum_basis        = round2(bill_basis × cumulative / bill_gross)
  cum_deduction    = round2(cum_basis × rate)
  this_basis       = cum_basis     − Σ basis already snapshotted on those earlier allocations
  this_deduction   = cum_deduction − Σ deduction already snapshotted on those earlier allocations
```

The denominator is the bill's **GROSS** value (`net + VAT`), because that is what an
allocation settles — an allocation of £1,200 against a £1,000 + £200 VAT bill settles it in full.
The **numerator** is the net-derived labour basis, so VAT still never enters the basis itself: it
only sets the scale on which "how much of this bill has been paid" is measured.

Because each step recomputes the cumulative figure from the bill totals and subtracts what has
already been frozen, rounding error cannot accumulate: the final allocation absorbs the residue and
the total is exact. A naive per-payment `round2(share × rate)` **does** drift — worked example, bill
£100.00 net with £33.33 labour at 20% (true total £6.67), paid £50.00 twice:

| Method | Payment 1 | Payment 2 | Total | Correct? |
| --- | --- | --- | --- | --- |
| Naive per-payment | £3.33 | £3.33 | £6.66 | ✗ one penny short |
| Cumulative (ours) | £3.33 | £3.34 | £6.67 | ✓ |

The material allowance is not "applied" per payment at all — it is baked into the bill-level basis,
so it cannot be double-counted however the payments are split. Allocation can never exceed the bill's
outstanding amount (M2's CAP 2, enforced in the database), so `cumulative ≤ bill_gross` always holds
and the apportionment ratio is always within `[0, 1]`. The engine additionally clamps the ratio at 1
and both increments at 0, so no float artefact or post-void re-sequencing can over-deduct or produce
a negative "refund" against a frozen historical figure.

Voiding a payment removes its allocations from `prior`, so the next payment correctly picks up the
deduction the voided one was carrying. Snapshots on already-posted payments are never rewritten.

---

## 10. Immutability

Everything above is captured into a **snapshot at posting time**: the net gross payment, the CITB
levy, the materials figure, the resulting basis, the VAT treatment and VAT amount, the rate that was
applied, the resulting deduction, and the subcontractor verification state (status, rate on file,
verification reference, masked UTR, supplier name) that justified the rate.

Later changes to verification status, rate, UTR, supplier details or bill composition **must not**
rewrite a posted payment's tax facts. This is enforced by database triggers reusing M2's write-once +
void semantics — not by application code alone. A posted payment is corrected by **voiding and
re-posting**, never by editing.
