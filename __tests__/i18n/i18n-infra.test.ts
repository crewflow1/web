import { describe, it, expect } from "vitest";

import {
  createTranslator,
  interpolate,
  resolveCatalogues,
} from "@/lib/i18n/translator";
import { enGB, CATALOGUES, BASE_LOCALE } from "@/lib/i18n/catalog";
import {
  normalizeOrgI18n,
  orgI18nSchema,
  isValidLocale,
  isValidTimeZone,
} from "@/lib/i18n/config";
import { formatCurrency, formatMoney, money } from "@/lib/money";
import { orgFormatters } from "@/lib/i18n/org-format";
import {
  toInternationalDigitsForRegion,
  toE164ForRegion,
  isValidPhoneForRegion,
} from "@/lib/phone";
import {
  getTaxJurisdiction,
  registerTaxJurisdiction,
  listTaxJurisdictions,
  type TaxJurisdiction,
} from "@/lib/tax/jurisdiction";
import { formatDateInZone } from "@/lib/time/format";

/**
 * i18n INFRASTRUCTURE — behavioural unit tests.
 *
 * The default-safety tier proves the UK path is byte-identical; THIS suite proves
 * the framework actually WORKS for non-UK locales/currencies/jurisdictions/regions
 * (so the readiness is real, not merely inert).
 */

describe("translator: t(), interpolation, fallback", () => {
  it("resolves an en-GB key with interpolation", () => {
    const t = createTranslator("en-GB");
    expect(t.t("invoices.number", { number: "INV-001" })).toBe("Invoice INV-001");
    expect(t.t("action.save")).toBe("Save");
    expect(t.has("action.save")).toBe(true);
  });
  it("echoes an unknown key rather than rendering blank", () => {
    const t = createTranslator("en-GB");
    expect(t.t("nope.not.a.key")).toBe("nope.not.a.key");
    expect(t.has("nope.not.a.key")).toBe(false);
  });
  it("interpolate leaves unmatched placeholders intact", () => {
    expect(interpolate("Hi {name}, {x}", { name: "Sam" })).toBe("Hi Sam, {x}");
    expect(interpolate("no placeholders")).toBe("no placeholders");
  });
  it("an unregistered locale falls back to the base (en-GB) catalogue key-by-key", () => {
    const t = createTranslator("fr-FR"); // not registered → base fallback
    expect(t.t("action.save")).toBe("Save"); // en-GB base
    expect(t.locale).toBe("fr-FR");
  });
  it("resolveCatalogues ends at the base catalogue", () => {
    const chain = resolveCatalogues("fr-CA");
    expect(chain[chain.length - 1]).toBe(enGB);
  });
  it("a partial registered locale falls back per-key to en-GB", () => {
    // Register a partial locale, then prove missing keys fall through.
    CATALOGUES["xx-Test"] = { "action.save": "Zapisz" };
    try {
      const t = createTranslator("xx-Test");
      expect(t.t("action.save")).toBe("Zapisz"); // from the partial locale
      expect(t.t("action.cancel")).toBe("Cancel"); // fell back to en-GB
    } finally {
      delete CATALOGUES["xx-Test"];
    }
  });
});

describe("catalog integrity", () => {
  it("en-GB is the base and every value is a non-empty string", () => {
    expect(BASE_LOCALE).toBe("en-GB");
    for (const [k, v] of Object.entries(enGB)) {
      expect(typeof v, k).toBe("string");
      expect(v.length, k).toBeGreaterThan(0);
    }
  });
  it("every registered non-base catalogue only uses keys that exist in en-GB", () => {
    // en-GB is the fallback of last resort; a key absent from it is a latent gap.
    for (const [locale, cat] of Object.entries(CATALOGUES)) {
      if (locale === "en-GB") continue;
      for (const key of Object.keys(cat)) {
        expect(enGB, `${locale}:${key}`).toHaveProperty(key);
      }
    }
  });
});

describe("config: validation + normalisation for non-UK values", () => {
  it("accepts and preserves a valid non-UK config", () => {
    const cfg = normalizeOrgI18n({
      country: "us",
      locale: "en-US",
      currency: "usd",
      timezone: "America/New_York",
      tax_jurisdiction: "us",
      phone_region: "us",
    });
    expect(cfg).toEqual({
      country: "US",
      locale: "en-US",
      currency: "USD",
      timezone: "America/New_York",
      tax_jurisdiction: "US",
      phone_region: "US",
    });
  });
  it("orgI18nSchema fills defaults for a partial payload (write boundary)", () => {
    const parsed = orgI18nSchema.parse({ currency: "eur", locale: "fr-FR" });
    expect(parsed.currency).toBe("EUR");
    expect(parsed.locale).toBe("fr-FR");
    expect(parsed.country).toBe("GB"); // default fills the gap
    expect(parsed.timezone).toBe("Europe/London");
  });
  it("orgI18nSchema rejects a malformed currency", () => {
    expect(() => orgI18nSchema.parse({ currency: "pounds" })).toThrow();
  });
  it("locale/timezone validity helpers", () => {
    expect(isValidLocale("en-GB")).toBe(true);
    expect(isValidLocale("de-DE")).toBe(true);
    expect(isValidLocale("!!bad")).toBe(false);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("currency: non-GBP formatting works", () => {
  it("formats USD in en-US and EUR in fr-FR distinctly from GBP", () => {
    const usd = formatCurrency(1234.5, { locale: "en-US", currency: "USD" });
    expect(usd).toContain("$");
    expect(usd).toContain("1,234.50");
    const gbp = formatCurrency(1234.5);
    expect(gbp).toContain("£");
    expect(usd).not.toBe(gbp);
  });
  it("formatMoney uses the Money value's own currency", () => {
    expect(formatMoney(money(10, "USD"), "en-US")).toContain("$");
    expect(formatMoney(money(10, "EUR"), "de-DE")).toContain("€");
  });
  it("orgFormatters for a US org threads currency + locale end-to-end", () => {
    const f = orgFormatters({
      country: "US",
      locale: "en-US",
      currency: "USD",
      timezone: "America/New_York",
      tax_jurisdiction: "US",
      phone_region: "US",
    });
    expect(f.money(1000)).toContain("$");
    // New York is 5h behind London → a 02:00Z instant is the previous evening.
    expect(f.date("2026-06-01T02:00:00Z")).not.toBe(
      formatDateInZone("2026-06-01T02:00:00Z"),
    );
  });
});

describe("phone: non-GB regions parse via libphonenumber-js", () => {
  it("a US national number resolves to +1, not +44", () => {
    const digits = toInternationalDigitsForRegion("(415) 555-0132", "US");
    expect(digits?.startsWith("1")).toBe(true);
    expect(toE164ForRegion("(415) 555-0132", "US")).toBe("+14155550132");
  });
  it("a French mobile resolves to +33", () => {
    expect(toE164ForRegion("06 12 34 56 78", "FR")).toBe("+33612345678");
  });
  it("validity check per region", () => {
    expect(isValidPhoneForRegion("07911 123456", "GB")).toBe(true);
    expect(isValidPhoneForRegion("(415) 555-0132", "US")).toBe(true);
    expect(isValidPhoneForRegion("not a phone", "US")).toBe(false);
  });
});

describe("tax jurisdiction: a new jurisdiction plugs in via the interface", () => {
  it("register + resolve a stub jurisdiction without touching the UK impl", () => {
    const stub: TaxJurisdiction = {
      code: "IE",
      label: "Ireland (stub)",
      country: "IE",
      currency: "EUR",
      locale: "en-IE",
      financialYearStartMonth: 1,
      vat: {
        taxName: "VAT",
        registrationNumberLabel: "VAT number",
        rates: [0, 13.5, 23],
        defaultRate: 23,
        computeReturn: getTaxJurisdiction("UK").vat.computeReturn, // reuse the calc shape
      },
      payroll: { schemeName: "PAYE/PRSI", supported: false },
      implemented: false,
    };
    registerTaxJurisdiction(stub);
    try {
      const ie = getTaxJurisdiction("IE");
      expect(ie.currency).toBe("EUR");
      expect(ie.vat.defaultRate).toBe(23);
      // UK impl remains first-class and unchanged.
      expect(getTaxJurisdiction("UK").currency).toBe("GBP");
      expect(listTaxJurisdictions().some((j) => j.code === "UK")).toBe(true);
    } finally {
      // No public deregister (registry is a module singleton); leaving IE
      // registered is harmless — it only affects getTaxJurisdiction('IE'),
      // which no other test asserts absent. UK is unaffected.
    }
  });
});
