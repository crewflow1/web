import "server-only";

import { requireOrgContext, type OrgContext } from "@/server/auth/session";
import { orgFormatters, type OrgFormatters } from "@/lib/i18n/org-format";
import { type Translator } from "@/lib/i18n/translator";
import { negotiateLocale } from "@/lib/i18n/negotiate";

/**
 * REQUEST-SCOPED i18n NEGOTIATION (server-only).
 *
 * The seam that turns the (previously dead) i18n framework into a live pipeline:
 * it resolves the ACTIVE locale for a request from the current org's stored
 * `locale` and hands back a translator + org-bound formatters pre-wired to it.
 *
 * NEGOTIATION SOURCE: `organizations.locale` (migration 20261210000000), surfaced
 * on the request context as `ctx.org.i18n` (server/auth/session.ts). That value is
 * already normalised — a pre-migration / backfill-miss / malformed row degrades to
 * the UK default at the read boundary — so {@link negotiateLocale} only has to
 * apply the last-resort en-GB fallback for a genuinely absent config.
 *
 * DEFAULT-SAFETY: for a UK org (the default config) the negotiated locale is
 * `en-GB`, so every wired surface renders the exact English literal it replaced —
 * the translator resolves each key from the complete en-GB base catalogue.
 *
 * The pure negotiation function {@link negotiateLocale} lives in lib/i18n so it
 * stays isomorphic + unit-testable; this module owns the server-side resolution.
 */

export { negotiateLocale };

export type RequestI18n = {
  /** The authenticated user (from requireOrgContext). */
  user: Awaited<ReturnType<typeof requireOrgContext>>["user"];
  /** The resolved org context. */
  ctx: OrgContext;
  /** The negotiated active locale (org.locale, else en-GB). */
  locale: string;
  /** Translator bound to the negotiated locale. */
  translator: Translator;
  /** Convenience: translate a key with the negotiated locale. */
  t: Translator["t"];
  /** Org-bound money/date/phone/translation formatters. */
  formatters: OrgFormatters;
};

/**
 * The request i18n entry point for server components. Resolves the active org
 * context (redirecting if unauthenticated/no-org, exactly as requireOrgContext),
 * negotiates the locale from `ctx.org.i18n`, and returns a translator + formatters
 * wired to it. A page that already needs org context should call this INSTEAD of
 * requireOrgContext so the request is resolved once.
 */
export async function getRequestI18n(): Promise<RequestI18n> {
  const { user, ctx } = await requireOrgContext();
  const orgI18n = ctx.org.i18n;
  const locale = negotiateLocale(orgI18n);
  const formatters = orgFormatters(orgI18n);
  return {
    user,
    ctx,
    locale,
    translator: formatters.translator,
    t: formatters.t,
    formatters,
  };
}
