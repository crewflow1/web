# Programmatic SEO Architecture & Internal Linking

Phases 6 (internal linking) and 12 (programmatic SEO). How the engine scales to
thousands of pages **without** thin content, and how every page strengthens every
other page.

---

## Part A — Programmatic SEO architecture (Phase 12)

### The architecture, in this codebase

```
lib/seo/
├─ site.ts                 # one source of truth: brand, URL, socials, NAP
├─ metadata.ts             # buildMetadata() → canonical, OG, Twitter, robots
├─ schema.ts               # JSON-LD builders (Org, Software, FAQ, Breadcrumb…)
└─ content/
   ├─ types.ts             # typed page contracts
   ├─ features.ts          # 13 module pages (data)
   ├─ comparisons.ts       # 8 competitor pages (data)
   ├─ industries.ts        # 10 trade pages (data)
   ├─ locations.ts         # 14 location pages (data)
   ├─ blog.ts              # guides (data)
   └─ index.ts             # registry: powers sitemap + nav + internal links

app/(marketing)/           # thin templates that render the data
├─ features/[slug]/        # generateStaticParams from data
├─ compare/[slug]/
├─ industries/[slug]/
├─ construction-software/[slug]/
└─ blog/[slug]/

components/marketing/       # shared, SEO-complete section components
app/api/og/                 # dynamic OG image per page
app/sitemap.ts              # auto-generated from the registry
app/robots.ts
```

**To add a page you write data, not a file.** Append an entry to the relevant
`content/*.ts` and you automatically get: a statically-generated page, a sitemap
entry, internal links in/out, a unique OG image, full schema, canonical, and a
consistent layout. This is the HubSpot/Monday/Stripe pattern — scale through a
template fed by genuinely unique structured data.

### Why this is NOT a thin-content / doorway-page machine

Programmatic SEO gets penalised when pages are spun (same content, swapped noun).
This engine has guardrails built in:

1. **Unique substance per entity is required by the type.** A `FeaturePage`
   needs real `sections`, `outcomes`, `faqs` — you can't ship one without
   genuine, page-specific content. A `ComparisonPage` needs honest
   `whereCompetitorWins`. An `IndustryPage` needs trade-specific `painPoints`.
2. **Templates render structure, data provides meaning.** Two pages share a
   layout but never share sentences.
3. **Defensive linking.** `getFeatureLinks()` etc. drop unknown slugs, so there
   are never broken/orphaned links.
4. **`dynamicParams = false`.** Unknown slugs return a real 404, not a thin
   soft-404 — Google never sees an empty templated page.
5. **No fabricated data.** No invented stats, reviews or competitor feature
   claims.

### The scaling guardrail (read before mass-adding pages)

When expanding (esp. locations — the highest risk):

- **One page per unique intent.** If two would be near-identical, **merge**.
- **Minimum substance:** ≥ 400–600 words of page-specific content + ≥ 2 unique
  FAQs. If you can't write that truthfully, don't make the page.
- **Local pages need real local context** (construction character of the
  area) — never a find-replace of the city name.
- **Watch Search Console** after each batch: rising "Crawled – currently not
  indexed" or "Discovered – not indexed" = thinness signal → improve or prune.
- **Roll out in batches** (20–30 at a time), measure, then continue.

### Programmatic expansion candidates (safe, high-value)

- **Free tools / calculators** (each a strong, unique page + link magnet):
  markup calculator, day-rate calculator, VAT calculator, quote/invoice
  templates, CIS deduction calculator. These are programmatic *and* genuinely
  useful — the best kind of scale.
- **"[Competitor] alternative UK"** companion pages (distinct intent from
  "CrewFlow vs X"; canonical one, link the other).
- **Trade × city** combos — only the high-value ones (e.g. "electrician software
  Belfast"), and only once both the trade and city pages are strong, to avoid a
  combinatorial thin-content explosion. Gate these hard.

---

## Part B — Internal linking strategy (Phase 6)

Goal: **every page strengthens every other page.** A deliberate hub-and-spoke
structure so authority flows from the homepage to every leaf and back.

### The structure (already implemented)

```
                    Homepage (highest authority)
                          │  header + deep footer
        ┌──────────┬──────┴─────┬───────────┬──────────┐
     /features  /compare   /industries  /construction-  /blog
        │          │            │         software │       │
   feature pages  comparisons  trade pages  location pages  guides
        └─────── contextual cross-links (RelatedLinks) ─────┘
```

**Three linking layers, all live:**

1. **Global (every page):**
   - **Header** → the 5 hubs + pricing (`components/marketing/site-header.tsx`).
   - **Footer** → deep links into features, industries, comparisons, locations,
     guides (`components/marketing/site-footer.tsx`). This is the workhorse — it
     puts every leaf one click from every page and gives crawlers a complete map.
   - The **homepage** now uses this shared chrome, so the most authoritative page
     links straight into the money pages.

2. **Hub → spoke:** each hub (`/features`, `/compare`, …) lists and links all its
   children with `ItemList` schema, concentrating topical relevance.

3. **Contextual (spoke ↔ spoke):** every leaf page's `RelatedLinks` section links
   to related pages **across** silos — feature → related features + relevant
   trades; comparison → other comparisons; industry → its key feature modules +
   sibling trades; location → core features + nearby locations; blog → related
   guides + the features they discuss. This cross-silo linking is what turns a
   set of pages into a **topical authority graph**.

### Rules to keep it healthy

- **No orphans.** Every page is reachable from the footer + a hub + ≥ 1
  contextual link. (The registry guarantees footer/hub coverage; keep
  `related`/`featuredModules` populated on new entries.)
- **Descriptive anchor text.** Links use the page's name/keyword
  (e.g. "Construction job costing", "CrewFlow vs Jobber"), never "click here".
- **Link up and down.** Leaves link to their hub (breadcrumb + secondary CTA);
  hubs link to leaves; leaves cross-link siblings.
- **Money pages get the most internal links.** Features and top comparisons are
  linked from the footer (every page) + their hub + many contextual sections —
  by design they accrue the most internal equity.
- **Prune as you scale.** When you add pages, add them to 2–3 `related` arrays on
  existing pages so new pages inherit equity immediately.

### Anchor-text targets (for new contextual links + guest posts)

Point internal + external links at money pages with their target keyword as
anchor, e.g.: "construction CRM" → `/features/construction-crm`; "construction
job costing software" → `/features/job-costing-software`; "Procore alternative"
→ `/compare/crewflow-vs-procore`; "software for electricians" →
`/industries/electricians`.
