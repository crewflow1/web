/**
 * TAX / PAYROLL JURISDICTION INTERFACE — the multi-country seam.
 *
 * CrewFlow's tax logic is three UK authorities: VAT (lib/tax/compute.ts), CIS
 * (lib/cis/*) and PAYE/payroll (lib/payroll/*). This module introduces a
 * JURISDICTION interface so a non-UK org can one day select a different tax impl,
 * WITHOUT forking those authorities and WITHOUT changing any UK behaviour.
 *
 * DESIGN — a thin facade, not a rewrite:
 *   • The interface DESCRIBES a jurisdiction (metadata: currency, locale, the tax
 *     name/number label, VAT rate domain, financial-year start, which withholding
 *     schemes exist) and DELEGATES computation to the existing pure authorities.
 *   • The UK impl (lib/tax/jurisdictions/uk.ts) is FIRST-CLASS: its computeVat
 *     delegates verbatim to computeVatQuarter, its CIS rates to rateForStatus.
 *     So routing through the jurisdiction yields byte-identical UK numbers — the
 *     authority is not duplicated, only referenced.
 *   • getTaxJurisdiction(code) resolves an org's `tax_jurisdiction` column to an
 *     impl, defaulting to UK for the default value AND for any unknown code, so a
 *     mis-provisioned org can never lose its (UK) tax behaviour.
 *
 * Other jurisdictions implement this same interface later; NONE is implemented in
 * this wave (no other country's tax code is written here).
 */

import type { TaxSummary } from "./compute";
import { computeVatQuarter, type VatComputeOptions } from "./compute";
import type { InvoicePaymentRow, FinanceRow } from "./compute";

/** A consumption-tax (VAT / GST / sales-tax) descriptor + calculator delegate. */
export type VatCapability = {
  /** User-facing name of the tax line ("VAT", "GST", "Sales tax"). */
  readonly taxName: string;
  /** Label for the org's tax registration number ("VAT number", "GST number"). */
  readonly registrationNumberLabel: string;
  /** The rate percentages this jurisdiction recognises (e.g. [0, 5, 20]). */
  readonly rates: readonly number[];
  /** The default rate applied to a new line. */
  readonly defaultRate: number;
  /**
   * Compute a return-period summary. The UK impl delegates VERBATIM to
   * computeVatQuarter — the single VAT authority is referenced, never forked.
   */
  computeReturn(
    invoicePayments: InvoicePaymentRow[],
    finances: FinanceRow[],
    periodStartIso: string,
    periodEndIso?: string,
    reverseChargeVat?: number,
    opts?: VatComputeOptions,
  ): TaxSummary["vat_quarter"];
};

/** A contractor-withholding scheme descriptor (UK CIS; absent elsewhere today). */
export type WithholdingCapability = {
  /** Scheme name (UK: "CIS"). */
  readonly schemeName: string;
  /** The deduction-rate percentages the scheme recognises. */
  readonly rates: readonly number[];
};

/** A payroll/employment-tax descriptor (UK PAYE; the authority stays in lib/payroll). */
export type PayrollCapability = {
  /** Scheme name (UK: "PAYE"). */
  readonly schemeName: string;
  /** Whether this jurisdiction has a payroll impl behind it. */
  readonly supported: boolean;
};

export type TaxJurisdiction = {
  /** Canonical code stored on organizations.tax_jurisdiction ("UK"). */
  readonly code: string;
  /** Human label ("United Kingdom (HMRC)"). */
  readonly label: string;
  /** ISO 3166-1 alpha-2 country this jurisdiction governs. */
  readonly country: string;
  /** Default base currency for orgs in this jurisdiction. */
  readonly currency: string;
  /** Default BCP-47 locale for orgs in this jurisdiction. */
  readonly locale: string;
  /** Financial-year start MONTH (1=Jan..12=Dec). UK = April = 4. */
  readonly financialYearStartMonth: number;
  /** Consumption-tax capability (every jurisdiction has one). */
  readonly vat: VatCapability;
  /** Contractor-withholding scheme, if the jurisdiction has one (UK: CIS). */
  readonly withholding?: WithholdingCapability;
  /** Payroll capability. */
  readonly payroll: PayrollCapability;
  /** Whether this is a fully-implemented, first-class jurisdiction. */
  readonly implemented: boolean;
};

// UK_JURISDICTION is imported for its VALUE (not a runtime cycle: uk.ts only
// type-imports from here, which is erased at build). This module owns the
// registration, so the registry is populated the moment jurisdiction.ts loads.
import { UK_JURISDICTION } from "./jurisdictions/uk";

const REGISTRY = new Map<string, TaxJurisdiction>();

/** Register a jurisdiction impl. Keyed by its (upper-cased) code. */
export function registerTaxJurisdiction(j: TaxJurisdiction): void {
  REGISTRY.set(j.code.toUpperCase(), j);
}

/** The default jurisdiction code — the first-class UK impl. */
export const DEFAULT_JURISDICTION_CODE = "UK";

// Register the first-class UK impl eagerly. Others plug in via
// registerTaxJurisdiction when their modules are built.
registerTaxJurisdiction(UK_JURISDICTION);

/**
 * Resolve a jurisdiction code to its impl. Unknown / absent codes fall back to
 * UK — a mis-provisioned org must never lose its tax behaviour. Case-insensitive.
 */
export function getTaxJurisdiction(code: string | null | undefined): TaxJurisdiction {
  const key = (code || DEFAULT_JURISDICTION_CODE).toUpperCase();
  return REGISTRY.get(key) ?? REGISTRY.get(DEFAULT_JURISDICTION_CODE) ?? UK_JURISDICTION;
}

/** True when a jurisdiction code names a fully-implemented, first-class impl. */
export function isJurisdictionImplemented(code: string | null | undefined): boolean {
  const key = (code || DEFAULT_JURISDICTION_CODE).toUpperCase();
  return REGISTRY.get(key)?.implemented ?? false;
}

/** All registered jurisdictions (metadata catalogue for admin/API surfaces). */
export function listTaxJurisdictions(): TaxJurisdiction[] {
  return [...REGISTRY.values()];
}

// Re-export the VAT authority through the jurisdiction module too, so a caller
// migrating to the seam has one import. The function itself is unchanged.
export { computeVatQuarter };
