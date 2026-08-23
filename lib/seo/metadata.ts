/**
 * `buildMetadata()`, the one helper every marketing page uses to produce a
 * complete, consistent Next.js `Metadata` object: self-referencing canonical,
 * OpenGraph, Twitter card, a dynamically-generated OG image, and robots.
 *
 * Canonicals are the single highest-leverage fix for a Next.js app (route
 * groups, trailing slashes and query params otherwise spawn duplicate URLs),
 * so every page MUST go through here rather than hand-rolling `metadata`.
 */

import type { Metadata } from "next";
import { SITE, TWITTER_HANDLE, abs } from "./site";

/** Build the dynamic OG image URL for a page. */
export function ogImageUrl(input: { title: string; eyebrow?: string }): string {
  const params = new URLSearchParams({ title: input.title });
  if (input.eyebrow) params.set("eyebrow", input.eyebrow);
  return `/api/og?${params.toString()}`;
}

export type BuildMetadataInput = {
  /** Page title. The root template appends " · CrewFlow" unless `titleAbsolute`. */
  title: string;
  /** Set when the title already contains the brand and shouldn't be templated. */
  titleAbsolute?: boolean;
  description: string;
  /** Canonical path, e.g. "/features/quoting-software". Always apex-relative. */
  path: string;
  keywords?: string[];
  /** OG image overrides. Defaults to the dynamic /api/og render of the title. */
  ogTitle?: string;
  ogEyebrow?: string;
  image?: string;
  type?: "website" | "article";
  /** ISO date, only used for article OG type. */
  publishedTime?: string;
  modifiedTime?: string;
  noindex?: boolean;
};

export function buildMetadata(input: BuildMetadataInput): Metadata {
  const canonical = abs(input.path);
  const ogTitle = input.ogTitle ?? input.title;
  const image =
    input.image ?? ogImageUrl({ title: ogTitle, eyebrow: input.ogEyebrow });

  const ogBase = {
    locale: "en_GB" as const,
    url: canonical,
    siteName: SITE.name,
    title: ogTitle,
    description: input.description,
    images: [{ url: image, width: 1200, height: 630, alt: ogTitle }],
  };
  const openGraph: Metadata["openGraph"] =
    input.type === "article"
      ? {
          ...ogBase,
          type: "article",
          publishedTime: input.publishedTime,
          modifiedTime: input.modifiedTime ?? input.publishedTime,
        }
      : { ...ogBase, type: "website" };

  return {
    title: input.titleAbsolute ? { absolute: input.title } : input.title,
    description: input.description,
    keywords: input.keywords,
    alternates: { canonical },
    openGraph,
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title: ogTitle,
      description: input.description,
      images: [image],
    },
    robots: input.noindex
      ? { index: false, follow: false, googleBot: { index: false, follow: false } }
      : {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
          },
        },
  };
}

/**
 * Drop-in `metadata` for any route tree that must never be indexed
 * (authenticated app, admin, customer portal, auth screens). Defence in
 * depth on top of the auth gate + robots.txt Disallow.
 */
export const NOINDEX_METADATA: Metadata = {
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};
