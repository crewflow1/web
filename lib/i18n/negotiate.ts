/**
 * LOCALE NEGOTIATION — pure, isomorphic.
 *
 * The single, explicit point where a request's ACTIVE locale is derived from an
 * org's stored i18n config (organizations.locale, surfaced as ctx.org.i18n). Kept
 * pure (no server-only / no Supabase) so it can be unit-tested and shared by the
 * server request helper (server/i18n/request.ts) and any caller that already holds
 * an OrgI18n.
 *
 * The stored value is already normalised at the read boundary (lib/i18n/config
 * normalizeOrgI18n degrades a malformed/absent value to the UK default), so this
 * only has to apply the last-resort en-GB fallback for a genuinely absent config —
 * never a scatter of `?? "en-GB"` across surfaces.
 */

import { DEFAULT_LOCALE, type OrgI18n } from "./config";

/**
 * Resolve the active locale from an org i18n config. Falls back to the base
 * locale (en-GB) when the config — or its locale — is absent.
 */
export function negotiateLocale(orgI18n?: OrgI18n | null): string {
  return orgI18n?.locale || DEFAULT_LOCALE;
}
