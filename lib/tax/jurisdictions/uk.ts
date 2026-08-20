/**
 * UNITED KINGDOM tax jurisdiction — the first-class impl behind the interface.
 *
 * This is a thin FACADE over the existing UK authorities; it forks NONE of them:
 *   • VAT   → lib/tax/compute.ts computeVatQuarter (the single VAT calculator)
 *   • CIS   → lib/cis/* deduction rates (the withholding-rate authority)
 *   • PAYE  → lib/payroll/* (the payroll authority; referenced, not duplicated)
 *
 * Routing a UK org's VAT through UK_JURISDICTION.vat.computeReturn is therefore
 * byte-identical to calling computeVatQuarter directly — a default-safety test
 * pins that equivalence.
 *
 * This module has ONLY a type-only import from ../jurisdiction (erased at build),
 * so there is no runtime import cycle: ../jurisdiction imports UK_JURISDICTION
 * from here and performs the registration itself.
 */

import { computeVatQuarter } from "../compute";
import type { TaxJurisdiction } from "../jurisdiction";

/**
 * UK VAT rate domain — matches lib/org-config/schema.ts VAT_RATES exactly (kept
 * as a literal here to avoid a dependency cycle through the org-config layer; the
 * jurisdiction-parity test asserts the two lists agree).
 */
const UK_VAT_RATES = [0, 5, 20] as const;
/** UK CIS deduction rates — gross / registered / unverified (lib/cis). */
const UK_CIS_RATES = [0, 20, 30] as const;

export const UK_JURISDICTION: TaxJurisdiction = {
  code: "UK",
  label: "United Kingdom (HMRC)",
  country: "GB",
  currency: "GBP",
  locale: "en-GB",
  // UK financial year starts in April.
  financialYearStartMonth: 4,
  vat: {
    taxName: "VAT",
    registrationNumberLabel: "VAT number",
    rates: UK_VAT_RATES,
    defaultRate: 20,
    // Delegate VERBATIM to the single VAT authority — same function, same args.
    computeReturn: (
      invoicePayments,
      finances,
      periodStartIso,
      periodEndIso,
      reverseChargeVat,
      opts,
    ) =>
      computeVatQuarter(
        invoicePayments,
        finances,
        periodStartIso,
        periodEndIso,
        reverseChargeVat,
        opts,
      ),
  },
  withholding: {
    schemeName: "CIS",
    rates: UK_CIS_RATES,
  },
  payroll: {
    schemeName: "PAYE",
    supported: true,
  },
  implemented: true,
};
