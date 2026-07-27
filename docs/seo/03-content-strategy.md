# CrewFlow Content Strategy & Page Map

The strategy to dominate UK construction-software search — what's **built**, the
**roadmap** to the target volumes, and the **non-negotiable quality bar** that
makes it work instead of getting penalised.

---

## The core principle: a content engine, not a content dump

The brief asked for 100+ landing pages, 50 blog posts, 50 comparisons, 50
feature, 50 location, 50 industry pages. The right way to hit those numbers is
**not** to mass-generate thin pages — Google's Helpful Content system
specifically demotes that, and the brief itself says "never create low-quality
AI content."

So this round shipped a **typed content engine** (`lib/seo/content/*`) where each
page is generated from genuinely unique, product-true structured data. The
template is shared; the substance per page is not. That's how HubSpot, Monday and
Stripe scale to thousands of pages without thin content — and it's what lets
CrewFlow scale to the target numbers **safely**.

**Quality bar every page must clear (enforced by the templates):**
1. A unique primary keyword and search intent.
2. ≥ 400–600 words of genuinely page-specific content (not a find-replace).
3. Real, specific substance (a real module behaviour, real competitor
   positioning, a real trade workflow, real local context).
4. Unique FAQs with FAQ schema.
5. Self-canonical, OG image, breadcrumb + WebPage schema.
6. Internal links in and out (no orphans).
7. A clear CTA (Book a demo).

If a proposed page can't clear that bar with **unique** content, it doesn't get
built — it gets merged into a stronger page.

---

## Page anatomy standard (Phase 4)

Every marketing page produced by the engine includes, automatically:

| Element | Source |
|---|---|
| SEO title | `buildMetadata()` (template-suffixed `· CrewFlow`) |
| Meta description (150–160) | content data |
| Slug | content data (`paths.*`) |
| H1 | content data (one per page) |
| H2 / H3 | section components |
| FAQs | content data → `FaqSection` (renders + FAQ schema) |
| Schema | `WebPage` + `Breadcrumb` + page-type + site-wide entity graph |
| Internal links | `RelatedLinks` + shared footer |
| CTA | `CtaSection` / `BookDemoButton` |
| OG image | dynamic `/api/og` |

**This means a new page is data, not a hand-built file** — consistency and SEO
completeness are guaranteed by construction.

---

## What shipped this round (55 pages)

| Category | Built | Pages |
|---|---|---|
| Homepage | 1 | `/` (now schema + internal links wired) |
| Hubs | 5 | `/features`, `/compare`, `/industries`, `/construction-software`, `/blog` |
| Pricing | 1 | `/pricing` |
| **Feature pages** | **13** | CRM, quoting, job management, scheduling, timesheets, payroll, invoicing, payments reconciliation, job costing, expenses, tax, AI receptionist, customer portal |
| **Comparison pages** | **8** | vs Procore, Buildertrend, Jobber, Tradify, Simpro, ServiceM8, Buildxact, Powered Now |
| **Industry pages** | **10** | builders, electricians, plumbers, roofers, joiners, groundworks, plasterers, landscapers, scaffolding, heating engineers |
| **Location pages** | **14** | Belfast, NI, Lisburn, Newry, London, Manchester, Birmingham, Glasgow, Edinburgh, Leeds, Bristol, Cardiff, Newcastle, Sheffield |
| **Blog/guides** | **4** | best construction software UK, how to price a job, get paid faster, CIS explained |

---

## Roadmap to target volumes (the 🔜 backlog)

Each expansion below is **data only** — add an entry to the relevant
`lib/seo/content/*.ts` file and the page, sitemap entry, internal links and OG
image generate themselves. Build in priority order; never sacrifice the quality
bar for the count.

### Feature pages → 50
Beyond the 13 core modules, add **angle/intent variants** that each deserve their
own page (distinct intent, not duplicate):
- `construction-management-software` (category landing), `construction-project-management-software`, `field-service-management`, `subcontractor-management`, `compliance-and-rams`, `document-management`, `snagging-software`, `materials-and-purchase-orders`, `quote-to-cash`, `cash-flow-forecasting`, `construction-reporting-dashboards`, `mobile-app-for-site-teams`, `xero-for-construction` (integration angle), `replace-spreadsheets-construction`, `construction-crm-vs-job-management` (concept), plus deeper sub-feature pages (e.g. `automatic-invoice-reminders`, `bank-csv-reconciliation`, `gps-clock-in`).
> Only build each if it has unique intent + content. Several "features" above are
> better as **comparison or concept** pages — categorise by intent, not by count.

### Comparison pages → 50
- More competitors: Commusoft, Joblogic, Fergus, Fieldwire, Houzz Pro, Knowify, BigChange, Eworks Manager, Re-flow, Gomeddo, Builda Price, Countfire (estimating), HBXL/EstimatorXpress, Sage Construction, QuickBooks for construction, Xero for construction.
- "X alternative UK" variants for each (separate intent from "CrewFlow vs X" — but **canonical one, link the other**, don't duplicate).
- Category round-ups: "best job management software UK", "best construction CRM UK", "best estimating software UK" (listicle/blog form, links to comparisons).

### Industry pages → 50
- Remaining trades: small-builders, main-contractors, property-maintenance, bricklayers, painters-and-decorators, tilers, flooring, kitchen-fitters, bathroom-fitters, drylining, demolition, fit-out, shopfitting, fencing, paving-and-driveways, fascias-and-guttering, damp-proofing, insulation, solar-installers, EV-charger-installers, fire-and-security, drainage, civil-engineering, steel-fabrication, window-and-glazing, loft-conversions, extensions-specialists, new-build-developers, renewables.
> Each needs genuinely trade-specific pain points + workflow. If two trades would
> get near-identical pages, merge them.

### Location pages → 50+ (highest thin-content risk — see guardrails)
- Remaining GB cities: Liverpool, Nottingham, Southampton, Portsmouth, Coventry, Leicester, Derby, Stoke, Hull, Plymouth, Aberdeen, Dundee, Swansea, Wolverhampton, Reading, Milton Keynes, Brighton, Norwich, Exeter, York.
- NI towns (home-market depth): Derry/Londonderry, Bangor, Craigavon, Ballymena, Coleraine, Omagh, Enniskillen, Antrim, Armagh, Dungannon.
- Region pages: Scotland, Wales, North West, West Midlands, Yorkshire, South East, South West, East of England.
> **Guardrail:** each location page must carry genuine, non-fabricated local
> context. Scale these **last** and watch Search Console for soft-404/thin
> signals. See `06-programmatic-and-internal-linking.md`.

### Blog / guides → 50
A pillar-and-cluster content calendar (top-funnel authority + link bait):
- **Pricing & money:** how much to charge, profit margins, cash flow, retention, day rate vs price work, deposits, late payment law.
- **Tax & compliance:** CIS deep-dives (registration, deductions, returns), domestic reverse charge VAT, Making Tax Digital, RAMS, CDM regs.
- **Operations:** managing a site, hiring subbies, snagging, variations, winning tenders, dealing with delays.
- **Tools & buying guides:** best X software UK (one per category — links to comparisons), spreadsheets vs software, app round-ups.
- **Free tools (link magnets):** construction quote template, invoice template, markup calculator, day-rate calculator — interactive pages that earn links.
- Cadence: **2 substantial posts/week**, each ≥ 1,000 words, each linking to 2–3 money pages.

---

## Editorial standards (so it never becomes slop)

- Written from CrewFlow's real product and real UK construction knowledge.
- British English, plain language, owner-on-site voice (matches the homepage).
- No competitor claim we can't defend; comparison pages stay honest (incl. where
  the competitor wins) and carry a `lastReviewed` date.
- No fabricated stats, testimonials or review schema.
- Every page earns its place or gets merged.
