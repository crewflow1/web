/**
 * i18n TRANSLATOR — the lightweight t() layer over the message catalogue.
 *
 * Dependency-free and isomorphic (server + client safe). A translator is created
 * for a locale and exposes `t(key, params?)`:
 *
 *   const t = createTranslator("en-GB");
 *   t("invoices.number", { number: "INV-001" })  // "Invoice INV-001"
 *
 * RESOLUTION ORDER (deterministic, so a partial locale never renders a raw key):
 *   1. the requested locale's catalogue (exact tag, e.g. "fr-FR");
 *   2. the base-language catalogue (e.g. "fr" for "fr-CA") if present;
 *   3. the base (en-GB) catalogue;
 *   4. the key itself (so an unkeyed string is at least legible, never blank).
 *
 * DEFAULT-SAFETY: for en-GB (the default locale) every key resolves in step 1
 * from the complete base catalogue — byte-identical to the English literal it
 * replaces. Non-en locales degrade gracefully key-by-key.
 */

import {
  BASE_CATALOGUE,
  BASE_LOCALE,
  CATALOGUES,
  type MessageCatalogue,
} from "./catalog";

export type TranslateParams = Record<string, string | number>;

export type Translator = {
  /** The locale this translator was built for. */
  readonly locale: string;
  /** Translate a dotted key, interpolating {placeholders}. */
  t: (key: string, params?: TranslateParams) => string;
  /** True when `key` resolves in some catalogue (not just echoed back). */
  has: (key: string) => boolean;
};

/** Interpolate `{name}` placeholders. Unmatched placeholders are left intact. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/**
 * The ordered list of catalogues to consult for `locale`: exact tag, then the
 * base-language subtag, then the base (en-GB) catalogue. Deduplicated, base last.
 */
export function resolveCatalogues(locale: string): MessageCatalogue[] {
  const out: MessageCatalogue[] = [];
  const seen = new Set<string>();
  const push = (tag: string) => {
    const cat = CATALOGUES[tag];
    if (cat && !seen.has(tag)) {
      out.push(cat);
      seen.add(tag);
    }
  };
  push(locale);
  const base = locale.split("-")[0];
  if (base && base !== locale) {
    // Match any registered catalogue whose language subtag equals `base`.
    for (const tag of Object.keys(CATALOGUES)) {
      if (tag.split("-")[0] === base) push(tag);
    }
  }
  if (!seen.has(BASE_LOCALE)) out.push(BASE_CATALOGUE);
  return out;
}

/** Build a translator bound to `locale`. Falls back to en-GB per key. */
export function createTranslator(locale: string): Translator {
  const chain = resolveCatalogues(locale);

  const lookup = (key: string): string | undefined => {
    for (const cat of chain) {
      const v = cat[key];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  return {
    locale,
    has: (key) => lookup(key) !== undefined,
    t: (key, params) => {
      const template = lookup(key);
      // Step 4: echo the key rather than render blank — a missing translation is
      // visible and greppable, never an empty label on a live surface.
      return interpolate(template ?? key, params);
    },
  };
}
