/**
 * Content registry — the single place that knows every marketing URL.
 *
 * The sitemap, the header/footer nav and all internal-link resolution read
 * from here, so adding an entry to one of the data files automatically:
 *   - appears in the XML sitemap,
 *   - becomes a valid internal-link target,
 *   - is generated as a static page (via generateStaticParams).
 */

import type { MetadataRoute } from "next";
import { FEATURES, FEATURE_BY_SLUG, getFeature } from "./features";
import { COMPARISONS, COMPARISON_BY_SLUG, getComparison } from "./comparisons";
import { INDUSTRIES, INDUSTRY_BY_SLUG, getIndustry } from "./industries";
import { LOCATIONS, LOCATION_BY_SLUG, getLocation } from "./locations";
import { POSTS, POST_BY_SLUG, getPost } from "./blog";
import { TOOLS, TOOL_BY_SLUG, getTool } from "./tools";

export * from "./types";
export {
  FEATURES,
  FEATURE_BY_SLUG,
  getFeature,
  COMPARISONS,
  COMPARISON_BY_SLUG,
  getComparison,
  INDUSTRIES,
  INDUSTRY_BY_SLUG,
  getIndustry,
  LOCATIONS,
  LOCATION_BY_SLUG,
  getLocation,
  POSTS,
  POST_BY_SLUG,
  getPost,
  TOOLS,
  TOOL_BY_SLUG,
  getTool,
};
export type { ToolPage } from "./tools";

export type LinkItem = { label: string; href: string };

/* -------------------------------------------------------------------------- */
/* Path builders — one source of truth for URL shape                          */
/* -------------------------------------------------------------------------- */

export const paths = {
  features: () => "/features",
  feature: (slug: string) => `/features/${slug}`,
  compare: () => "/compare",
  comparison: (slug: string) => `/compare/${slug}`,
  industries: () => "/industries",
  industry: (slug: string) => `/industries/${slug}`,
  locations: () => "/construction-software",
  location: (slug: string) => `/construction-software/${slug}`,
  pricing: () => "/pricing",
  blog: () => "/blog",
  post: (slug: string) => `/blog/${slug}`,
  tools: () => "/tools",
  tool: (slug: string) => `/tools/${slug}`,
};

/* -------------------------------------------------------------------------- */
/* Internal-link resolvers (defensive: unknown slugs are dropped, not 404'd)  */
/* -------------------------------------------------------------------------- */

export function getFeatureLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => FEATURE_BY_SLUG.get(s))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => ({ label: f.name, href: paths.feature(f.slug) }));
}

export function getComparisonLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => COMPARISON_BY_SLUG.get(s))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ label: `CrewFlow vs ${c.competitor.name}`, href: paths.comparison(c.slug) }));
}

export function getIndustryLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => INDUSTRY_BY_SLUG.get(s))
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .map((i) => ({ label: i.trade, href: paths.industry(i.slug) }));
}

export function getLocationLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => LOCATION_BY_SLUG.get(s))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .map((l) => ({ label: l.location, href: paths.location(l.slug) }));
}

export function getPostLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => POST_BY_SLUG.get(s))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ label: p.title, href: paths.post(p.slug) }));
}

export function getToolLinks(slugs: string[] = []): LinkItem[] {
  return slugs
    .map((s) => TOOL_BY_SLUG.get(s))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ label: t.name, href: paths.tool(t.slug) }));
}

/* -------------------------------------------------------------------------- */
/* Sitemap source                                                             */
/* -------------------------------------------------------------------------- */

type Entry = {
  path: string;
  priority: number;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  lastModified?: string;
};

/** Every indexable marketing route, with priority + change frequency. */
export function marketingSitemapEntries(): Entry[] {
  const entries: Entry[] = [
    { path: "/", priority: 1.0, changeFrequency: "weekly" },
    { path: paths.features(), priority: 0.9, changeFrequency: "weekly" },
    { path: paths.compare(), priority: 0.8, changeFrequency: "weekly" },
    { path: paths.industries(), priority: 0.8, changeFrequency: "weekly" },
    { path: paths.locations(), priority: 0.7, changeFrequency: "weekly" },
    { path: paths.pricing(), priority: 0.9, changeFrequency: "monthly" },
    { path: paths.blog(), priority: 0.7, changeFrequency: "weekly" },
    { path: paths.tools(), priority: 0.7, changeFrequency: "monthly" },
    { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  ];

  for (const f of FEATURES) {
    entries.push({ path: paths.feature(f.slug), priority: 0.8, changeFrequency: "monthly" });
  }
  for (const c of COMPARISONS) {
    entries.push({ path: paths.comparison(c.slug), priority: 0.7, changeFrequency: "monthly" });
  }
  for (const i of INDUSTRIES) {
    entries.push({ path: paths.industry(i.slug), priority: 0.7, changeFrequency: "monthly" });
  }
  for (const l of LOCATIONS) {
    entries.push({ path: paths.location(l.slug), priority: 0.6, changeFrequency: "monthly" });
  }
  for (const p of POSTS) {
    entries.push({
      path: paths.post(p.slug),
      priority: 0.6,
      changeFrequency: "monthly",
      lastModified: p.dateModified ?? p.datePublished,
    });
  }
  for (const t of TOOLS) {
    entries.push({ path: paths.tool(t.slug), priority: 0.6, changeFrequency: "monthly" });
  }

  return entries;
}

/** Counts for dashboards / the strategy docs. */
export const CONTENT_COUNTS = {
  features: FEATURES.length,
  comparisons: COMPARISONS.length,
  industries: INDUSTRIES.length,
  locations: LOCATIONS.length,
  posts: POSTS.length,
  tools: TOOLS.length,
  get total() {
    return (
      this.features + this.comparisons + this.industries + this.locations + this.posts + this.tools
    );
  },
};
