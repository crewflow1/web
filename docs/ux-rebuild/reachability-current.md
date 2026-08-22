# CrewFlow logged-in product — current reachability inventory

> READ-ONLY audit of `app/(app)/` on branch `product/ux-rebuild`. Purpose: a
> capability-level map of how every authorised user-facing feature is reached
> **today**, so the UX rebuild can guarantee nothing gets lost.

## Summary

The logged-in product spans **184 `page.tsx` routes**, grouped here into **109
distinct user-facing capabilities**. Navigation today has three menu surfaces:
the desktop **sidebar** (`hidden md:block` — invisible below 768px), the **mobile
bottom-nav** (5 items for admins, 3 for staff), and the header (org switcher,
Cmd+K search palette, notifications bell, sign-out). Everything else is reached
only by in-page links, redirects, search hits, or raw URL.

- **5 capabilities are orphaned** (no inbound in-app nav link): `/jobs/[id]/valuations`
  (applications for payment), `/staff/[id]/timesheet` (per-person weekly timesheet),
  `/marketplace`, `/qa` (internal QA checklist), and `/a/[token]` (asset QR-scan
  landing). Of these, **valuations and the per-staff timesheet are genuine features
  that fall out of the product entirely** — nothing links to them, not even their
  obvious parents (`/jobs/[id]` and `/staff/[id]`). The other three are intentional:
  marketplace is behind a feature flag (ships dark), `/qa` is an internal owner tool
  ("Not linked from the landing"), and `/a/[token]` is entered by scanning a physical
  QR label.
- **~100 of 109 capabilities have no mobile menu path.** Only the 7 bottom-nav
  destinations (dashboard, leads, jobs, quotes, invoices / my-day, jobs, leave) and
  the header bell (notifications, activity) are reachable from a menu on a phone. All
  other capabilities on mobile depend on deep links or the Cmd+K search palette — and
  the search palette only indexes 12 entity types, so surfaces like diary, toolbox,
  delays, quality, stock, fleet, payroll, CIS and every Settings sub-page have **no
  menu path at all on mobile**. This hits site staff hardest: their sidebar lists
  snags, diary, toolbox, quality, delays, blueprints and site-compliance, but their
  bottom-nav is only My day / Jobs / Leave, so on a phone those daily-use surfaces are
  deep-link-only.

**Role model note.** Almost every page uses `requireOrgContext()` (any org member
can load it) and then gates *actions* behind `isAdmin` (`role === "owner" || "admin"`).
Hard role separation at the page level is rare — the notable exception is `/cash`,
which redirects staff to `/me`. So the "Role" column below reflects **who the surface
is designed for** (inferred from sidebar placement + guards), not a hard access wall;
a staff member can often deep-link into an admin surface and see a read-only or
reduced view.

**Legend — Current entry point:** `sidebar (admin)` = in `ADMIN_LINKS`; `sidebar (staff)`
= in `STAFF_LINKS`; `sidebar (admin+staff)` = both; `bottom-nav` = also in the mobile
bar; `linked from X` = only reachable via an in-page link from X; `ORPHAN` = no inbound
nav link anywhere.
**Legend — Mobile today:** `Yes (bottom-nav)` = in the mobile bar; `Header bell` =
via the notifications dropdown; `No (search)` = no menu, but the entity type is in the
Cmd+K palette; `No (deep-link)` = no menu path and not searchable — deep-link/URL only.

---

## Sales / CRM

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Leads (pipeline) | `/leads` (+ `/new`, `/[id]`) | sidebar (admin) + bottom-nav | owner/admin | Yes (bottom-nav) | No |
| Customers | `/customers` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (search) | No |
| Quotes | `/quotes` (+ `/new`, `/[id]`) | sidebar (admin) + bottom-nav | owner/admin | Yes (bottom-nav) | No |
| Price book | `/price-book` (+ `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Reviews (reputation) | `/reviews` (+ `/new`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Inbox — enquiries | `/inbox` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Inbox — conversations | `/inbox/conversations` (+ `/new`, `/[id]`) | linked from `/inbox` (tab bar) | owner/admin | No (deep-link) | No |
| Inbox — review queue | `/inbox/review` | linked from `/inbox` (tab bar) | owner/admin | No (deep-link) | No |
| Inbox — delivery audit | `/inbox/audit` | linked from `/inbox` (tab bar) | owner/admin | No (deep-link) | No |

## Jobs & delivery

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Jobs list | `/jobs` (+ `/new`) | sidebar (admin+staff) + bottom-nav | all authed | Yes (bottom-nav) | No |
| Job detail | `/jobs/[id]` | linked from jobs list, calendar, search | all authed | No (search) | No |
| Jobs calendar | `/jobs/calendar` | linked from `/jobs` | all authed | No (deep-link) | No |
| Job templates | `/jobs/templates` (+ `/new`, `/[id]`) | linked from `/jobs` | owner/admin | No (deep-link) | No |
| Job billing | `/jobs/[id]/billing` | linked from job detail | owner/admin | No (deep-link) | No |
| Job commercial (margin/cost) | `/jobs/[id]/commercial` | linked from job detail | owner/admin | No (deep-link) | No |
| **Job valuations (applications for payment)** | `/jobs/[id]/valuations` | **ORPHAN** | all authed (admin actions gated) | No (deep-link) | **YES** |
| Job variation — new | `/jobs/[id]/variations/new` | linked from job detail / commercial | owner/admin | No (deep-link) | No |
| Job timeline | `/jobs/[id]/timeline` | linked from job detail | all authed | No (deep-link) | No |
| Job blueprints (drawing viewer) | `/jobs/[id]/blueprints` | linked from job detail + `/blueprints` | all authed | No (deep-link) | No |
| Job completion certificate | `/jobs/[id]/certificate` | linked from job detail | owner/admin | No (deep-link) | No |
| Job warranties | `/jobs/[id]/warranties` | linked from job detail | owner/admin | No (deep-link) | No |
| Snagging | `/snags` (+ `/new`, `/[id]`, `/[id]/edit`) | sidebar (admin+staff) | all authed | No (search) | No |
| Site diary | `/diary` (+ `/new`, `/[id]`, `/[id]/edit`) | sidebar (admin+staff) | all authed | No (deep-link) | No |

## Site & safety

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Health & Safety (RAMS) | `/health-safety` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (search) | No |
| Permits to work | `/health-safety/permits` (+ `/new`, `/[id]`) | linked from `/health-safety` | owner/admin | No (search) | No |
| H&S worker links (RAMS sign-off links) | `/health-safety/worker-links` | linked from `/health-safety` | owner/admin | No (deep-link) | No |
| Toolbox talks | `/toolbox` (+ `/new`, `/[id]`, `/[id]/edit`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Works quality / ITPs | `/quality` (+ `/new`, `/[id]`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Quality — NCRs | `/quality/ncrs` (+ `/new`, `/[id]`) | linked from `/quality` | all authed | No (deep-link) | No |
| Quality — ITP templates | `/quality/templates` (+ `/[id]`) | linked from `/quality` | owner/admin | No (deep-link) | No |
| Delays & EOT | `/delays` (+ `/new`, `/[id]`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Weather (ships dark — no provider) | `/weather` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Site reports | `/site-reports` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (search) | No |
| Blueprints register (org-wide) | `/blueprints` | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Documents (org-wide) | `/documents` | sidebar (admin) | owner/admin | No (search) | No |
| Site compliance (induction / muster) | `/site-compliance` (+ `/[siteId]`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Compliance library (insurance / certs) | `/compliance` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |

## Money

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Cash position (money in/out + net) | `/cash` | sidebar (admin) | owner/admin (staff redirected to `/me`) | No (deep-link) | No |
| Invoices | `/invoices` (+ `/new`, `/[id]`) | sidebar (admin) + bottom-nav | owner/admin | Yes (bottom-nav) | No |
| Payments (bank CSV match + reconcile) | `/payments` (+ `/new`, `/reconcile/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Expenses | `/expenses` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Expense budgets | `/expenses/budgets` | linked from `/expenses` | owner/admin | No (deep-link) | No |
| Finances (ledger / journal) | `/finances` (+ `/new`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| CIS (subcontractor deductions) | `/cis` (+ `/statements/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Tax (MTD / VAT / PAYE) | `/tax` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Reports hub | `/reports` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Report — Profit & loss | `/reports/profit` | linked from `/reports` (registry) | owner/admin | No (deep-link) | No |
| Report — Cashflow forecast | `/reports/cashflow` | linked from `/reports` (registry) | owner/admin | No (deep-link) | No |
| Report — Staff utilisation | `/reports/utilisation` | linked from `/reports` (registry) | owner/admin | No (deep-link) | No |
| Report — Sales pipeline | `/reports/pipeline` | linked from `/reports` (registry) | owner/admin | No (deep-link) | No |
| Report — Debtor ageing | `/reports/ageing` | linked from `/reports` | owner/admin | No (deep-link) | No |
| Report — Retention | `/reports/retention` | linked from `/reports` | owner/admin | No (deep-link) | No |

## People & payroll

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Staff directory | `/staff` | sidebar (admin) | owner/admin | No (search) | No |
| Staff member detail | `/staff/[id]` | linked from `/staff` + search | owner/admin | No (search) | No |
| **Staff timesheet (per-person, weekly)** | `/staff/[id]/timesheet` | **ORPHAN** | staff (own) / admin (any) | No (deep-link) | **YES** |
| Rota | `/staff/rota` | linked from `/staff` | owner/admin | No (deep-link) | No |
| Rota — conflicts | `/staff/rota/conflicts` | linked from `/staff/rota` | owner/admin | No (deep-link) | No |
| Rota — auto-generate | `/staff/rota/generate` | linked from `/staff/rota` | owner/admin | No (deep-link) | No |
| Leave | `/staff/leave` | sidebar (staff) + bottom-nav (staff) | staff (own) / admin (all) | Yes (bottom-nav, staff) | No |
| My day (clock in/out, own timesheet) | `/me` | sidebar (staff) + bottom-nav (staff) | staff | Yes (bottom-nav, staff) | No |
| Payroll | `/payroll` (+ `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |

## Operations / estate

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Operations hub ("what needs me") | `/operations` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Assets register | `/assets` (+ `/new`, `/[id]`, `/[id]/inspections/[inspectionId]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Asset inspections | `/assets/inspections` | linked from `/assets` | owner/admin | No (deep-link) | No |
| Asset holdings (custody) | `/assets/holdings` | linked from `/assets` | owner/admin | No (deep-link) | No |
| Asset calibration | `/assets/calibration` | linked from `/assets` | owner/admin | No (deep-link) | No |
| Asset templates | `/assets/templates` (+ `/new`, `/[id]`) | linked from `/assets` | owner/admin | No (deep-link) | No |
| Asset QR scan — start | `/assets/scan` | linked from `/assets` | all authed | No (deep-link) | No |
| **Asset QR scan — landing** | `/a/[token]` | **ORPHAN** (scan a physical QR label) | all authed | No (deep-link) | **YES** (by design) |
| Fleet | `/fleet` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Fleet vehicles | `/fleet/vehicles` (+ `/new`, `/[id]`, `/[id]/edit`) | linked from `/fleet` | owner/admin | No (deep-link) | No |
| Fleet compliance (MOT/tax/insurance) | `/fleet/compliance` | linked from `/fleet` | owner/admin | No (deep-link) | No |
| Fleet fuel | `/fleet/fuel` | linked from `/fleet` | owner/admin | No (deep-link) | No |
| Stock overview | `/stock` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Stock items | `/stock/items` (+ `/new`, `/[id]`, `/[id]/edit`) | linked from `/stock` | owner/admin | No (deep-link) | No |
| Stock locations | `/stock/locations/[id]` | linked from `/stock`, vans, items | owner/admin | No (deep-link) | No |
| Stocktake | `/stock/stocktake` (+ `/new`, `/[id]`) | linked from `/stock` | owner/admin | No (deep-link) | No |
| Stock replenishment | `/stock/replenishment` | linked from `/stock` | owner/admin | No (deep-link) | No |
| Stock valuation | `/stock/valuation` | linked from `/stock` | owner/admin | No (deep-link) | No |
| Van stock | `/stock/vans` | linked from `/stock` | owner/admin | No (deep-link) | No |
| Material requests | `/materials/requests` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Sites (own depots / yards) | `/sites` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |

## Suppliers / procurement

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Suppliers | `/suppliers` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| Supplier — CIS | `/suppliers/[id]/cis` | linked from supplier detail | owner/admin | No (deep-link) | No |
| Supplier — payments | `/suppliers/[id]/payments` | linked from supplier detail | owner/admin | No (deep-link) | No |
| Supplier — performance | `/suppliers/[id]/performance` | linked from supplier detail | owner/admin | No (deep-link) | No |
| Supplier compare | `/suppliers/compare` | linked from `/suppliers` | owner/admin | No (deep-link) | No |
| Purchase orders | `/purchase-orders` (+ `/new`, `/[id]`) | sidebar (admin) | owner/admin | No (search) | No |
| PO 3-way matching | `/purchase-orders/matching` | linked from `/purchase-orders` | owner/admin | No (deep-link) | No |

## Platform / admin

| Capability | Route | Current entry point | Role | Mobile today | Orphan? |
|---|---|---|---|---|---|
| Dashboard (home / overview) | `/dashboard` | sidebar (admin) + bottom-nav + header logo | owner/admin | Yes (bottom-nav) | No |
| AI Insights | `/insights` | sidebar (admin) | owner/admin | No (deep-link) | No |
| Activity log | `/activity` | linked from notifications bell | all authed | Header bell | No |
| Notifications | `/notifications` | sidebar (admin+staff) + header bell | all authed | Header bell | No |
| Data import / migrate | `/imports` (+ `/[id]`, `/[id]/audit`) | sidebar (admin) | owner/admin | No (deep-link) | No |
| **Marketplace (apps / integrations)** | `/marketplace` | **ORPHAN** (behind `isMarketplaceEnabled()` flag — ships dark) | all authed (admin actions gated) | No (deep-link) | **YES** |
| Help centre | `/help` (+ `/[slug]`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Support tickets | `/support` (+ `/new`, `/[id]`) | sidebar (admin+staff) | all authed | No (deep-link) | No |
| Settings hub | `/settings` | sidebar (admin+staff) | all authed (admin actions gated) | No (deep-link) | No |
| Settings — Billing | `/settings/billing` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Security | `/settings/security` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Integrations | `/settings/integrations` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — API keys | `/settings/api-keys` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Webhooks | `/settings/webhooks` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Automations | `/settings/automations` (+ `/workflow`) | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — AI receptionist | `/settings/ai-receptionist` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Data retention | `/settings/data-retention` | linked from `/settings` | owner/admin | No (deep-link) | No |
| Settings — Marketplace apps | `/settings/marketplace` | linked from `/settings` + `/marketplace` | owner/admin | No (deep-link) | No |
| Onboarding setup wizard | `/onboarding/setup` (+ `/complete`) | linked from `/dashboard` setup checklist | owner/admin | No (deep-link) | No |
| **QA checklist (internal pre-launch)** | `/qa` | **ORPHAN** (internal owner tool — "Not linked from the landing") | owner/admin | No (deep-link) | **YES** (by design) |

---

## ORPHANED CAPABILITIES

Five capabilities have **no inbound in-app navigation link** — they are reachable only
by typing/holding the URL, an external QR scan, or (where noted) not at all through the
UI. Two of these are real, live features silently stranded; three are intentional.

### 1. Job valuations — applications for payment  ⚠️ genuinely stranded
- **Route:** `/jobs/[id]/valuations`
- **Functionality:** The commercial "application for payment" surface for a job —
  create/track interim valuations, valuation lines, retention, and variation links
  (`_valuations.client.tsx`: "Create the first application for payment"). This is a
  core QS/commercial workflow.
- **Why orphan:** Grepping every `href`, `router.push` and `redirect` under
  `app/(app)` finds **zero** links to it — not even from `/jobs/[id]` (which does link
  billing, commercial, timeline, blueprints, certificate, warranties and variations,
  but *not* valuations). Deep-link/URL only.

### 2. Staff timesheet — per-person weekly  ⚠️ genuinely stranded
- **Route:** `/staff/[id]/timesheet`
- **Functionality:** An admin's weekly timesheet view for a specific staff member,
  with week-by-week pagination (`?weekStart=…`); staff can view their own, admins any.
- **Why orphan:** The only links to `/staff/[id]/timesheet` are the page's **own**
  prev/next-week pagination. The staff member's detail page (`/staff/[id]`) does **not**
  link to it, so there is no way to open it from the person you are looking at. Deep-link
  only. (Note: `/me` has a self-service "My timesheet" block, but that is a different,
  self-scoped surface.)

### 3. Marketplace — intentional (dark)
- **Route:** `/marketplace`
- **Functionality:** The apps/integrations marketplace listing (links out to
  `/settings/marketplace` to manage installs).
- **Why orphan:** Guarded by `isMarketplaceEnabled()` — it `notFound()`s when the
  feature flag is off, so it ships dark and is deliberately unlinked. Nothing links in;
  it only links *out* to `/settings/marketplace`.

### 4. QA checklist — intentional (internal)
- **Route:** `/qa`
- **Functionality:** A pre-launch end-to-end QA checklist for owners (self-test steps
  that deep-link into each flow: lead→quote→invoice→paid, staff→rota→payroll, etc.).
- **Why orphan:** By design — its own header says "internal page … Not linked from the
  landing." Internal owner tool, URL only.

### 5. Asset QR-scan landing — intentional (external entry)
- **Route:** `/a/[token]`
- **Functionality:** The QR-scan landing for an asset label — resolves the scanned
  token to an asset (scoped to the scanner's active org) and hands off to the full asset
  detail page.
- **Why orphan:** Entered by scanning a physical QR label (generated via
  `/api/assets/[id]/label/pdf`), not by in-app navigation. No in-app inbound link is
  expected.

---

## Cross-cutting reachability risks for the rebuild

- **Mobile is effectively menu-less beyond 5–7 items.** The sidebar is `hidden md:block`;
  the bottom-nav carries only Dashboard/Leads/Jobs/Quotes/Invoices (admin) or
  My-day/Jobs/Leave (staff). ~100 capabilities have no bottom-nav entry, and the Cmd+K
  palette only indexes 12 entity types (customer, job, quote, invoice, lead, staff, RAMS,
  permit, document, snag, PO, site report) — so diary, toolbox, delays, quality, stock,
  fleet, payroll, CIS, tax, reports, operations and all Settings sub-pages are
  **deep-link-only on a phone**.
- **Staff daily-use surfaces are stranded on mobile.** Staff see snags, diary, toolbox,
  quality, delays, blueprints and site-compliance in their (desktop-only) sidebar, but
  their phone bottom-nav is just My day / Jobs / Leave — the exact site surfaces they need
  most in the field have no mobile menu path.
- **Deep sub-features hang off a single in-page link.** Whole capabilities (expense
  budgets, PO matching, supplier compare, stock valuation/replenishment/vans, rota
  conflicts/generate, asset holdings/calibration/inspections, the six named reports) are
  reachable only through one link on their parent page — easy to drop in a rebuild if the
  parent's layout changes. Treat the "linked from X" column as a dependency list.
