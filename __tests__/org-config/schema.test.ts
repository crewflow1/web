import { describe, it, expect } from "vitest";
import {
  WEEKDAYS,
  workingHoursSchema,
  defaultWorkingHours,
  normalizeWorkingHours,
  taxDefaultsSchema,
  defaultTaxDefaults,
  defaultOrgSettings,
  defaultFlatRateConfig,
  flatRateConfigSchema,
  VAT_RATES,
  CIS_RATES,
} from "@/lib/org-config/schema";

/**
 * Org config — pure schema, defaults, validation + normaliser contracts (no DB).
 *
 * Covers the CRUD-shape/defaults/validation half of P3W2: what a valid config
 * looks like, what the defaults are, and what the write boundary rejects. The
 * org-isolation + RLS half is pinned in __tests__/security/org-settings.test.ts.
 */

describe("working hours", () => {
  it("defaults are Mon–Fri 08:00–17:00, weekend closed", () => {
    const wh = defaultWorkingHours();
    for (const day of ["mon", "tue", "wed", "thu", "fri"] as const) {
      expect(wh[day]).toEqual({ open: "08:00", close: "17:00" });
    }
    expect(wh.sat).toBeNull();
    expect(wh.sun).toBeNull();
  });

  it("covers exactly the seven weekdays, Monday-first", () => {
    expect(WEEKDAYS).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
    expect(Object.keys(defaultWorkingHours()).sort()).toEqual([...WEEKDAYS].sort());
  });

  it("accepts a valid full week (working days + closed days)", () => {
    const parsed = workingHoursSchema.safeParse(defaultWorkingHours());
    expect(parsed.success).toBe(true);
  });

  it("rejects a close that is not after open", () => {
    const bad = { ...defaultWorkingHours(), mon: { open: "17:00", close: "08:00" } };
    expect(workingHoursSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an equal open/close (zero-length window)", () => {
    const bad = { ...defaultWorkingHours(), mon: { open: "09:00", close: "09:00" } };
    expect(workingHoursSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-HH:MM time and a 24:00 overflow", () => {
    expect(
      workingHoursSchema.safeParse({ ...defaultWorkingHours(), mon: { open: "8am", close: "5pm" } }).success,
    ).toBe(false);
    expect(
      workingHoursSchema.safeParse({ ...defaultWorkingHours(), mon: { open: "00:00", close: "24:00" } }).success,
    ).toBe(false);
  });

  it("rejects a missing day (partial week)", () => {
    const { sun: _sun, ...partial } = defaultWorkingHours();
    void _sun;
    expect(workingHoursSchema.safeParse(partial).success).toBe(false);
  });

  it("normalize() passes a valid config through unchanged", () => {
    const valid = { ...defaultWorkingHours(), sat: { open: "09:00", close: "13:00" } };
    expect(normalizeWorkingHours(valid)).toEqual(valid);
  });

  it("normalize() falls back to defaults for junk (scalar, array, malformed)", () => {
    const d = defaultWorkingHours();
    expect(normalizeWorkingHours(null)).toEqual(d);
    expect(normalizeWorkingHours("nope")).toEqual(d);
    expect(normalizeWorkingHours([])).toEqual(d);
    expect(normalizeWorkingHours({ mon: { open: "bad" } })).toEqual(d);
  });
});

describe("tax defaults", () => {
  it("defaults are 20% VAT, 20% CIS, April FY start, 30-day terms, group_1 stagger, cash scheme", () => {
    expect(defaultTaxDefaults()).toEqual({
      default_vat_rate: 20,
      cis_default_rate: 20,
      financial_year_start_month: 4,
      default_payment_terms_days: 30,
      vat_stagger: "group_1",
      vat_scheme: "cash",
    });
  });

  it("accepts every allowed VAT and CIS rate", () => {
    for (const v of VAT_RATES) {
      expect(
        taxDefaultsSchema.safeParse({
          default_vat_rate: v,
          cis_default_rate: 20,
          financial_year_start_month: 4,
          default_payment_terms_days: 30,
          vat_stagger: "group_1",
          vat_scheme: "cash",
        }).success,
      ).toBe(true);
    }
    for (const c of CIS_RATES) {
      expect(
        taxDefaultsSchema.safeParse({
          default_vat_rate: 20,
          cis_default_rate: c,
          financial_year_start_month: 4,
          default_payment_terms_days: 30,
          vat_stagger: "group_1",
          vat_scheme: "cash",
        }).success,
      ).toBe(true);
    }
  });

  it("accepts every HMRC stagger and rejects an unknown one", () => {
    for (const s of ["group_1", "group_2", "group_3", "monthly"]) {
      expect(
        taxDefaultsSchema.safeParse({
          default_vat_rate: 20,
          cis_default_rate: 20,
          financial_year_start_month: 4,
          default_payment_terms_days: 30,
          vat_stagger: s,
          vat_scheme: "cash",
        }).success,
      ).toBe(true);
    }
    expect(
      taxDefaultsSchema.safeParse({
        default_vat_rate: 20,
        cis_default_rate: 20,
        financial_year_start_month: 4,
        default_payment_terms_days: 30,
        vat_stagger: "quarterly",
        vat_scheme: "cash",
      }).success,
    ).toBe(false);
  });

  it("accepts both VAT schemes and rejects an unknown one", () => {
    for (const scheme of ["cash", "standard"]) {
      expect(
        taxDefaultsSchema.safeParse({
          default_vat_rate: 20,
          cis_default_rate: 20,
          financial_year_start_month: 4,
          default_payment_terms_days: 30,
          vat_stagger: "group_1",
          vat_scheme: scheme,
        }).success,
      ).toBe(true);
    }
    expect(
      taxDefaultsSchema.safeParse({
        default_vat_rate: 20,
        cis_default_rate: 20,
        financial_year_start_month: 4,
        default_payment_terms_days: 30,
        vat_stagger: "group_1",
        vat_scheme: "accrual", // not a valid stored value; the label is "standard"
      }).success,
    ).toBe(false);
  });

  it("coerces string form values (VAT '20', terms '14')", () => {
    const parsed = taxDefaultsSchema.safeParse({
      default_vat_rate: "20",
      cis_default_rate: "30",
      financial_year_start_month: "4",
      default_payment_terms_days: "14",
      vat_stagger: "group_2",
      vat_scheme: "standard",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.default_vat_rate).toBe(20);
      expect(parsed.data.cis_default_rate).toBe(30);
      expect(parsed.data.default_payment_terms_days).toBe(14);
      expect(parsed.data.vat_stagger).toBe("group_2");
      expect(parsed.data.vat_scheme).toBe("standard");
    }
  });

  it("rejects an unrecognised VAT rate (e.g. 17.5) and CIS rate (e.g. 25)", () => {
    expect(
      taxDefaultsSchema.safeParse({
        default_vat_rate: 17.5,
        cis_default_rate: 20,
        financial_year_start_month: 4,
        default_payment_terms_days: 30,
        vat_stagger: "group_1",
      }).success,
    ).toBe(false);
    expect(
      taxDefaultsSchema.safeParse({
        default_vat_rate: 20,
        cis_default_rate: 25,
        financial_year_start_month: 4,
        default_payment_terms_days: 30,
        vat_stagger: "group_1",
      }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range month and negative / oversized terms", () => {
    const base = { default_vat_rate: 20, cis_default_rate: 20, vat_stagger: "group_1" };
    expect(
      taxDefaultsSchema.safeParse({ ...base, financial_year_start_month: 0, default_payment_terms_days: 30 }).success,
    ).toBe(false);
    expect(
      taxDefaultsSchema.safeParse({ ...base, financial_year_start_month: 13, default_payment_terms_days: 30 }).success,
    ).toBe(false);
    expect(
      taxDefaultsSchema.safeParse({ ...base, financial_year_start_month: 4, default_payment_terms_days: -1 }).success,
    ).toBe(false);
    expect(
      taxDefaultsSchema.safeParse({ ...base, financial_year_start_month: 4, default_payment_terms_days: 366 }).success,
    ).toBe(false);
  });
});

describe("combined org settings", () => {
  it("defaultOrgSettings() merges tax defaults + working-hours + disabled FRS defaults", () => {
    const s = defaultOrgSettings();
    expect(s).toEqual({
      ...defaultTaxDefaults(),
      working_hours: defaultWorkingHours(),
      flat_rate_config: defaultFlatRateConfig(),
    });
    // The FRS default must be DISABLED so no existing tenant's VAT numbers move.
    expect(s.flat_rate_config.enabled).toBe(false);
  });
});

describe("flat rate scheme config — cross-field sector-rate validation", () => {
  const enabled = (sector: unknown) => ({
    enabled: true,
    sector_percent: sector,
    registration_date: null,
    first_year_discount: false,
    effective_from: null,
    effective_to: null,
    limited_cost: "no",
  });

  it("DISABLED config is accepted with the default sector_percent 0 (FRS off, unaffected)", () => {
    const parsed = flatRateConfigSchema.safeParse({ enabled: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sector_percent).toBe(0);
  });

  it("ENABLING FRS with sector_percent 0 is REJECTED (would file box 1 = £0)", () => {
    const parsed = flatRateConfigSchema.safeParse(enabled(0));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The error is attached to sector_percent so the settings panel can show it inline.
      expect(parsed.error.issues.some((i) => i.path[0] === "sector_percent")).toBe(true);
    }
  });

  it("ENABLING FRS with a rate above 16.5% is REJECTED", () => {
    expect(flatRateConfigSchema.safeParse(enabled(17)).success).toBe(false);
    expect(flatRateConfigSchema.safeParse(enabled(20)).success).toBe(false);
  });

  it("ENABLING FRS with a below-1% rate is REJECTED", () => {
    expect(flatRateConfigSchema.safeParse(enabled(0.5)).success).toBe(false);
  });

  it("ENABLING FRS with a valid rate (coerced from a form string) is ACCEPTED", () => {
    const parsed = flatRateConfigSchema.safeParse(enabled("9.5"));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sector_percent).toBe(9.5);
  });

  it("accepts the band boundaries 1% and 16.5% when enabled", () => {
    expect(flatRateConfigSchema.safeParse(enabled(1)).success).toBe(true);
    expect(flatRateConfigSchema.safeParse(enabled(16.5)).success).toBe(true);
  });

  it("limited_cost has no 'auto' member; unknown values are rejected", () => {
    expect(flatRateConfigSchema.safeParse({ ...enabled(9.5), limited_cost: "auto" }).success).toBe(false);
    for (const lc of ["yes", "no", "unset"]) {
      expect(flatRateConfigSchema.safeParse({ ...enabled(9.5), limited_cost: lc }).success).toBe(true);
    }
  });
});
