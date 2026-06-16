/**
 * JSON-LD structured-data builders.
 *
 * Each function returns a plain object ready to be JSON.stringify'd into a
 * <script type="application/ld+json"> via <JsonLd> (components/seo/json-ld.tsx).
 *
 * Everything is grounded in real, verifiable facts from lib/seo/site.ts —
 * we deliberately DO NOT emit aggregateRating / Review schema with invented
 * numbers. Fabricated review markup violates Google's structured-data
 * policies and is a real manual-action risk. `aggregateRatingSchema` exists
 * and is wired, but only renders when real, on-page review data is supplied.
 */

import { SITE, abs } from "./site";

/** Loose JSON-LD node. */
export type JsonLd = Record<string, unknown>;

const ORG_ID = `${SITE.url}/#organization`;
const WEBSITE_ID = `${SITE.url}/#website`;
const SOFTWARE_ID = `${SITE.url}/#software`;

/**
 * Organization — the root entity node. Everything else references this via
 * @id so Google builds a single consolidated entity (knowledge panel).
 */
export function organizationSchema(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    logo: {
      "@type": "ImageObject",
      url: abs("/icon.svg"),
      width: 512,
      height: 512,
    },
    image: abs("/opengraph-image"),
    description: SITE.description,
    email: SITE.email,
    slogan: SITE.tagline,
    foundingLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: SITE.location.locality,
        addressRegion: SITE.location.region,
        addressCountry: SITE.location.country,
      },
    },
    areaServed: {
      "@type": "Country",
      name: "United Kingdom",
    },
    knowsAbout: [
      "Construction management software",
      "Construction CRM",
      "Job management software",
      "Construction estimating and quoting",
      "Construction invoicing",
      "Construction payroll",
      "CIS and HMRC compliance",
      "Construction scheduling",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      email: SITE.email,
      contactType: "sales",
      areaServed: "GB",
      availableLanguage: ["en-GB"],
    },
    sameAs: [...SITE.sameAs],
  };
}

/**
 * WebSite node. Ties the domain to the Organization and tells Google the
 * canonical site name to show in the SERP ("CrewFlow", not "crewflow.uk").
 *
 * Note: no SearchAction / Sitelinks Searchbox is emitted because there is no
 * sitewide search endpoint yet — claiming one would be invalid markup. Add it
 * back here the day a real `/search?q=` exists.
 */
export function websiteSchema(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: SITE.url,
    name: SITE.name,
    description: SITE.description,
    inLanguage: "en-GB",
    publisher: { "@id": ORG_ID },
  };
}

/**
 * SoftwareApplication — the product node. Includes the real, public price
 * (£500/mo recurring + £1,000 setup is stated on-site, so it is fair game).
 */
export function softwareApplicationSchema(
  opts: { rating?: AggregateRatingInput } = {},
): JsonLd {
  const node: JsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: SITE.name,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Construction Management Software",
    operatingSystem: "Web, iOS, Android",
    url: SITE.url,
    description: SITE.description,
    publisher: { "@id": ORG_ID },
    featureList: [
      "Lead and enquiry pipeline",
      "Quotes and estimates with VAT",
      "Job management and scheduling",
      "Staff rota and timesheets",
      "Invoicing with automatic reminders",
      "Bank payment reconciliation",
      "Per-job profitability tracking",
      "Payroll (PAYE, NI)",
      "VAT and Corporation Tax",
      "AI receptionist and assistants",
    ],
    offers: {
      "@type": "Offer",
      price: String(SITE.pricing.monthlyGBP),
      priceCurrency: SITE.pricing.currency,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: String(SITE.pricing.monthlyGBP),
        priceCurrency: SITE.pricing.currency,
        unitText: "MONTH",
        referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" },
      },
      category: "Subscription",
      availability: "https://schema.org/InStock",
    },
  };
  // Only attach rating when REAL review data is supplied. Never fabricate.
  if (opts.rating && opts.rating.reviewCount > 0) {
    node.aggregateRating = aggregateRatingSchema(opts.rating);
  }
  return node;
}

export type AggregateRatingInput = {
  ratingValue: number;
  reviewCount: number;
  bestRating?: number;
  worstRating?: number;
};

/** Aggregate rating node — caller must pass genuine, on-page review data. */
export function aggregateRatingSchema(input: AggregateRatingInput): JsonLd {
  return {
    "@type": "AggregateRating",
    ratingValue: input.ratingValue,
    reviewCount: input.reviewCount,
    bestRating: input.bestRating ?? 5,
    worstRating: input.worstRating ?? 1,
  };
}

/** FAQPage — eligible for the FAQ rich result. */
export function faqSchema(items: { q: string; a: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
}

/** BreadcrumbList — drives the breadcrumb rich result + URL-path clarity. */
export function breadcrumbSchema(
  crumbs: { name: string; path: string }[],
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: abs(c.path),
    })),
  };
}

/** Article / BlogPosting — for blog posts + guides. */
export function articleSchema(input: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified?: string;
  image?: string;
  authorName?: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.headline,
    description: input.description,
    url: abs(input.path),
    mainEntityOfPage: { "@type": "WebPage", "@id": abs(input.path) },
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    image: input.image ?? abs("/opengraph-image"),
    inLanguage: "en-GB",
    author: { "@type": "Organization", name: input.authorName ?? SITE.name, "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
  };
}

/**
 * WebPage node for a generic landing page, linked back to the Organization
 * + WebSite. Gives each marketing page a typed identity in the graph.
 */
export function webPageSchema(input: {
  name: string;
  description: string;
  path: string;
  breadcrumbs?: { name: string; path: string }[];
}): JsonLd {
  const node: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${abs(input.path)}#webpage`,
    url: abs(input.path),
    name: input.name,
    description: input.description,
    isPartOf: { "@id": WEBSITE_ID },
    about: { "@id": SOFTWARE_ID },
    inLanguage: "en-GB",
  };
  if (input.breadcrumbs && input.breadcrumbs.length > 0) {
    node.breadcrumb = breadcrumbSchema(input.breadcrumbs);
  }
  return node;
}

/**
 * ItemList — used on hub/index pages (e.g. /features, /compare) to describe
 * the set of child pages. Strengthens the topical cluster for Google.
 */
export function itemListSchema(
  items: { name: string; path: string }[],
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      url: abs(it.path),
    })),
  };
}
