# CrewFlow SEO — Operating Manual

The complete SEO takeover, in one place: what shipped in code, where the strategy
lives, and exactly what to do next. Read this first.

---

## What this is

A founder-level SEO takeover of CrewFlow: a full technical-SEO foundation, a
scalable content engine, **55+ production-ready marketing pages**, and the
off-site strategy to make CrewFlow the dominant UK construction-software brand —
the result people *and* Google reach for first.

All code is built, typechecks clean, and **passes a production build** (55 pages
prerendered, schema/canonicals/sitemap verified in the rendered HTML).

---

## Shipped in code (this branch)

**Technical foundation**
- `app/robots.ts`, `app/sitemap.ts` (data-driven, 58 URLs), `app/manifest.ts`, `app/icon.svg`
- `app/api/og/route.tsx` — dynamic per-page OpenGraph images
- `lib/seo/` — `site.ts` (single source of truth), `metadata.ts` (`buildMetadata`), `schema.ts` (JSON-LD)
- `components/seo/json-ld.tsx`
- Site-wide **Organization + WebSite + SoftwareApplication** schema in the root layout
- `app`/`admin` set to `noindex` (+ robots Disallow)

**Content engine + pages** (`lib/seo/content/*` → `app/(marketing)/*`)
- 13 feature pages, 8 comparison pages, 10 industry pages, 14 location pages, 4 guides
- 5 hub pages + a pricing page
- Shared marketing chrome (`components/marketing/*`) wired into the homepage too
- Every page: SEO title, meta, slug, H1/H2/H3, FAQs+schema, breadcrumbs, internal links, CTA, OG image

**Homepage** now uses the shared header/footer (real internal links), has a
self-canonical, and emits FAQ schema.

---

## The strategy docs

| Doc | Covers (brief phases) |
|---|---|
| [01-technical-audit.md](01-technical-audit.md) | Phase 1 — audit, every fix, remaining manual tasks |
| [02-keyword-research.md](02-keyword-research.md) | Phase 2 — 300+ keywords, grouped by intent, prioritised, mapped |
| [03-content-strategy.md](03-content-strategy.md) | Phases 3–4 — page map, page anatomy, roadmap to target volumes |
| [04-competitor-analysis.md](04-competitor-analysis.md) | Phase 13 — competitor profiles, gaps, opportunities |
| [05-offsite-pr-backlinks-social.md](05-offsite-pr-backlinks-social.md) | Phases 7–11 — brand SERP, PR, 100 backlinks, GBP, social |
| [06-programmatic-and-internal-linking.md](06-programmatic-and-internal-linking.md) | Phases 6, 12 — scalable architecture + linking |

---

## Do this next (prioritised)

### This week — light the fuse (you/ops only; can't be done in code)
1. **Deploy this branch.** Then in **Google Search Console**: verify
   `crewflow.uk`, submit `https://crewflow.uk/sitemap.xml`, set UK targeting.
   Repeat in **Bing Webmaster Tools**.
2. **Confirm `www → apex` 301** (host/Vercel). The app only emits apex URLs.
3. **Claim the social/profile handles** in `05` §"Claim these EXACT handles" —
   exactly as listed so the schema `sameAs` resolves.
4. **Create the Google Business Profile** (`05` Phase 10).
5. **List on Capterra/GetApp/G2/Trustpilot/Crunchbase/Product Hunt** (`05` Tier 1).
6. **Quick check** one `/api/og` image + one live page after deploy.

### 30 days — authority + content
7. **PR launch** — send the press release, pitch NI + construction + SaaS outlets
   (`05` Phase 8).
8. **Backlinks Tier 1–2** — directories + trade associations (`05` Phase 9).
9. **Blog cadence** — 2 substantial guides/week from the `03` calendar.
10. **Reviews** — ask every onboarded customer for Capterra/Google/Trustpilot
    reviews. Once genuine reviews exist, switch on real review schema (the
    builder is ready in `lib/seo/schema.ts`).

### 60–90 days — scale + measure
11. **Expand the engine** (`03` roadmap + `06` guardrails): more comparisons,
    trades, cities, and free-tool pages — in measured batches.
12. **Link Intersect** vs competitors (`04`) → refill the outreach list.
13. **Measure monthly:** impressions/clicks/avg position (GSC), indexed pages,
    referring domains, rankings vs the competitor cohort, demo conversions.

---

## Targets (how we'll know it's working)

- **Brand:** page 1 for "CrewFlow" fully owned (site + socials + directories +
  press) within ~90 days; knowledge panel as the entity graph matures.
- **Comparison/alternative terms:** top 3 for "[competitor] alternative uk"
  within ~2 quarters.
- **SME head terms:** top 10 for the P0 terms (construction software uk,
  construction CRM, construction job/quoting/invoicing/payroll software) within
  ~4 quarters, with the content + links to back it.
- **Home market:** top 3 for "construction software Belfast / Northern Ireland"
  quickly (low competition, high relevance).

---

## Guardrails (the rules that keep this premium, not spammy)

- Quality bar over page count — every page has unique, product-true substance or
  it gets merged (`03`).
- No fabricated stats, testimonials or review schema — ever (`01` §11).
- Comparison pages stay honest, incl. where competitors win (`04`).
- Consistent NAP + logo + handles everywhere (`05`).
- Scale content in measured batches and watch Search Console for thinness (`06`).

---

## One-line summary for the founder

The on-site SEO machine is **built, tested and ready to deploy**. The next
unlock is **off-site**: Search Console, the profile/directory claims, PR, and
backlinks — all laid out, in priority order, in `05` and this README.
