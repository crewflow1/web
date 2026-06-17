import type { MetadataRoute } from "next";
import { abs } from "@/lib/seo/site";
import { marketingSitemapEntries } from "@/lib/seo/content";

/**
 * XML sitemap (generated at /sitemap.xml).
 *
 * Fully data-driven: it reads from the content registry, so every feature,
 * comparison, industry, location and blog post is included automatically the
 * moment it's added to lib/seo/content. No manual sitemap maintenance.
 *
 * Only public, indexable marketing URLs appear here — never the authenticated
 * app, admin or portal routes (those are Disallow'd in robots.ts too).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return marketingSitemapEntries().map((e) => ({
    url: abs(e.path),
    lastModified: e.lastModified ? new Date(e.lastModified) : now,
    changeFrequency: e.changeFrequency,
    priority: e.priority,
  }));
}
