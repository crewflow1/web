# CrewFlow Product UX Rebuild — Ledger

Decision + execution record for the logged-in product UX/IA rebuild. Branch
`product/ux-rebuild`. **UX/IA only** — no financial/RLS/permission/domain logic
is changed; existing routes and authorities are surfaced and reorganised, never
rebuilt. Local only: **not merged, not deployed.**

Baseline: `origin/main fc8922c4`. Current state at time of writing = Wave 0 +
Wave 1A/1B/1C shell built and locally verified.

---

## Wave 0 — Final Information Architecture

### The eight primary areas (chosen)

`Home · Sales · Projects · Site & safety · People · Money · Operations · Inbox`
plus a demoted **Settings** and **Help** (utility, foot of the nav). HQ/super-admin
stays entirely out of the product nav (separate env-gated surface).

Defined once in `app/(app)/_nav/nav-model.ts` and consumed by the desktop
sidebar, the mobile nav, and the command palette — so the IA cannot drift and
every destination appears in every surface at once (Rule #1 mechanism).

This is the CEO's provisional 7 (`Home·Sales·Projects·People·Money·Operations·Inbox`)
**plus Site & safety promoted to its own area** — see the decision below. It maps
109 capabilities (see `reachability-current.md`) onto 8 areas with balanced
second levels; no area exceeds ~13 children and most sit at 4–8.

### Site & Safety decision — its OWN top-level area (Option B)

Modelled A (inside Projects) vs B (own area) against the CEO's criteria:

| Criterion | A — in Projects | B — own area | Winner |
|---|---|---|---|
| Desktop nav density | Projects bloats to ~15 children | Projects 3, Site&safety 13 — balanced | **B** |
| Mobile navigation | site records buried under commercial job stuff | one tap to a dedicated field home | **B** |
| Frequency of site-worker use | high-freq surfaces 2 levels deep | high-freq surfaces top-level | **B** |
| Legal / H&S importance | RAMS/permits/muster hidden in Projects | a named, unmissable compliance home | **B** |
| Role-based visibility | site/foreman role has no clean home | role maps 1:1 onto "Site & safety" | **B** |
| No. of second-level dests | one overloaded area | two balanced areas | **B** |
| Job-context relationship | — | per-job records still live in the job workspace; this is the cross-job register view (not a duplicate) | neutral |
| Speed to RAMS/diary/toolbox/inductions/muster/snags/quality/NCRs/drawings/sign-off | Projects → wade past jobs/commercial | Menu → Site & safety → done | **B** |

**Decision: B.** Site & Safety is the highest-frequency field-worker domain and a
legal-compliance domain that must be one tap away; it maps cleanly onto the
site/foreman role. Object-centricity is preserved — a specific job's site records
live in that job's Site/Safety/Quality tabs; the top-level area is the horizontal
"across all jobs" register (all open RAMS, every snag due), a different job-to-be-done.

### Job workspace (object-centric) — planned structure

A job becomes a tabbed workspace so a user never has to leave the job to operate
it. Tabs (reusing existing routes/components — nothing rebuilt):
`Overview · Programme · Team · Site · Safety · Commercial · Billing · Documents · Activity`.
Wave 1 delivers the tabbed shell + de-orphans valuations into Commercial; deeper
per-tab consolidation is Wave 3. (Status: in progress this wave.)

---

## Old → New navigation map (the ~44 flat items)

| Old flat sidebar item | New home |
|---|---|
| Dashboard | **Home** |
| Cash position, Invoices, Payments, Expenses, Finances, CIS, Tax, Reports, AI insights | **Money** |
| Leads, Quotes, Customers, Price book, Reviews | **Sales** |
| Jobs (+ calendar, templates) | **Projects** |
| Snagging, Site diary, Toolbox talks, Health & safety, Works quality, Delays & EOT, Weather, Site reports, Drawings, Documents, Site compliance, Compliance | **Site & safety** |
| Staff, Rota, Leave, Payroll, My day | **People** |
| Operations, Assets, Fleet, Stock, Material requests, Sites, Suppliers, Purchase orders | **Operations** |
| Inbox (+ conversations/review/audit), Notifications | **Inbox** (notifications also via header bell) |
| Migrate data | **Settings → Import data** |
| Help, Support | **Help** (utility) |
| Settings | **Settings** (utility) |

Per-job verticals (diary, snags, quality, RAMS, permits, delays, drawings,
documents) appear BOTH as Site & safety cross-job registers AND inside the job
workspace (per-job) — the same routes, surfaced in the right place, not duplicated.

## Rule #1 — nothing gets lost

`reachability-current.md` inventories all 109 capabilities. Every non-intentional
one has a home in the model above. Orphan fixes this wave:
- **`/jobs/[id]/valuations`** — surfaced via the job workspace Commercial tab + a
  command-palette "This job → Valuations" contextual command.
- **`/staff/[id]/timesheet`** — linked from the staff member detail page.
- Intentional orphans left as-is: `/marketplace` (dark flag), `/qa` (internal),
  `/a/[token]` (physical QR scan entry).

---

## Wave 1 — shell (built)

- **1A Desktop sidebar** (`_components/sidebar.tsx`): grouped, hierarchical,
  progressive disclosure (active area's children expand; any area toggles;
  state persisted to `localStorage`), calm (icons at area level only, text
  children, one active treatment), role-aware, utility demoted to the foot.
- **1B Mobile nav** (`_components/mobile-nav.tsx`): role-tuned bottom quick-bar +
  Menu → full-height sheet that opens at the 8 areas and drills into an area's
  destinations with back + current-location context + a Search row. Closes the
  mobile P0 — every authorised destination reachable on a phone.
- **1C Command foundation** (`_nav/commands.ts` + `_components/search-palette.tsx`):
  entity search (unchanged) + navigation ("Go to …") + actions (New job, Create
  quote, New RAMS…) + contextual ("This job …") + recents; keyboard-first; opens
  on Cmd+K, the header pill, or the mobile Search row.
- **1D Design system**: new server-safe shell primitives `PageHeader` +
  `Breadcrumb` in `components/ui` (exported from the barrel), matching the shipped
  h1 idiom; nav built on the existing tokens/idioms. `Tabs` primitive deferred to
  its real consumer (the job workspace) to honour the repo's "no unadopted
  primitive" rule.

## Design-system decisions

- Icons: `lucide-react` (already a dependency), resolved client-side in
  `_nav/icons.tsx` so the nav model stays pure data. Icons at the area level only.
- Emoji removed from the mobile bottom-nav (was a cliché); replaced with the
  consistent line-icon set.
- No gradients / glass / decorative cards / big shadows / decorative motion
  introduced. Active state = subtle slate-100 + weight/colour, never heavy fills.

## Preserved (untouched)

DailyBriefing / attention-first dashboard · existing Cmd+K entity search &
`/api/search` · NotificationsBell · OrgSwitcher · offline-first infra
(SwRegister/OfflineOutbox/ReadCache/PhotoOutbox/IdentityMarker) · role-aware
permissions & all server authorities · every existing route.

## Deferred to Wave 2+

- Consolidating the six "what needs me" overviews into Home.
- Money glossary/rename (Finances→Ledger, Payments→Bank reconciliation) + one
  canonical name for "owed to us".
- Broad `PageHeader`/`Breadcrumb`/`Table`/`Badge`/`Button` adoption across the
  ~184 pages; `Tabs` primitive extraction.
- Deep per-tab job-workspace consolidation; object workspaces for customer /
  employee / asset / supplier.

## Responsive fix (shell)

`<main>` lacked `min-w-0`, so a wide table forced the flex content column wider
than its track and pushed the whole page sideways at 768/320 (a flex `min-width:
auto` trap, pre-existing; the `w-56→w-60` sidebar nudged more pages over the
line). Added `min-w-0` to `<main>` — content now scrolls within its own
container instead of overflowing the page. Overflow re-verified clean at
1440/1280/1024/768/430/390/320.

## Tests / gates (end of Wave 1)

- **Typecheck**: PASS.
- **Lint**: PASS (0 errors; 92 pre-existing warnings, unchanged baseline).
- **Unit** (`vitest run`): PASS — 628 files / 10,852 tests. Includes the new
  `__tests__/nav/reachability.test.ts` (68) and the updated nav-placement tests
  (ui-phases, polish-batch, support, notifications).
- **Security / trust boundaries** (`test:security`): PASS — 306 files / 8,140
  tests (operations-active-org-scoping updated to assert role visibility via the
  model). No boundary weakened.
- **Integration / e2e** (real Postgres / Playwright): to run in CI on the single
  preview push — these exercise server/DB logic this wave does not touch; run
  locally they would mutate the seeded demo org, so they are deferred to CI.
- **Browser QA**: desktop 1440/1280/1024 + mobile 768/430/390/320 — 0 horizontal
  overflow, 0 console errors; deep-link into `/jobs/[id]/valuations` (fresh),
  refresh on `/jobs/[id]/commercial`, and back/forward all correct.
- **Role QA**: owner sees all 8 areas; staff sees My day · Projects · Site &
  safety · People · Settings · Help (no Money/Sales/Operations/Inbox).
- **Reachability**: 109 capabilities; desktop-reachable = all non-intentional;
  mobile-reachable = all non-intentional (P0 closed); orphaned major = 0
  (valuations + timesheet fixed; marketplace/qa/asset-QR intentional).

---

# Milestone 2 — Performance hardening + HQ UX rebuild

## Part A — Performance (measure-first)

**Method:** production build (`next build`+`start`), local, no tunnel. Playwright
harness for client-nav + Cmd+K + mobile; per-render Supabase query counts via the
Kong access log; static audit (`perf-audit.md`).

**Root causes (honest):**
1. The dominant perceived slowness in the CEO's review was the **Cloudflare review
   tunnel itself** — every request (and, with the tunnel Supabase URL, every
   server query) round-tripped through Cloudflare; a job page's ~51 reads × tunnel
   latency = seconds. Local/prod has none of this.
2. Local app is already fast: TTFB ~105-250ms on every route; Cmd+K open 30-43ms;
   mobile menu 25ms (a Playwright actionability artifact showed a false 5s — a DOM
   click proved 25ms). Per-page `goto` timings are dominated by local Docker-
   Supabase variance (a different random subset was "slow" each run) — not a code
   signal.
3. The static audit's predicted "8-10× requireOrgContext per render" does **not**
   occur at runtime: measured **2** `/auth/v1/user` + **4** memberships + **1**
   organizations per job render, identical before/after the cache — `@supabase/ssr`
   already dedupes `getUser`, and the query volume is modest.

**Fixes (safe; no money/RLS/domain logic touched):**
- `experimental.staleTimes.dynamic=30` — soft-nav revisits serve the cached RSC
  (instant) instead of re-rendering. Safe: org switch already `revalidatePath("/",
  "layout")` purges the router cache; writes navigate full-document.
- Job Overview's 13 self-fetching sections wrapped in one `<Suspense>` — shell +
  commercial overview paint before the heavy sections stream (static fallback, so
  the axe settle-gate is never held open).
- Dashboard milestone-notification WRITE moved off the render path via `after()`.
- Job page: 3 independent reads (`time_entries`, hourly pay, stock COGS)
  parallelised.
- `React.cache()` on `getUser`/`requireOrgContext` — request-scoped memoisation;
  correct best-practice and protective, though measured no local delta (see cause 3).
  Kept, honestly reported.

**Consciously NOT done** (risk > measured benefit locally): deep parallelisation of
the dashboard's independent await-groups and the job body waterfall — the money
pages, where a reorder risks a mis-report for a gain the noisy local env can't
verify. Recommended as a separately-reviewed follow-up.

## Part B — HQ IA rebuild

- **Audit** (`hq-audit.md`): 76 routes, flat 46-link emoji nav, 5 rival "home"
  dashboards, 32 AI employees split across boardroom + 14 cockpits.
- **IA (7 areas):** `Home · Decisions · Workforce · Growth · Customers ·
  Governance · Systems` in one `app/admin/_nav/hq-nav-model.ts` (the audit's 6,
  with Operations split into its two named lanes for balance). Every one of the 46
  surfaces keeps a home; cockpits grouped by the domain their work serves.
- **Shell:** client `HqSidebar` (grouped, progressive disclosure, active state,
  live Support/Notifications badges) + grouped mobile drawer. Emoji → calm line
  icons. `HQ_NAV` kept as a flat projection for back-compat tests.
- **Workforce (B4):** AI Boardroom roster grouped by department (Executive /
  Engineering / Growth / Customer / …), not a flat grid. Honesty banner + Fact/
  Insufficient badges preserved.
- **Governance (B6):** kernel (`server/sdk/*`) untouched — only surfaces regrouped.
- HQ tests updated to assert reachability against the model by href (nav genuinely
  moved + relabelled); no test weakened.

**HQ deferred (clearly scoped follow-ups):** a single merged executive Home *page*
(the 5 dashboards are consolidated at the IA/nav level, not yet one page); the
Decision-state unification UI (B5 — grouped at nav level); HQ-context Cmd+K (B7 —
assessed, not built); re-skinning the Boardroom cards from the existing dark/glow
to the operational light system (B8 — the new nav is already operational).

## Tests (milestone 2)
Typecheck PASS · Lint PASS (0 errors) · Unit PASS (628 files / 10,852). HQ suite
1104 green. Integration/e2e/security to run on the single preview-push CI.
