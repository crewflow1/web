# CrewFlow Technical SEO Audit & Fixes

_Audit date: 2026-06-16 · Auditor: Head of SEO (autonomous)_

This documents the state of CrewFlow's SEO **before** this work, every issue
found, and exactly what was fixed in code vs. what remains as a manual task
only the founder/ops can do (DNS, Search Console, off-site).

---

## Executive summary

CrewFlow had a well-built product and a single premium landing page, but
**almost no discoverable surface and zero technical SEO infrastructure**. Before
this work there were **3 indexable public pages** (`/`, `/privacy`, `/terms`).
After it there are **55+** (homepage + 6 hubs + 49 leaf pages), all with
structured data, canonicals, dynamic OG images, and a data-driven sitemap.

| Area | Before | After |
|---|---|---|
| Indexable marketing pages | 3 | 55+ |
| `robots.txt` | ❌ none | ✅ generated, app/admin disallowed |
| XML sitemap | ❌ none | ✅ data-driven (58 URLs, auto-updates) |
| Structured data (JSON-LD) | ❌ none | ✅ Org, WebSite, SoftwareApplication, WebPage, Breadcrumb, FAQ, Article |
| Canonical tags | ❌ none | ✅ self-referencing on every page |
| OG/Twitter images | ❌ none | ✅ dynamic per-page (`/api/og`) |
| Favicon / manifest | ❌ none | ✅ `icon.svg` + web manifest |
| Internal linking | ❌ anchor-only | ✅ header + deep footer + contextual |
| `app`/`admin` indexability | ⚠️ inherited `index:true` | ✅ explicit `noindex` + robots Disallow |

---

## Issues found & status

### 1. No `robots.txt` — **FIXED**
There was no robots file at all. Crawlers had no guidance and no sitemap pointer.
**Fix:** `app/robots.ts` — allows the marketing surface, `Disallow`s every
authenticated/transactional path (app modules, `/admin`, `/login`, `/api/`,
customer portal, etc.), declares `Host` and the sitemap URL.

### 2. No XML sitemap — **FIXED**
No way for Google to discover pages efficiently.
**Fix:** `app/sitemap.ts`, fully data-driven from `lib/seo/content`. Every
feature/comparison/industry/location/blog page is included automatically with
sensible `priority` + `changeFrequency`. **Zero manual maintenance** — add a
content entry, it appears in the sitemap.

### 3. No structured data anywhere — **FIXED**
No JSON-LD, so no eligibility for rich results, knowledge panel, or brand SERP
consolidation.
**Fix:** `lib/seo/schema.ts` builders + `components/seo/json-ld.tsx`. Site-wide
`Organization` + `WebSite` + `SoftwareApplication` injected in the root layout;
per-page `WebPage` + `BreadcrumbList`; `FAQPage` on every page with FAQs;
`BlogPosting` on articles. **No fabricated review/rating markup** (policy-safe —
see §11).

### 4. No canonical tags — **FIXED (highest-leverage fix)**
Next.js route groups, trailing slashes and query params spawn duplicate URLs.
With no canonicals, link equity splits and Google guesses.
**Fix:** `buildMetadata()` sets a self-referencing `alternates.canonical` on
every marketing page; homepage canonical added explicitly.

### 5. No OpenGraph / Twitter images — **FIXED**
Shares to LinkedIn/WhatsApp/X rendered with no image — poor CTR, weak brand.
**Fix:** dynamic OG renderer at `app/api/og/route.tsx` (`@vercel/og`). Every page
gets a unique on-brand 1200×630 card from its title, wired through
`buildMetadata()`. Zero per-page asset work.

### 6. No favicon / web manifest — **FIXED**
**Fix:** `app/icon.svg` (brand mark) + `app/manifest.ts`.

### 7. Thin internal linking — **FIXED**
The homepage header/footer linked only to in-page anchors (`#features`) and
`/login`. Nothing linked to (non-existent) deep content.
**Fix:** shared `SiteHeader` (real hub links) + a comprehensive `SiteFooter`
(deep links to features, industries, comparisons, locations, guides), used on
the homepage and every marketing page. See `docs/seo/06-programmatic-and-internal-linking.md`.

### 8. `app` + `admin` could inherit `index:true` — **FIXED**
Root metadata set `robots.index:true`, inherited by all subtrees.
**Fix:** `export const metadata = NOINDEX_METADATA` on `app/(app)/layout.tsx`
and `app/admin/layout.tsx`, plus robots Disallow.

### 9. Weak page titles & metadata coverage — **FIXED**
Only the homepage had real metadata. Every new page now has a keyword-targeted
`<title>` (≤60 chars where possible), a 150–160 char meta description, keywords,
canonical, OG and Twitter — all via the single `buildMetadata()` helper.

### 10. H1 hierarchy — **HEALTHY**
Each page has exactly one `<h1>` (the page hero) and a logical `<h2>`/`<h3>`
structure via the shared section components. No multiple-H1 or skipped-level
issues.

### 11. Review schema — **DELIBERATELY DEFERRED (policy)**
The brief asked for Review schema. Fabricating `aggregateRating`/`Review` markup
without real, on-page reviews violates Google's structured-data policies and
risks a manual action. The **builder exists** (`aggregateRatingSchema`, and
`softwareApplicationSchema({ rating })`) and is wired to render **only when real
review data is supplied**. Turn it on the day you have genuine reviews. See
`docs/seo/05-offsite-pr-backlinks-social.md` for the review-generation plan.

---

## Verified after build

- `pnpm typecheck` → clean.
- Production build → clean; 55 marketing pages prerendered (static/SSG).
- Rendered HTML spot-checks confirm: JSON-LD blocks present, self-canonical
  correct, OG/Twitter image tags present, templated titles correct,
  `robots.txt` + `sitemap.xml` (58 URLs) output correctly.

---

## Remaining — manual tasks (cannot be done in code)

These need the founder / ops, ideally in this order:

1. **Google Search Console** — verify `crewflow.uk` (DNS TXT), submit
   `https://crewflow.uk/sitemap.xml`, set the UK as target country. Same for
   **Bing Webmaster Tools**.
2. **www → apex 301** — confirm `www.crewflow.uk` 301-redirects to
   `https://crewflow.uk` (host/DNS or Vercel domain config). The app only ever
   emits apex URLs; the redirect closes the duplicate-host gap.
3. **HSTS preload / CSP** — already on the punch list in `next.config.ts`;
   not SEO-blocking but good hygiene.
4. **Confirm `/api/og` renders in preview/prod** — it's edge runtime and
   compiles clean; do a quick visual check of one OG image after deploy
   (browser preview was blocked by missing secrets in the build sandbox).
5. **Real screenshots** — drop a 2:1 product screenshot into
   `public/landing/hero-dashboard.webp` (the homepage already supports this
   drop-in) to lift the hero and OG quality.
6. **Analytics** — confirm PostHog/GA events fire on the new pages; add a
   "Book demo" conversion goal.
7. **Off-site** — Search Console aside, the brand-SERP, PR, backlink, GBP and
   social work in the sibling docs is where the next 80% of authority comes from.
