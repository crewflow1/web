import type { MetadataRoute } from "next";
import { abs } from "@/lib/seo/site";
import { marketingSitemapEntries } from "@/lib/seo/content";
import { PILLARS } from "@/lib/marketing/pillars";

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
  const registry: MetadataRoute.Sitemap = marketingSitemapEntries().map((e) => ({
    url: abs(e.path),
    lastModified: e.lastModified ? new Date(e.lastModified) : now,
    changeFrequency: e.changeFrequency,
    priority: e.priority,
  }));
  // Redesigned six-pillar product pages (app/(site)/product/*).
  const product: MetadataRoute.Sitemap = [
    { url: abs("/product"), lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    ...PILLARS.map((p) => ({
      url: abs(`/product/${p.slug}`),
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];
  return [...registry, ...product];
}
