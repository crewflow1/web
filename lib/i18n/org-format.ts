/**
 * ORG-BOUND FORMATTERS — the consumption API for per-org i18n.
 *
 * A surface that has the org's {@link OrgI18n} (from ctx.org.i18n, see
 * server/auth/session.ts) calls `orgFormatters(cfg)` once and gets money / date /
 * phone / translation helpers pre-bound to that org's locale, currency, timezone,
 * phone_region and message catalogue. This is the seam UI/PDF/email surfaces move
 * onto to become multi-country — instead of the hardcoded formatGbp / formatDateUK
 * / en-GB literals.
 *
 * Pure and isomorphic (takes the config as an argument; no server-only / no
 * Supabase). DEFAULT-SAFETY: for a UK org (the default config) every bound helper
 * produces output byte-identical to the pre-wave formatter it replaces — proven by
 * the default-safety tests.
 */

import { formatCurrency, type Money } from "@/lib/money";
import {
  formatDateInZone,
  formatDateTimeInZone,
  formatDateLongInZone,
  formatTimeInZone,
} from "@/lib/time/format";
import {
  toE164ForRegion,
  whatsAppHrefForRegion,
  toInternationalDigitsForRegion,
} from "@/lib/phone";
import { createTranslator, type Translator, type TranslateParams } from "./translator";
import { defaultOrgI18n, type OrgI18n } from "./config";

export type OrgFormatters = {
  readonly config: OrgI18n;
  /** The bound translator (t / has). */
  readonly translator: Translator;
  /** Translate a key with the org locale. */
  t(key: string, params?: TranslateParams): string;
  /** Format a bare amount in the org's currency + locale. */
  money(value: number | string | null | undefined): string;
  /** Format a {@link Money} value (its own currency) in the org locale. */
  moneyValue(m: Money): string;
  /** Numeric date in the org zone/locale. */
  date(input: Parameters<typeof formatDateInZone>[0]): string;
  /** Numeric date + time in the org zone/locale. */
  dateTime(input: Parameters<typeof formatDateTimeInZone>[0]): string;
  /** Long-form date in the org zone/locale. */
  dateLong(input: Parameters<typeof formatDateLongInZone>[0]): string;
  /** HH:mm in the org zone/locale. */
  time(input: Parameters<typeof formatTimeInZone>[0]): string;
  /** E.164 phone using the org's default phone region. */
  phoneE164(input: string | null | undefined): string | null;
  /** WhatsApp href using the org's default phone region. */
  whatsAppHref(input: string | null | undefined): string | null;
  /** Digits-only international phone using the org's default phone region. */
  phoneDigits(input: string | null | undefined): string | null;
};

/** Build the org-bound formatter bundle. Pass ctx.org.i18n (or omit for UK). */
export function orgFormatters(config: OrgI18n = defaultOrgI18n()): OrgFormatters {
  const { locale, currency, timezone, phone_region } = config;
  const translator = createTranslator(locale);
  const zone = { locale, timeZone: timezone };
  return {
    config,
    translator,
    t: (key, params) => translator.t(key, params),
    money: (value) => formatCurrency(value, { locale, currency }),
    moneyValue: (m) => formatCurrency(m.amount, { locale, currency: m.currency }),
    date: (input) => formatDateInZone(input, zone),
    dateTime: (input) => formatDateTimeInZone(input, zone),
    dateLong: (input) => formatDateLongInZone(input, zone),
    time: (input) => formatTimeInZone(input, zone),
    phoneE164: (input) => toE164ForRegion(input, phone_region),
    whatsAppHref: (input) => whatsAppHrefForRegion(input, phone_region),
    phoneDigits: (input) => toInternationalDigitsForRegion(input, phone_region),
  };
}
