/**
 * Single source of truth for everything SEO + brand-identity related.
 *
 * Every sitemap entry, canonical URL, JSON-LD block, OpenGraph tag and
 * structured-data emission reads from here so the brand presents one
 * coherent identity to Google. Change a fact once, it propagates.
 *
 * The host is the apex `crewflow.uk` (NOT www) to match `metadataBase`
 * in app/layout.tsx. www → apex is a host-level 301 (documented in
 * docs/seo/00-technical-audit.md); the app only ever emits apex URLs.
 */

export const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk"
).replace(/\/$/, "");

/** Absolute URL builder. `abs("/features")` → `https://crewflow.uk/features`. */
export function abs(path = "/"): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Social / off-site profiles.
 *
 * These are the CANONICAL handles for the brand. Some are not yet claimed
 * — claiming exactly these handles is tracked in docs/seo/09-social-seo.md
 * and docs/seo/06-brand-serp-domination.md. They are emitted in the
 * Organization `sameAs` array (the entity-graph signal Google uses to tie
 * every profile back to one company), so the handles must match what gets
 * registered.
 */
export const SOCIAL = {
  linkedin: "https://www.linkedin.com/company/crewflow-uk",
  x: "https://x.com/crewflowuk",
  instagram: "https://www.instagram.com/crewflow.uk",
  facebook: "https://www.facebook.com/crewflowuk",
  tiktok: "https://www.tiktok.com/@crewflow.uk",
  youtube: "https://www.youtube.com/@crewflowuk",
  github: "https://github.com/crewflow-uk",
  crunchbase: "https://www.crunchbase.com/organization/crewflow",
  producthunt: "https://www.producthunt.com/products/crewflow",
} as const;

export const TWITTER_HANDLE = "@crewflowuk";

export const SITE = {
  name: "CrewFlow",
  /** Used in OG/Twitter `siteName` + JSON-LD. */
  legalName: "CrewFlow",
  url: SITE_URL,
  /** One-liner used as the global default description + Organization.description. */
  tagline: "The operating system for UK construction companies.",
  description:
    "CrewFlow is the all-in-one operating system for UK construction companies. Leads, quotes, jobs, scheduling, staff, timesheets, invoices, payments, profitability, payroll and tax — every part of your construction business in one place.",
  email: "hello@crewflow.uk",
  /** Accurate per the homepage footer — "Built in Belfast, Northern Ireland". */
  location: {
    locality: "Belfast",
    region: "Northern Ireland",
    country: "GB",
  },
  /** Public, on-site pricing (matches the homepage + /pricing). */
  pricing: {
    setupGBP: 1000,
    monthlyGBP: 500,
    currency: "GBP",
  },
  social: SOCIAL,
  twitterHandle: TWITTER_HANDLE,
  /** sameAs = the entity graph. Order roughly by authority/strength. */
  sameAs: [
    SOCIAL.linkedin,
    SOCIAL.x,
    SOCIAL.facebook,
    SOCIAL.instagram,
    SOCIAL.youtube,
    SOCIAL.tiktok,
    SOCIAL.crunchbase,
    SOCIAL.producthunt,
    SOCIAL.github,
  ],
} as const;

export type SiteConfig = typeof SITE;
