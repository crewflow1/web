/**
 * i18n public surface — re-exports the config shape, the message catalogue and
 * the translator so callers import from one place (`@/lib/i18n`).
 *
 * Everything here is pure and isomorphic (no server-only / no Supabase). The
 * server-only READ of an org's config lives in server/services/org-i18n.ts.
 */

export {
  type OrgI18n,
  defaultOrgI18n,
  normalizeOrgI18n,
  isDefaultOrgI18n,
  isValidLocale,
  isValidTimeZone,
  orgI18nSchema,
  DEFAULT_LOCALE,
  DEFAULT_CURRENCY,
  DEFAULT_COUNTRY,
  DEFAULT_TIMEZONE,
  DEFAULT_TAX_JURISDICTION,
  DEFAULT_PHONE_REGION,
} from "./config";

export {
  type MessageCatalogue,
  enGB,
  CATALOGUES,
  BASE_CATALOGUE,
  BASE_LOCALE,
} from "./catalog";

export {
  type Translator,
  type TranslateParams,
  createTranslator,
  interpolate,
  resolveCatalogues,
} from "./translator";
