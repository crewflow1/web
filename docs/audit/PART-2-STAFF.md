# PART 2 — Construction Company Staff

Everything an employee / non-owner company user sees and can do. Detail for each page lives in the domain files (`01`–`08`); this part defines the **roles**, the **permission matrix**, the **staff-only surfaces**, and the crucial **nav-hidden vs server-enforced** distinction.

## 2.1 The roles that actually exist

CrewFlow implements exactly **three** company roles (`app/(app)/_nav/nav-model.ts:30`, membership `role` column). There is **no** manager / supervisor / accountant / viewer role.

| Role | Constant | Intended for | Lands on |
|---|---|---|---|
| **owner** | part of `ADMIN_ROLES` | the business owner; full back-office + money + settings | `/dashboard` (Home) |
| **admin** | part of `ADMIN_ROLES` | trusted office staff with the same product surface as owner (billing/security are still owner-sensitive but admin-visible) | `/dashboard` (Home) |
| **staff** | `"staff"` | field operatives / tradespeople working assigned jobs | `/me` ("My day") |

`ADMIN_ROLES = ["owner","admin"]`; `ALL_ROLES = ["owner","admin","staff"]`. Owner and admin see an identical navigation tree; the owner/admin split is enforced only inside a few sensitive actions, not in nav.

## 2.2 What staff see in navigation

Staff get a deliberately narrow sidebar (nav entries gated `ALL_ROLES` or `["staff"]`):

- **My day** (`/me`) — their home (not `/dashboard`).
- **Projects → Jobs** and **Calendar** (`ALL_ROLES`). *Job templates* is admin-only.
- **Site & safety** children that are `ALL_ROLES`: **Toolbox talks, Site diary, Snagging, Works quality, Delays & EOT, Drawings, Site compliance**. (Health & safety/RAMS, Permits, Site reports, Documents, Compliance library, Weather are admin-only in nav.)
- **People → Leave** and **My day** (`ALL_ROLES`/staff). *Staff, Rota, Payroll* are admin-only.
- **Inbox → Notifications** (`ALL_ROLES`). Enquiries/Conversations/Review queue/Delivery audit are admin-only in nav.
- **Help → Help centre, Support** (`ALL_ROLES`).

Staff do **not** see in nav: Sales (Leads/Quotes/Customers/Price book/Reviews), Money (any), Operations (any), admin Site & Safety children, Staff/Rota/Payroll, admin Settings, or anything under HQ.

## 2.3 Staff-only / field surfaces (full detail in `01`, `03`, `05`)

1. **`/me` — "My day"** (`01-owner-home-inbox-mobile.md`): clock in / clock out, today's assigned jobs, timesheet, request leave, personal profile. *Status: IMPLEMENTED, NOT LIVE-VERIFIED.* Note: `clockIn` accepts `gps_lat/gps_lng` but **no UI captures geolocation** (orphan param); clock actions key on `user_id` + a one-open-entry unique index rather than an explicit org pin.
2. **Assigned jobs** (`03-projects-jobs.md`): staff open jobs from `/me` or `/jobs`. **Important:** job-list RLS is **org-wide**, so a staff member can see/open *every* job in the company, not only assigned ones — the "assigned-only" view is a `/me` convenience, not a security boundary. Within a job, the commercial/billing/valuations tabs and profit/margin tiles are **hidden for staff and server-fail-closed** (`requireManagementRole`). Cost *entry* is intentionally open to staff.
3. **Site & field tools** (`04-site-and-safety.md`): toolbox-talk acknowledgement, site diary entries, raising/closing snags, works-quality inspections, viewing drawings with pins/markup, site induction/muster/visitor sign-in. Signatures stored to a private bucket via service-role.
4. **Leave** (`05-people-payroll.md`): staff submit leave requests (emails owners/admins); admins approve/reject (emails the requester). Pay data is **not** visible to staff — `staff_compensation` is self-or-admin RLS, NI is admin-only.
5. **`/worker-portal`** (`01`): a **public, token-authenticated, anonymous** surface for sub-contract workers with no CrewFlow login — isolated by `loadWorkerSession`, writes via service-role with DB triggers re-deriving org/job from the token, rate-limited. *Status: LIVE & WORKING.*
6. **`/offline`** (`01`): deliberately **read-only** cached view — there is **no** offline write/queue (documented limitation, not a bug).

## 2.4 Role-permission matrix (representative; "nav" = appears in sidebar, "server" = enforced server-side)

| Feature / Action | Owner | Admin | Staff | Enforcement |
|---|---|---|---|---|
| Home dashboard `/dashboard` | ✅ | ✅ | ❌ (→`/me`) | nav + page |
| My day `/me` | ✅ | ✅ | ✅ | all-roles |
| Jobs: view/open any job | ✅ | ✅ | ✅ | **RLS org-wide** |
| Jobs: commercial/billing/valuations/profit | ✅ | ✅ | ❌ | **server fail-closed** (`requireManagementRole`) |
| Jobs: log a cost | ✅ | ✅ | ✅ | member-open by design |
| Leads / Quotes / Customers / Price book | ✅ | ✅ | ❌ (nav) | nav + segment `layout` guard |
| **Reviews** (send review request) | ✅ | ✅ | ⚠️ **reachable by URL** | **nav only — no server role gate** |
| Money (invoices/payments/expenses/CIS/tax/reports/cash/insights) | ✅ | ✅ | ❌ | nav + segment `layout`/`requireManagementRole` |
| Log a cost `/finances/new`, `POST /api/finances` | ✅ | ✅ | ✅ | member-open by design |
| Site & safety admin pages (RAMS/permits/documents/compliance/site-reports/weather) | ✅ | ✅ | ⚠️ **reachable by URL** | **nav only — `requireOrgContext`, no role gate** (RLS + per-mutation re-checks defend data) |
| Site & safety field pages (toolbox/diary/snags/quality/delays/site-compliance/drawings) | ✅ | ✅ | ✅ | all-roles |
| Staff admin / Rota / Payroll | ✅ | ✅ | ❌ (hard redirect to `/me`) | nav + **page-gated** |
| Rota generate/conflicts pages | ✅ | ✅ | ⚠️ reachable by URL (read-only) | nav only; `requireOrgContext` |
| See other staff's pay / NI | ❌ (unless owner/admin) | ✅ | ❌ | **DB RLS** (`staff_compensation`, `staff_secrets`) |
| Operations (assets/fleet/stock/suppliers/PO/sites/materials) | ✅ | ✅ | ❌ (nav) | nav only; **most routes `requireOrgContext`** (URL/QR-reachable) |
| Inbox / Conversations / customer comms | ✅ | ✅ | ⚠️ reachable by URL | **nav only — page `requireOrgContext`** (RLS treats `inbound_enquiries` member-readable) |
| Settings (billing/security/SSO/integrations/keys/webhooks/automations) | ✅ | ✅ | ❌ | nav + page |
| Approve leave | ✅ | ✅ | ❌ | server |
| Request leave | ✅ | ✅ | ✅ | all-roles |
| CrewFlow HQ (`/admin/*`) | ❌ | ❌ | ❌ | **env super-admin allowlist** (separate from company roles) |

Legend: ✅ available · ❌ not available · ⚠️ **nav-hidden but not server-role-enforced** (see 2.5).

## 2.5 Critical nuance — nav-hidden ≠ access-controlled

The single most important staff-permission finding of this audit (surfaced independently by five auditors): **many "admin" surfaces are hidden from the staff sidebar but are not role-gated server-side.** They call `requireOrgContext()` (any signed-in org member) rather than `requireManagementRole()`/`requireManagementContext()`. A staff member who types or guesses the URL is **not redirected**.

What actually protects data on those pages:
- **Row-Level Security** on the underlying tables, and
- **per-mutation owner/admin re-checks** on destructive actions.

So the exposure is **read access to data that RLS treats as member-readable**, not the ability to perform admin mutations (those re-check). Confirmed instances:
- Entire **Site & Safety** domain (`/health-safety`, `/permits`, `/site-reports`, `/documents`, `/compliance`, `/weather`) — `04`.
- **`/reviews`** — the only Sales surface with no guard; staff could send review-request emails by URL — `02`.
- **`/inbox*`** customer-comms pages — `01`.
- **`/staff/rota/generate`**, **`/staff/rota/conflicts`** (read-only) — `05`.
- **Most Operations routes** — assets/stock/suppliers/PO sub-pages are `requireOrgContext` and URL/QR-reachable — `07`.
- Two **member-open mutations** that are likely unintended asymmetries: inspection-template publish/archive (`07`) and `recordSupplierBill` (the one finances-posting path in Operations, `07`).

In contrast, the **Money** domain is properly page-gated (segment `layout.tsx` / `requireManagementRole`, `06`), and **Staff/Payroll** hard-redirect non-admins (`05`). This inconsistency is the top systemic item for Part 7; it is a **policy/finding**, not a reproduced breach (RLS still constrains the rows returned).

## 2.6 Desktop vs mobile for staff

The product is a responsive web app (not a separate native app). Staff field use is mobile-web: `/me`, job detail, toolbox/diary/snags/quality, drawings (pdf.js with pins), and site-compliance sign-in all render on phone width. Drawings/blueprints additionally ship a **PWA offline** read shell. The anonymous `/worker-portal` is mobile-first and tokened. There is **no** offline write queue (`/offline` is read-only). No mobile-only control set exists beyond these; mobile is the same components at phone breakpoints.

## 2.7 Staff feature summary

- **Staff-visible nav areas:** ~7 (My day, Jobs/Calendar, 7 site-&-safety field tools, Leave, Notifications, Help).
- **Genuinely staff-scoped pages:** `/me`, `/worker-portal`, `/offline`, plus the all-roles field tools.
- **Working vs partial vs disabled:** field tools and `/me` are IMPLEMENTED (not browser-verified); `/worker-portal`,`/offline` LIVE; no staff-specific placeholder or broken surface found.
- **Significant permission differences:** no Sales/Money/Operations/Settings/HQ in nav; no pay/NI visibility; job money-tabs server-blocked; leave request-only (not approve).
- **Missing / disconnected staff workflows:** no geolocation capture despite `clockIn` accepting coordinates (`01`); no offline write/queue (`01`); staff invites have **no UI** — a new staff member can only be added via the **Imports** flow, not a "add member" button (`08`).
