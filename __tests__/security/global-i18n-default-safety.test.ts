import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  formatGbp,
  formatPence,
  formatCurrency,
  identityConverter,
} from "@/lib/money";
import {
  formatDateUK,
  formatDateTimeUK,
  formatTimeUK,
  formatDateLongUK,
  formatDayKeyUK,
  formatDateInZone,
  formatDateTimeInZone,
  formatTimeInZone,
  formatDateLongInZone,
  formatDayKeyInZone,
} from "@/lib/time/format";
import {
  toInternationalDigits,
  toE164,
  whatsAppHref,
  toInternationalDigitsForRegion,
  toE164ForRegion,
  whatsAppHrefForRegion,
} from "@/lib/phone";
import {
  defaultOrgI18n,
  normalizeOrgI18n,
  isDefaultOrgI18n,
  DEFAULT_LOCALE,
  DEFAULT_CURRENCY,
  DEFAULT_COUNTRY,
  DEFAULT_TIMEZONE,
  DEFAULT_TAX_JURISDICTION,
  DEFAULT_PHONE_REGION,
} from "@/lib/i18n/config";
import { orgFormatters } from "@/lib/i18n/org-format";
import {
  getTaxJurisdiction,
  isJurisdictionImplemented,
  computeVatQuarter,
} from "@/lib/tax/jurisdiction";

/**
 * GLOBAL i18n — DEFAULT-SAFETY REGRESSION GATE.
 *
 * The Phase-15 multi-country wave adds internationalisation config + locale/
 * currency/jurisdiction/timezone/phone abstractions. Its cardinal invariant: an
 * EXISTING UK org (the default config — GB / en-GB / GBP / Europe/London / UK /
 * GB) must be BYTE-IDENTICAL to the pre-wave behaviour, in money, dates, phone
 * and tax. This test pins that: every new locale/currency/tz/region-aware path,
 * driven by the DEFAULT config, must reproduce the exact output of the helper it
 * generalises. A regression that shifts a UK figure fails here.
 */

const ROOT = resolve(__dirname, "..", "..");

// A representative spread including negatives, big values, and float-drift cases.
const MONEY_SAMPLES = [
  0, 1, 19.99, 100, 1234.5, 1000000, 0.1, 0.005, -42.42, 999999.99, 3.14159,
];

describe("money: formatCurrency default (en-GB/GBP) == formatGbp", () => {
  for (const v of MONEY_SAMPLES) {
    it(`formatCurrency(${v}) with defaults equals formatGbp(${v})`, () => {
      expect(formatCurrency(v)).toBe(formatGbp(v));
    });
    it(`formatCurrency(${v}) with explicit en-GB/GBP equals formatGbp`, () => {
      expect(formatCurrency(v, { locale: "en-GB", currency: "GBP" })).toBe(
        formatGbp(v),
      );
    });
  }
  it("null/undefined/empty coerce identically", () => {
    expect(formatCurrency(null)).toBe(formatGbp(null));
    expect(formatCurrency(undefined)).toBe(formatGbp(undefined));
    expect(formatCurrency("")).toBe(formatGbp(""));
  });
  it("orgFormatters(default).money == formatGbp", () => {
    const f = orgFormatters();
    for (const v of MONEY_SAMPLES) expect(f.money(v)).toBe(formatGbp(v));
  });
});

describe("money: pence formatter unchanged, identity converter refuses FX", () => {
  it("formatPence still renders GBP", () => {
    expect(formatPence(1999)).toBe(formatGbp(19.99));
  });
  it("identityConverter passes same-currency through", () => {
    expect(identityConverter.convert(10, "GBP", "GBP")).toEqual({
      amount: 10,
      currency: "GBP",
    });
    expect(identityConverter.supports("GBP", "GBP")).toBe(true);
  });
  it("identityConverter REFUSES any real conversion (no FX authority)", () => {
    expect(identityConverter.supports("GBP", "EUR")).toBe(false);
    expect(() => identityConverter.convert(10, "GBP", "EUR")).toThrow();
  });
});

describe("dates: *InZone default (en-GB/Europe/London) == *UK helpers", () => {
  const SAMPLES = [
    "2026-06-01T09:06:00Z",
    "2026-01-15T23:30:00Z", // GMT winter
    "2026-07-20T22:30:00Z", // BST summer edge (prev-day-on-UTC guard)
    "2026-12-31T00:00:00Z",
    new Date("2026-03-29T01:30:00Z").toISOString(),
  ];
  for (const s of SAMPLES) {
    it(`date/time/long/day-key match for ${s}`, () => {
      expect(formatDateInZone(s)).toBe(formatDateUK(s));
      expect(formatDateTimeInZone(s)).toBe(formatDateTimeUK(s));
      expect(formatTimeInZone(s)).toBe(formatTimeUK(s));
      expect(formatDateLongInZone(s)).toBe(formatDateLongUK(s));
      expect(formatDayKeyInZone(s)).toBe(formatDayKeyUK(s));
    });
  }
  it("empty input yields empty string like the UK helpers", () => {
    expect(formatDateInZone(null)).toBe(formatDateUK(null));
    expect(formatDateInZone("")).toBe(formatDateUK(""));
  });
  it("bad locale/zone degrade to the UK output (never throw)", () => {
    expect(formatDateInZone(SAMPLES[0], { locale: "", timeZone: "Not/AZone" })).toBe(
      formatDateUK(SAMPLES[0]),
    );
  });
  it("orgFormatters(default) date helpers match the UK helpers", () => {
    const f = orgFormatters();
    for (const s of SAMPLES) {
      expect(f.date(s)).toBe(formatDateUK(s));
      expect(f.dateTime(s)).toBe(formatDateTimeUK(s));
      expect(f.time(s)).toBe(formatTimeUK(s));
    }
  });
});

describe("phone: *ForRegion('GB') == the existing UK helpers (byte-identical)", () => {
  const SAMPLES = [
    "07700 900000",
    "+44 7700 900000",
    "0044 7700 900000",
    "447700900000",
    "(07700) 900-000",
    "  ",
    "",
    "not a number",
  ];
  for (const s of SAMPLES) {
    it(`GB region matches for ${JSON.stringify(s)}`, () => {
      expect(toInternationalDigitsForRegion(s, "GB")).toBe(toInternationalDigits(s));
      expect(toInternationalDigitsForRegion(s)).toBe(toInternationalDigits(s));
      expect(toE164ForRegion(s, "GB")).toBe(toE164(s));
      expect(whatsAppHrefForRegion(s, "GB")).toBe(whatsAppHref(s));
    });
  }
  it("orgFormatters(default) phone helpers match the UK helpers", () => {
    const f = orgFormatters();
    for (const s of SAMPLES) {
      expect(f.phoneDigits(s)).toBe(toInternationalDigits(s));
      expect(f.phoneE164(s)).toBe(toE164(s));
      expect(f.whatsAppHref(s)).toBe(whatsAppHref(s));
    }
  });
});

describe("config: defaults ARE the pre-wave UK values", () => {
  it("named defaults", () => {
    expect(DEFAULT_LOCALE).toBe("en-GB");
    expect(DEFAULT_CURRENCY).toBe("GBP");
    expect(DEFAULT_COUNTRY).toBe("GB");
    expect(DEFAULT_TIMEZONE).toBe("Europe/London");
    expect(DEFAULT_TAX_JURISDICTION).toBe("UK");
    expect(DEFAULT_PHONE_REGION).toBe("GB");
  });
  it("defaultOrgI18n() is the full UK config", () => {
    expect(defaultOrgI18n()).toEqual({
      country: "GB",
      locale: "en-GB",
      currency: "GBP",
      timezone: "Europe/London",
      tax_jurisdiction: "UK",
      phone_region: "GB",
    });
    expect(isDefaultOrgI18n(defaultOrgI18n())).toBe(true);
  });
  it("a null / empty / garbage row degrades to the UK defaults (pre-migration safe)", () => {
    expect(normalizeOrgI18n(null)).toEqual(defaultOrgI18n());
    expect(normalizeOrgI18n({})).toEqual(defaultOrgI18n());
    expect(
      normalizeOrgI18n({
        country: null,
        locale: "not a locale!!",
        currency: "gbpx",
        timezone: "Not/AZone",
        tax_jurisdiction: "",
        phone_region: "GBR",
      }),
    ).toEqual(defaultOrgI18n());
  });
});

describe("tax jurisdiction: UK is first-class and delegates verbatim", () => {
  it("getTaxJurisdiction('UK') and unknown/absent all resolve to UK", () => {
    expect(getTaxJurisdiction("UK").code).toBe("UK");
    expect(getTaxJurisdiction("uk").code).toBe("UK");
    expect(getTaxJurisdiction(null).code).toBe("UK");
    expect(getTaxJurisdiction("ZZ").code).toBe("UK"); // unknown → UK, never lost
    expect(isJurisdictionImplemented("UK")).toBe(true);
    expect(isJurisdictionImplemented("ZZ")).toBe(false);
  });
  it("UK metadata matches the pre-wave hardcoded UK values", () => {
    const uk = getTaxJurisdiction("UK");
    expect(uk.currency).toBe("GBP");
    expect(uk.locale).toBe("en-GB");
    expect(uk.country).toBe("GB");
    expect(uk.financialYearStartMonth).toBe(4);
    expect(uk.vat.taxName).toBe("VAT");
    expect([...uk.vat.rates]).toEqual([0, 5, 20]);
    expect(uk.vat.defaultRate).toBe(20);
    expect(uk.withholding?.schemeName).toBe("CIS");
    expect([...(uk.withholding?.rates ?? [])]).toEqual([0, 20, 30]);
  });
  it("UK computeReturn is byte-identical to computeVatQuarter", () => {
    const invoicePayments = [
      { amount: 1200, paid_at: "2026-05-01T00:00:00Z", invoice_vat_total: 200, invoice_amount: 1000, invoice_total: 1200 } as never,
      { amount: 600, paid_at: "2026-06-15T00:00:00Z", invoice_vat_total: 100, invoice_amount: 500, invoice_total: 600 } as never,
    ];
    const finances = [
      { vat_total: 40, amount: 240, created_at: "2026-05-10T00:00:00Z" } as never,
    ];
    const start = "2026-04-01";
    const end = "2026-07-01";
    const viaAuthority = computeVatQuarter(invoicePayments, finances, start, end);
    const viaJurisdiction = getTaxJurisdiction("UK").vat.computeReturn(
      invoicePayments,
      finances,
      start,
      end,
    );
    expect(viaJurisdiction).toEqual(viaAuthority);
  });
});

describe("migration 20261210000000: additive, UK defaults, tenant-safe", () => {
  const MIG = "supabase/migrations/20261210000000_org_internationalisation.sql";
  const raw = readFileSync(resolve(ROOT, MIG), "utf8");
  // Strip SQL line comments so structural assertions test EXECUTABLE statements
  // only (the header documents "drop column …" as the reversal note).
  const sql = raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

  it("adds the four columns with the UK defaults, NOT NULL, IF NOT EXISTS", () => {
    for (const [col, def] of [
      ["locale", "en-GB"],
      ["currency", "GBP"],
      ["tax_jurisdiction", "UK"],
      ["phone_region", "GB"],
    ] as const) {
      const re = new RegExp(
        `add column if not exists ${col} text not null default '${def}'`,
        "i",
      );
      expect(sql, `${col} additive+default`).toMatch(re);
    }
  });
  it("only ALTERs organizations (no data movement, no other table)", () => {
    const alters = [...sql.matchAll(/alter table\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(new Set(alters)).toEqual(new Set(["organizations"]));
    expect(sql).not.toMatch(/\bupdate\s+public\./i); // no backfill UPDATE
    expect(sql).not.toMatch(/\bdrop\s+/i);
  });
  it("does not add any flat ADDRESS column to organizations (org-branding guard)", () => {
    for (const c of ["address_line1", "address_line2", "city", "county", "postcode"]) {
      expect(sql).not.toMatch(new RegExp(`add column[^;]*\\b${c}\\b`, "i"));
    }
  });
});
