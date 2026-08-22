# CrewFlow logged-in product — performance / structural audit

READ-ONLY audit of the app shell + customer product pages under `app/(app)/**` on
branch `product/ux-rebuild`. Goal: find the **structural** causes of perceived
navigation/page-transition slowness. No code was changed. Correctness / RLS / the
active-org pins are load-bearing and every fix below preserves them (they are all
"do the same reads, fewer times / in parallel / streamed").

Environment facts that frame everything:

- Next.js **15.0.4** (`package.json`), **no `staleTimes` config** in `next.config.ts`
  → Router-cache `staleTimes.dynamic` defaults to **0** (dynamic segments are
  treated as immediately stale on navigation).
- **Zero `React.cache()` usage anywhere** in `app/`, `server/`, `lib/`, `components/`
  (grep confirmed). This is the single highest-impact finding.
- Every `(app)` route is dynamic (reads cookies via `requireOrgContext`), and 66
  pages additionally set `export const dynamic = "force-dynamic"`.
- Route-level `loading.tsx` skeletons exist broadly (54 files, incl. dashboard,
  jobs, jobs/[id]) — so transitions *show a skeleton fast*; the pain is skeleton →
  content latency, which the server-side waterfalls below dominate.

---

## Top root causes (ranked by likely perceived-latency impact)

### 1. Auth/org context is re-resolved many times per navigation — no `React.cache()`  ★★★★★
**Evidence:** `server/auth/session.ts:248` `requireOrgContext()` does
`requireUser()` → `getUser()` → `supabase.auth.getUser()` (**a network round-trip
to GoTrue**, `session.ts:65-71`) **plus** a `memberships` read (`session.ts:121-127`)
**plus** an `organizations` read (`session.ts:141-147`). None of `getUser`,
`getOrgForUser`, `requireOrgContext`, `listOrgsForUser`, `getRequestI18n` is wrapped
in `React.cache()`, so every caller in a single render re-runs the whole chain.

Per **one** job-detail navigation this chain executes roughly:
- middleware `auth.getUser()` — `lib/supabase/middleware.ts:99` (every matched request)
- `(app)/layout.tsx:31` `getRequestI18n()` → `requireOrgContext` (auth + 2 queries)
- `jobs/[id]/layout.tsx:42` `requireOrgContext()` (auth + 2 queries) again
- `jobs/[id]/page.tsx:107` `requireOrgContext()` (auth + 2 queries) again
- **each async job section** re-calls it: `_job-quality.tsx:30`, `_job-delays.tsx:24`,
  `_job-programme.tsx:65`, `_job-checklist.tsx:18`, `_job-documents.tsx:68` — and
  `server/services/job-documents.ts` calls `requireOrgContext()` in **9 places**
  (lines 134, 211, 311, 352, 396, 463, 512, …). Its own comment at
  `job-documents.ts:335` already flags "every call re-ran `requireOrgContext()`
  (auth + a memberships …)".

Net: **~8–10 `auth.getUser()` network calls and ~8 `memberships`+`organizations`
query pairs to render a single page**, purely to answer "who is this / what org".
The layout + page + job-layout ones are on the serial critical path.

**Fix:** wrap the four resolvers in `React.cache()` (request-scoped memoisation) so
the entire auth/org resolution happens **once per request** no matter how many
layouts/pages/sections/services call it:

```ts
// server/auth/session.ts
import { cache } from "react";
export const getUser = cache(async (): Promise<User | null> => { /* … */ });
export const getOrgForUser = cache(async (userId, options) => { /* … */ });
export const requireOrgContext = cache(async () => { /* … */ });
// server/auth/session.ts
export const listOrgsForUser = cache(async (userId) => { /* … */ });
```

`getOrgForUser` takes args, but `cache` keys on args and the args are stable within
a request (`userId`, `currentEmail`), so this is safe. RLS/behaviour is identical —
it just stops repeating the identical read. **Effort: low (a handful of `cache()`
wrappers). Impact: very high** — collapses the dominant per-navigation tax and every
duplicate downstream, everywhere in the app at once.

> Note on scope: `cache()` dedupes *within one server render*. It does not persist
> across navigations, which is correct here (auth must be re-validated per request),
> but it removes the 3–10× multiplication that happens on every single render.

### 2. Job Overview page fans out to ~13 async sections with no Suspense boundaries  ★★★★★
**Evidence:** `jobs/[id]/page.tsx:12-27` imports and renders `JobSafetySection`,
`JobQualitySection`, `JobDelaysSection`, `JobDiarySection`, `JobProgressSection`,
`JobProgrammeSection` (21 KB component), `JobChecklistSection`, `JobSnagsSection`,
`JobMaterialsSection`, `SiteTimelineSection`, `JobDocumentsPanel`, `JobBlueprintsPanel`,
`JobAssetsSection`, plus `PhotoGallery`/`AttachmentsPanel`. Each is an **async
server component that opens its own `createClient()` and fires its own queries**
(e.g. `_job-safety.tsx:50-62` runs 3 queries; `_job-programme.tsx:65-113`;
`_job-assets.tsx:19`), and several re-run `requireOrgContext` (see #1). There are
**no `<Suspense>` boundaries** around them, so React must resolve *every* section
before the page HTML can flush — the page renders at the speed of its **slowest**
section, and the whole thing is gated behind the page body's own waterfall first.

**Fix:** wrap each independent section in `<Suspense fallback={<SectionSkeleton/>}>`
so they stream in independently and the shell/tabs/first content paint immediately;
combine with #1 so the sections stop re-resolving org context. **Effort: medium
(mechanical Suspense wrapping; sections already self-contained). Impact: very high**
for the most-used deep page in the product.

### 3. Dashboard is an ~11-step serial waterfall + a write on every load  ★★★★☆
**Evidence:** `dashboard/page.tsx` awaits in sequence, each step a network round-trip
that only starts after the previous resolves:
- `:135` `getRequestI18n()`
- `:160-234` `Promise.all([...8 reads])`
- `:243-278` `Promise.all([payments, unmatched, allPayments])` (separate await)
- `:301-316` `Promise.all([timeEntries, payableMembers])`
- `:367-386` `Promise.all([retentionJobs, retentionReleases])`
- `:411-420` `Promise.all([activityInsights, leadInsights, onboardingSnapshot, retentionSnapshot])`
- `:426` `await ensureMilestoneNotifications(...)` — **a WRITE side-effect on every
  dashboard render** (notifications + audit-log inserts)
- `:520` `readOrgSettings`, `:521` `gatherVatQuarterInputs`, `:561`
  `getPayrollTaxProfilesForOrg`, `:669` `loadStockCogsCostRows` — four more serial awaits
- then `<DailyBriefing>` (`_daily-briefing.tsx:31` `buildDailyBriefing`) runs *another*
  fetch during render, un-suspended.

Most of these groups are **independent** of each other and are serialised only by
being written as separate `await` statements. That is ~11 sequential DB latencies
stacked before first paint of real content.

**Fixes (in impact order):**
- Hoist the independent groups (`readOrgSettings`, `getPayrollTaxProfilesForOrg`,
  `loadStockCogsCostRows`, time/payroll, retention, insights) into **one top-level
  `Promise.all`** — only the truly dependent ones (VAT inputs need org settings;
  receivables netting needs `allPayments`) stay chained. Cuts ~11 serial hops to ~2–3.
- Move `ensureMilestoneNotifications` off the render path (it is a write; run it in a
  route handler / cron / `after()` — not in the page's critical path).
- Wrap the lower half (profitability tables, charts, activity feed, DailyBriefing) in
  `<Suspense>` so the KPI row paints first and the heavy analytics stream in.
- Consider splitting the giant `page.tsx` into streamed sub-sections.

**Effort: medium. Impact: high** — dashboard is the default landing route.

### 4. Job page body has independent reads serialised as separate awaits  ★★★★☆
**Evidence:** `jobs/[id]/page.tsx`: `:120` `loadJobForOrg` → `:138-193`
`Promise.all([...6])` → `:251` `await time_entries` → `:262` `await loadOrgHourlyPay`
→ `:269` `await loadStockCogsCostRows` → `:286-338` `Promise.all([retention, releases, POs])`
→ `:365` `await invoice_payments`. The time-entries / hourly-pay / stock-COGS /
retention / PO reads are mutually independent and independent of the six-way
`Promise.all`; only `invoice_payments` (`:361` needs `invIds`) truly depends on an
earlier result. As written this is ~8 serial network hops.

**Fix:** collapse the independent reads into the existing `Promise.all` (or one new
one), leaving only the `invoice_payments` read chained after invoice ids resolve.
**Effort: low–medium. Impact: high.**

### 5. The job identity row is fetched twice per open (layout + page)  ★★★☆☆
**Evidence:** `jobs/[id]/layout.tsx:45-60` reads
`jobs(status, site_address_line1, site_city, site_postcode, customers(name))` for the
header; `jobs/[id]/page.tsx:120-129` `loadJobForOrg` reads the same job row again with
a superset of columns (`+ customer address, assigned_to, notes, …`). Two round-trips
for one row on every job open.

**Fix:** either have the layout read the full job once and pass it down via context,
or (simpler, given #1) rely on `React.cache()` around a shared `loadJobForOrg(id, org)`
so the second call is free. **Effort: low. Impact: medium.**

### 6. The shell reads `memberships` twice in one render  ★★★☆☆
**Evidence:** in `(app)/layout.tsx`, `getRequestI18n` → `getOrgForUser`
(`session.ts:121` reads `memberships`) resolves the active org, and then
`listOrgsForUser` (`session.ts:217-222`) reads `memberships` **again** for the org
switcher. Same table, same user, same render.

**Fix:** `React.cache()` (#1) won't merge these because the selects differ; instead
have `listOrgsForUser` reuse the membership rows already fetched, or fetch the org
list from the membership rows `getOrgForUser` already read. **Effort: low. Impact:
low–medium.**

### 7. Middleware `auth.getUser()` on every matched request + `force-dynamic` everywhere  ★★★☆☆
**Evidence:** `lib/supabase/middleware.ts:99` runs `auth.getUser()` (a network
validation call, correctly *not* `getSession`) on every matched request — including
each soft-navigation RSC fetch. Combined with cookie-driven dynamic rendering and 66
`force-dynamic` pages, **no route can be fully prefetched** — `<Link>` prefetch only
reaches the `loading.tsx` boundary, so every click pays a fresh server render.

This one is *mostly inherent* to a per-request-authenticated app and is not a bug.
The `loading.tsx` skeletons already hide it well. The realistic lever is to make the
post-skeleton render fast (#1–#4), not to remove the auth call. Worth noting so it
isn't "fixed" by weakening auth. **Effort: n/a. Impact: context.**

### 8. Post-write flows use full-document navigation (`window.location.assign`)  ★★☆☆☆
**Evidence:** ~75 client files under `(app)` use `window.location.assign` /
`location.href =` / `router.refresh()` (settings forms, `customers/_form.tsx`,
`customers/[id]/_contacts-client.tsx`, etc.). Per the repo's own memory this is the
deliberate workaround for the Next 15 "deep-swap commit race" on form submits. It is
correct for *writes*, but each full-document navigation **discards the client router
cache and re-runs the entire shell from scratch** (middleware + layout + page cold).

**Fix:** none required for correctness; just be aware these paths are heavier than a
soft nav. Where the deep-swap race does not apply (shallow routes), prefer
`router.push`. **Effort: n/a–low. Impact: low (confined to post-write).**

### 9. Shell client bundle: offline components + nav data ship on first paint  ★★☆☆☆
**Evidence:** `(app)/layout.tsx` mounts `OfflineOutbox` (18 KB), `OfflinePhotoOutbox`
(8 KB), `OfflineReadCache` (4 KB), `SwRegister`, `OfflineIdentityMarker`, plus
`SearchPalette` (14 KB), `Sidebar`, `MobileNav`, `OrgSwitcher`, `NotificationsBell`
— all `"use client"`. The nav model (`_nav/nav-model.ts`, 14 KB) and
`_nav/commands.ts` are imported into those client components so they ship to the
browser. `OfflineReadCache` also fires a server action (`fetchOfflineReadSnapshots`)
on mount and every 5 min (`offline-read-cache.tsx:69,108`).

This is a one-time cost per cold load (then cached), not per-nav, so it is lower
priority. If first-load JS matters, `next/dynamic` the three offline components
(they render `null` and only act after mount) to defer them off the critical path.
**Effort: low. Impact: low (first-load only).**

---

## Per-area detail

### A. The app shell (`app/(app)/layout.tsx` + `_components/*`, `_nav/*`)

**What it fetches on every render** (`layout.tsx:31-48`): `getRequestI18n()`
(= `requireOrgContext`: auth.getUser + memberships + organizations + locale
negotiation), `getActiveImpersonation()` (cheap no-op for non-super-admins — returns
`null` before any DB hit at `impersonation.ts:48`), then `Promise.all([listOrgsForUser,
notifications])`. The two parallelised reads are fine; the problem is the **duplicated
resolution chain** (#1) and the **double memberships read** (#6). The notifications
read is correctly active-org + user pinned and `.limit(30)` (`layout.tsx:42-45`).

**Server-first?** Yes — the layout itself is a server component and passes
server-fetched data down as props (`NotificationsBell initial=…`, `OrgSwitcher
orgs=…`). No client component in the shell re-fetches what the server already has:
`notifications.tsx` uses `initial`, `org-switcher.tsx` uses `orgs`,
`search-palette.tsx` only calls `/api/search` on debounced user input
(`search-palette.tsx:180-204`). Good.

**Does the nav tree re-render / block navigation?** `Sidebar` and `MobileNav` are
client components only because they read `usePathname()` and remember expanded state
in `localStorage` (`sidebar.tsx:48,59-78`). They do not block navigation and hold no
server data. Fine.

**Icons:** `_nav/icons.tsx:12-25` uses **named** lucide imports mapped through a
small resolver; grep found **no** `import * as`/barrel lucide imports anywhere. Icons
are tree-shaken. **This is already correct — no change.**

**Does the layout re-run per soft-nav?** In the App Router, shared layouts are
normally preserved across soft navigations (partial rendering), so the shell reads
would run once per full load. But with Next 15 `staleTimes.dynamic = 0` (unset here)
the router biases toward refetching dynamic segments, so per-nav re-execution is
plausible and worth measuring. Either way, the `React.cache()` fix (#1) makes each
render cheap, so the outcome is robust to this uncertainty.

### B. Representative pages

| Page | Verdict | Notes |
|---|---|---|
| `dashboard/page.tsx` | **Needs work** | ~11 serial awaits + a write on render + un-suspended DailyBriefing (see #3). |
| `jobs/page.tsx` | **Good** | `getRequestI18n` → optional customer pre-pass → `Promise.all([list, today])` → optional customer-name lookup. Exact-count pagination, active-org pinned, `id` tiebreak. Search customer pre-pass (`:92-108`) is a justified conditional waterfall. |
| `jobs/[id]/page.tsx` | **Needs work** | Body waterfall (#4) + 13 un-suspended sections (#2) + duplicate identity read (#5). |
| `invoices/page.tsx` | **Good** | One counted, paginated, active-org-pinned query + one conditional customer-name read. Derived-overdue predicate pushed to SQL (`:108-127`). |
| `cash/page.tsx` | **Good** | `requireOrgContext` + `Promise.all([buildOrgCash, buildOrgCashOut])`, both passed `ctx.org.id` (no re-resolve). Role-gated outflow read. |
| `fleet/page.tsx` | **Good** | `requireOrgContext` + single `loadFleetOverview(org)` service call. |
| `stock/page.tsx` | **Good** | `requireOrgContext` + `Promise.all([loadStockPositions, listSitesForOrg])`. |
| `staff/page.tsx` | **Good** | `requireOrgContext` + members read + admin-only pending-invites (legit dependency). Role from `ctx`, not a separate `.single()`. |

Anti-pattern scan results:
- **Serial awaits that could be parallel:** dashboard (#3), job page (#4). List pages
  are already parallelised.
- **Duplicate reads:** job identity (layout + page, #5); shell memberships (#6);
  auth/org everywhere (#1).
- **N+1:** none live in the audited pages — the one historical N+1 (job-document
  versions) was already batched (`_job-documents.tsx:48-52`).
- **Unbounded reads / overfetch:** the dashboard deliberately fetches whole entity
  sets via `fetchAllRows` and aggregates in TS — a conscious launch-horizon choice,
  documented at `dashboard/page.tsx:59-88` and `lib/supabase/paginate.ts:26-31`, with
  the correct next step being DB-side SQL aggregates. Fine for the 200-company target;
  flagged as the eventual scaling lever, not a bug.
- **Unnecessary counts:** the `count:'exact'` on the dashboard `activity_log` read
  (`:229`) and the list pages' pagination counts are all used. No wasted counts.
- **Client components fetching server-available data:** none found.
- **Missing Suspense where a slow query blocks the page:** dashboard analytics (#3),
  job sections (#2). Route-level `loading.tsx` exists (mitigates first paint) but
  intra-page streaming is absent on exactly the two heaviest pages.

Service layer (`server/services/*`) is generally sound: `fleet-snapshot` (4×
`Promise.all`), `org-cash-out` (2×), `stock`, `org-cash`, `briefing` all batch their
internal reads and take `orgId` as an argument (no internal re-resolve). Some internal
serial awaits remain but they are second-order next to #1–#4.

### C. Job workspace (`jobs/[id]/layout.tsx` + tabs)

**Persistent layout — correct.** `layout.tsx` renders the breadcrumb/identity header
+ `JobTabs`, and the tabs (`_job-tabs.tsx:19-28`) point at real sibling routes
(Overview/Commercial/Valuations/Billing/Drawings/Timeline/Certificate/Warranties).
Because they share this layout, switching tabs does a **partial** navigation: the
header + tab bar are preserved and the small job-header query
(`layout.tsx:45-60`) does **not** re-run per tab. Good — the workspace concept is
implemented correctly.

**But two things still tax every tab:**
1. `layout.tsx:42` `requireOrgContext()` and **each tab page's own**
   `requireOrgContext()` both run uncached (#1) — so every tab switch still pays the
   auth/org chain at least twice (middleware + tab page; the layout's own call is
   cached-away only after fix #1).
2. The **Overview tab specifically** is the heavy one (#2/#4/#5). The other tabs
   should be checked for the same fan-out pattern, but Overview is where the
   transition cost concentrates.

Tabs do **not** block on each other (separate routes), so the workspace itself is not
the bottleneck — the Overview page's internal structure is.

### D. Navigation

- **`<Link>` + prefetch:** all navigation uses `next/link`; **no `prefetch={false}`
  anywhere** in `(app)`. Prefetch is enabled. Because routes are dynamic, prefetch
  reaches the `loading.tsx` boundary (skeleton), which is why transitions *feel*
  instant to the skeleton and then wait on the server render.
- **Patterns that defeat soft nav:** the ~75 `window.location.assign` /
  `router.refresh()` sites (#8) are post-write flows (deliberate Next-15 deep-swap
  workaround), not primary navigation. Primary nav (sidebar, tabs, tables, palette)
  uses `<Link>`/`router.push`. No `router.refresh()`-on-mount anti-patterns found in
  the nav path.
- **Net:** navigation *mechanics* are healthy. Perceived slowness is server-render
  latency (skeleton → content), governed by #1–#4, not by the client router.

---

## What is already good (don't churn these)

- **Active-org pinning + LOUD reads** are pervasive and correct — do not "optimise"
  them away; they are the multi-org correctness and money-integrity guarantees.
- **List pages** (jobs, invoices, cash, fleet, stock, staff) are cleanly structured:
  single service call or a single `Promise.all`, exact-count pagination with `id`
  tiebreaks, `orgId` passed into services (no internal re-resolve).
- **Route-level `loading.tsx`** exists for ~54 routes incl. all the big ones — first
  paint is already fast; the work is making content arrive faster behind it.
- **Lucide icons** are tree-shaken (named imports via `_nav/icons.tsx`); no barrel.
- **Root layout** (`app/layout.tsx`) is minimal: `Inter` with `display:"swap"`, no
  global providers, no data fetching.
- **Shell is server-first**: server-fetched data flows to client components as props;
  no redundant client re-fetches; search palette fetches only on debounced input.
- **Service layer** batches internal reads and is parameterised by `orgId`.
- The team is already aware of the `requireOrgContext` repetition
  (`server/services/job-documents.ts:335`) — `React.cache()` is the systemic version
  of the point fixes they've been applying by hand.

## Suggested order of work
1. `React.cache()` the four resolvers in `server/auth/session.ts` (+ shared
   `loadJobForOrg`). One small change, app-wide win (#1, #5, #6, part of #2).
2. `<Suspense>`-wrap the job Overview sections (#2) and the dashboard analytics (#3).
3. Parallelise the dashboard (#3) and job-page (#4) waterfalls; move
   `ensureMilestoneNotifications` off the render path.
4. Measure with the network tab / RSC timings before/after; then decide whether the
   layout re-runs per soft-nav (Next 15 `staleTimes`) needs an explicit
   `staleTimes.dynamic` tune.
