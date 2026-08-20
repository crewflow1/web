/**
 * Organisation internationalisation config — pure schema, defaults + normalisers.
 *
 * The single source of truth for the six identity dimensions an org carries for
 * multi-country readiness (migration 20261210000000 adds the last four to
 * `organizations`; `country` + `timezone` were on the baseline schema):
 *
 *   country          ISO 3166-1 alpha-2  default 'GB'
 *   locale           BCP-47 tag          default 'en-GB'
 *   currency         ISO 4217 alpha-3    default 'GBP'
 *   timezone         IANA zone           default 'Europe/London'
 *   tax_jurisdiction jurisdiction code   default 'UK'
 *   phone_region     ISO 3166-1 alpha-2  default 'GB'
 *
 * DEFAULT-SAFETY: every default reproduces the pre-wave hardcoded behaviour, so an
 * existing UK org resolves to exactly the values the code already assumed. The
 * READ path is LENIENT — a malformed / absent value degrades to the UK default
 * rather than surfacing a broken locale to a formatter (which could throw at a
 * money/date render). The WRITE path (config forms) should validate with
 * {@link orgI18nSchema} to REJECT bad input.
 *
 * NO server-only imports (no Supabase, no `server-only`): the hermetic unit +
 * security tiers import this to prove the defaults / normalisers, and both the
 * read service and any write action share it so a form and a reader can never
 * disagree about the shape.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// The canonical UK defaults (the pre-wave behaviour, verbatim)
// ---------------------------------------------------------------------------

/** IANA zone the whole app rendered in before the wave (lib/time/format.ts). */
export const DEFAULT_TIMEZONE = "Europe/London";
/** BCP-47 tag the whole app formatted with before the wave (lib/money + lib/time). */
export const DEFAULT_LOCALE = "en-GB";
/** ISO 4217 base currency all historical amounts are denominated in. */
export const DEFAULT_CURRENCY = "GBP";
/** ISO 3166-1 alpha-2 country the app assumed. */
export const DEFAULT_COUNTRY = "GB";
/** The tax/payroll jurisdiction whose impl is first-class (HMRC VAT/CIS/PAYE). */
export const DEFAULT_TAX_JURISDICTION = "UK";
/** ISO 3166-1 alpha-2 default region for phone parsing (the +44 fall-through). */
export const DEFAULT_PHONE_REGION = "GB";

export type OrgI18n = {
  country: string;
  locale: string;
  currency: string;
  timezone: string;
  tax_jurisdiction: string;
  phone_region: string;
};

/** The full defaults an org falls back to (a UK org, verbatim pre-wave). */
export function defaultOrgI18n(): OrgI18n {
  return {
    country: DEFAULT_COUNTRY,
    locale: DEFAULT_LOCALE,
    currency: DEFAULT_CURRENCY,
    timezone: DEFAULT_TIMEZONE,
    tax_jurisdiction: DEFAULT_TAX_JURISDICTION,
    phone_region: DEFAULT_PHONE_REGION,
  };
}

// ---------------------------------------------------------------------------
// Field-level validation (mirrors the DB CHECK constraints)
// ---------------------------------------------------------------------------

/** BCP-47-ish: language, optional script/region subtags (matches the DB CHECK). */
const LOCALE_RX = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** ISO 4217 alpha-3, upper-case. */
const CURRENCY_RX = /^[A-Z]{3}$/;
/** ISO 3166-1 alpha-2, upper-case. */
const COUNTRY_RX = /^[A-Z]{2}$/;
/** Jurisdiction code — a short upper-case token ('UK', 'IE', 'US', …). */
const JURISDICTION_RX = /^[A-Z]{2,8}$/;

const localeField = z.string().trim().regex(LOCALE_RX, "Use a locale like en-GB");
const currencyField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(CURRENCY_RX, "Use an ISO 4217 code like GBP"));
const countryField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(COUNTRY_RX, "Use an ISO country code like GB"));
const jurisdictionField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(JURISDICTION_RX, "Use a jurisdiction code like UK"));
const timezoneField = z.string().trim().min(1).max(60).refine(isValidTimeZone, {
  message: "Use a valid IANA time zone like Europe/London",
});
const phoneRegionField = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(COUNTRY_RX, "Use an ISO region code like GB"));

/**
 * The WRITE-boundary schema — every field defaults to its UK value so a partial
 * payload from a config form can never blank a dimension. Use `.parse()` in a
 * write action to REJECT invalid input; use {@link normalizeOrgI18n} on the read
 * path where a broken stored value must degrade rather than throw.
 */
export const orgI18nSchema = z.object({
  country: countryField.default(DEFAULT_COUNTRY),
  locale: localeField.default(DEFAULT_LOCALE),
  currency: currencyField.default(DEFAULT_CURRENCY),
  timezone: timezoneField.default(DEFAULT_TIMEZONE),
  tax_jurisdiction: jurisdictionField.default(DEFAULT_TAX_JURISDICTION),
  phone_region: phoneRegionField.default(DEFAULT_PHONE_REGION),
});

/**
 * Is `tz` a time zone the runtime's Intl actually knows? A stored value the
 * runtime can't resolve would make every date formatter throw, so we validate it
 * here and degrade to Europe/London on the read path.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `locale` a BCP-47 tag the runtime's Intl can resolve? Guards the money/date
 * formatters — an unresolvable locale would throw inside Intl.NumberFormat.
 */
export function isValidLocale(locale: string): boolean {
  if (!LOCALE_RX.test(locale)) return false;
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lenient READ coercion — anything invalid degrades to the UK default
// ---------------------------------------------------------------------------

type RawOrgI18n = Partial<Record<keyof OrgI18n, unknown>> | null | undefined;

function coerceToken(value: unknown, rx: RegExp, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  return rx.test(upper) ? upper : fallback;
}

/**
 * Coerce a stored organizations row (or an untrusted blob) into a complete,
 * VALID OrgI18n. Each field that does not parse degrades to its UK default, so a
 * reader — and therefore a money/date/phone formatter — ALWAYS gets a safe,
 * runtime-resolvable config. This is the read path the request context uses.
 */
export function normalizeOrgI18n(raw: RawOrgI18n): OrgI18n {
  const d = defaultOrgI18n();
  if (!raw || typeof raw !== "object") return d;

  const locale =
    typeof raw.locale === "string" && isValidLocale(raw.locale.trim())
      ? raw.locale.trim()
      : d.locale;
  const timezone =
    typeof raw.timezone === "string" && isValidTimeZone(raw.timezone.trim())
      ? raw.timezone.trim()
      : d.timezone;

  return {
    country: coerceToken(raw.country, COUNTRY_RX, d.country),
    locale,
    currency: coerceToken(raw.currency, CURRENCY_RX, d.currency),
    timezone,
    tax_jurisdiction: coerceToken(raw.tax_jurisdiction, JURISDICTION_RX, d.tax_jurisdiction),
    phone_region: coerceToken(raw.phone_region, COUNTRY_RX, d.phone_region),
  };
}

/** True when a config is the pure UK default (used by default-safety proofs). */
export function isDefaultOrgI18n(cfg: OrgI18n): boolean {
  const d = defaultOrgI18n();
  return (
    cfg.country === d.country &&
    cfg.locale === d.locale &&
    cfg.currency === d.currency &&
    cfg.timezone === d.timezone &&
    cfg.tax_jurisdiction === d.tax_jurisdiction &&
    cfg.phone_region === d.phone_region
  );
}
